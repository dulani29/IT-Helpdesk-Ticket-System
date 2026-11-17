const express = require("express");
const pool = require("../db");
const { requireRole, isStaff } = require("../auth");
const { slaInfo } = require("../sla");
const { sendCsv } = require("../csv");
const { ticketRef } = require("../mailer");

const router = express.Router();
const OPEN = "('Open','In Progress','Pending')";

/* ---------- dashboard: every role, scoped ---------- */
router.get("/dashboard", async (req, res, next) => {
  try {
    const staff = isStaff(req.user);
    const scope = staff ? "" : "WHERE requester_id = ?";
    const p = staff ? [] : [req.user.id];
    const [tickets] = await pool.query(
      `SELECT id, status, priority, category, created_at, response_due, resolution_due, first_response_at, resolved_at, technician_id FROM tickets ${scope}`, p);

    const out = { total: tickets.length, open: 0, in_progress: 0, resolved: 0, overdue: 0, at_risk: 0, avg_resolution_minutes: null, avg_response_minutes: null, by_priority: {}, by_category: {}, by_status: {} };
    let resSum = 0, resN = 0, respSum = 0, respN = 0;
    for (const t of tickets) {
      out.by_status[t.status] = (out.by_status[t.status] || 0) + 1;
      out.by_priority[t.priority] = (out.by_priority[t.priority] || 0) + 1;
      out.by_category[t.category] = (out.by_category[t.category] || 0) + 1;
      if (t.status === "Open" || t.status === "Pending") out.open++;
      if (t.status === "In Progress") out.in_progress++;
      if (t.status === "Resolved" || t.status === "Closed") out.resolved++;
      const s = slaInfo(t);
      if (s.overdue) out.overdue++;
      if (s.at_risk) out.at_risk++;
      if (t.resolved_at) { resSum += (new Date(t.resolved_at) - new Date(t.created_at)) / 60000; resN++; }
      if (t.first_response_at) { respSum += (new Date(t.first_response_at) - new Date(t.created_at)) / 60000; respN++; }
    }
    if (resN) out.avg_resolution_minutes = Math.round(resSum / resN);
    if (respN) out.avg_response_minutes = Math.round(respSum / respN);

    if (staff) {
      const [perf] = await pool.query(`
        SELECT u.id, u.name, u.tech_level,
          SUM(t.status IN ${OPEN}) AS open_tickets,
          SUM(t.status IN ('Resolved','Closed')) AS resolved_tickets,
          ROUND(AVG(CASE WHEN t.resolved_at IS NOT NULL THEN TIMESTAMPDIFF(MINUTE, t.created_at, t.resolved_at) END)) AS avg_resolution_minutes,
          ROUND(AVG(f.rating), 2) AS avg_rating
        FROM users u
        LEFT JOIN tickets t ON t.technician_id = u.id
        LEFT JOIN feedback f ON f.ticket_id = t.id
        WHERE u.role IN ('technician','admin') AND u.is_active = 1
        GROUP BY u.id, u.name, u.tech_level ORDER BY resolved_tickets DESC, u.name`);
      out.technicians = perf.map(r => ({ ...r, open_tickets: Number(r.open_tickets || 0), resolved_tickets: Number(r.resolved_tickets || 0) }));
      const [[un]] = await pool.query(`SELECT COUNT(*) AS c FROM tickets WHERE technician_id IS NULL AND status IN ${OPEN}`);
      out.unassigned = un.c;
    }
    res.json(out);
  } catch (err) { next(err); }
});

/* ---------- full reports (staff) ---------- */
async function technicianReport() {
  const [rows] = await pool.query(`
    SELECT u.id, u.name, u.tech_level,
      COUNT(t.id) AS assigned_total,
      SUM(t.status IN ${OPEN}) AS open_now,
      SUM(t.status IN ('Resolved','Closed')) AS resolved,
      ROUND(AVG(CASE WHEN t.resolved_at IS NOT NULL THEN TIMESTAMPDIFF(MINUTE, t.created_at, t.resolved_at) END)) AS avg_resolution_minutes,
      ROUND(AVG(CASE WHEN t.first_response_at IS NOT NULL THEN TIMESTAMPDIFF(MINUTE, t.created_at, t.first_response_at) END)) AS avg_response_minutes,
      SUM(t.status IN ${OPEN} AND t.resolution_due < NOW()) AS overdue_now,
      ROUND(AVG(f.rating), 2) AS avg_rating
    FROM users u
    LEFT JOIN tickets t ON t.technician_id = u.id
    LEFT JOIN feedback f ON f.ticket_id = t.id
    WHERE u.role IN ('technician','admin') AND u.is_active = 1
    GROUP BY u.id, u.name, u.tech_level ORDER BY resolved DESC, u.name`);
  return rows.map(r => ({ ...r, open_now: Number(r.open_now || 0), resolved: Number(r.resolved || 0), overdue_now: Number(r.overdue_now || 0) }));
}

router.get("/reports/summary", requireRole("admin", "technician"), async (_req, res, next) => {
  try {
    const [[totals]] = await pool.query(`
      SELECT COUNT(*) AS total,
        SUM(status IN ${OPEN}) AS open_tickets,
        SUM(status IN ('Resolved','Closed')) AS closed_tickets,
        ROUND(AVG(CASE WHEN resolved_at IS NOT NULL THEN TIMESTAMPDIFF(MINUTE, created_at, resolved_at) END)) AS avg_resolution_minutes,
        ROUND(AVG(CASE WHEN first_response_at IS NOT NULL THEN TIMESTAMPDIFF(MINUTE, created_at, first_response_at) END)) AS avg_response_minutes,
        SUM(resolved_at IS NOT NULL AND resolved_at <= resolution_due) AS resolved_in_sla,
        SUM(resolved_at IS NOT NULL) AS resolved_total
      FROM tickets`);
    const [byCategory] = await pool.query("SELECT category, COUNT(*) AS count FROM tickets GROUP BY category ORDER BY count DESC");
    const [byPriority] = await pool.query("SELECT priority, COUNT(*) AS count FROM tickets GROUP BY priority ORDER BY FIELD(priority,'Critical','High','Medium','Low')");
    const [topProblems] = await pool.query(
      "SELECT MIN(title) AS problem, category, COUNT(*) AS count FROM tickets GROUP BY LOWER(TRIM(title)), category ORDER BY count DESC, problem LIMIT 10");
    const [monthly] = await pool.query(`
      SELECT DATE_FORMAT(created_at, '%Y-%m') AS month, COUNT(*) AS created, SUM(status IN ('Resolved','Closed')) AS resolved
      FROM tickets WHERE created_at >= DATE_SUB(NOW(), INTERVAL 6 MONTH) GROUP BY month ORDER BY month`);
    const [[fb]] = await pool.query("SELECT COUNT(*) AS responses, ROUND(AVG(rating), 2) AS avg_rating FROM feedback");
    const resolvedTotal = Number(totals.resolved_total || 0);
    res.json({
      total: totals.total,
      open: Number(totals.open_tickets || 0),
      closed: Number(totals.closed_tickets || 0),
      avg_resolution_minutes: totals.avg_resolution_minutes === null ? null : Number(totals.avg_resolution_minutes),
      avg_response_minutes: totals.avg_response_minutes === null ? null : Number(totals.avg_response_minutes),
      sla_compliance_pct: resolvedTotal ? Math.round(Number(totals.resolved_in_sla) / resolvedTotal * 100) : null,
      byCategory, byPriority, topProblems,
      monthly: monthly.map(m => ({ ...m, resolved: Number(m.resolved) })),
      technicians: await technicianReport(),
      feedback: fb
    });
  } catch (err) { next(err); }
});

/* ---------- date-range report (staff) ---------- */
const ymd = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
router.get("/reports/range", requireRole("admin", "technician"), async (req, res, next) => {
  try {
    const re = /^\d{4}-\d{2}-\d{2}$/;
    const from = String(req.query.from || ""), to = String(req.query.to || "");
    if (!re.test(from) || !re.test(to) || from > to) return res.status(400).json({ error: "Choose a valid date range" });
    const type = ["day", "technician", "category", "priority"].includes(req.query.type) ? req.query.type : "day";
    const start = from + " 00:00:00", end = to + " 23:59:59";
    const [rows] = await pool.query(
      `SELECT t.id, t.status, t.category, t.priority, t.created_at, t.resolved_at, t.resolution_due, u.name AS technician
       FROM tickets t LEFT JOIN users u ON u.id = t.technician_id
       WHERE t.created_at BETWEEN ? AND ? OR t.resolved_at BETWEEN ? AND ?`, [start, end, start, end]);
    const inR = d => d && ymd(new Date(d)) >= from && ymd(new Date(d)) <= to;
    const groups = new Map();
    const bucket = k => { if (!groups.has(k)) groups.set(k, { label: k, created: 0, resolved: 0, still_open: 0, overdue: 0 }); return groups.get(k); };
    if (type === "day") for (let d = new Date(from + "T00:00:00"); ymd(d) <= to; d.setDate(d.getDate() + 1)) bucket(ymd(d));
    for (const t of rows) {
      const key = x => type === "day" ? ymd(new Date(x)) : type === "technician" ? (t.technician || "Unassigned") : type === "category" ? t.category : t.priority;
      if (inR(t.created_at)) {
        const b = bucket(key(t.created_at)); b.created++;
        if (["Open", "In Progress", "Pending"].includes(t.status)) { b.still_open++; if (t.resolution_due && new Date(t.resolution_due) < new Date()) b.overdue++; }
      }
      if (inR(t.resolved_at)) bucket(key(t.resolved_at)).resolved++;
    }
    let list = [...groups.values()];
    if (type === "priority") { const o = ["Critical", "High", "Medium", "Low"]; list.sort((a, b) => o.indexOf(a.label) - o.indexOf(b.label)); }
    else if (type !== "day") list.sort((a, b) => b.created - a.created || a.label.localeCompare(b.label));
    else list.sort((a, b) => a.label.localeCompare(b.label));
    const totals = list.reduce((a, g) => ({ created: a.created + g.created, resolved: a.resolved + g.resolved, still_open: a.still_open + g.still_open, overdue: a.overdue + g.overdue }), { created: 0, resolved: 0, still_open: 0, overdue: 0 });
    res.json({ from, to, type, totals, rows: list });
  } catch (err) { next(err); }
});

/* ---------- CSV export ---------- */
router.get("/reports/export", requireRole("admin", "technician"), async (req, res, next) => {
  try {
    const type = req.query.type || "tickets";
    const stamp = new Date().toISOString().slice(0, 10);
    if (type === "tickets") {
      const [rows] = await pool.query(`
        SELECT t.*, req.name AS requester, tech.name AS technician FROM tickets t
        JOIN users req ON req.id = t.requester_id LEFT JOIN users tech ON tech.id = t.technician_id ORDER BY t.id`);
      const data = rows.map(t => {
        const s = slaInfo(t);
        return { ticket: ticketRef(t.id), title: t.title, requester: t.requester, category: t.category, priority: t.priority, status: t.status,
          technician: t.technician || "", created_at: t.created_at, first_response_at: t.first_response_at, resolved_at: t.resolved_at,
          response_due: t.response_due, resolution_due: t.resolution_due, response_sla: s.response, resolution_sla: s.resolution,
          escalation_level: t.escalation_level,
          resolution_minutes: t.resolved_at ? Math.round((new Date(t.resolved_at) - new Date(t.created_at)) / 60000) : "" };
      });
      return sendCsv(res, `tickets-${stamp}.csv`, Object.keys(data[0] || { ticket: 1 }), data);
    }
    if (type === "technicians") {
      const data = await technicianReport();
      return sendCsv(res, `technician-performance-${stamp}.csv`,
        ["name", "tech_level", "assigned_total", "open_now", "resolved", "overdue_now", "avg_response_minutes", "avg_resolution_minutes", "avg_rating"], data);
    }
    if (type === "assets") {
      const [rows] = await pool.query(`
        SELECT a.asset_tag, a.name, a.type, a.brand, a.model, a.serial_number, a.status, u.name AS assigned_to, a.location, a.purchase_date, a.warranty_expiry
        FROM assets a LEFT JOIN users u ON u.id = a.assigned_to ORDER BY a.asset_tag`);
      return sendCsv(res, `assets-${stamp}.csv`, ["asset_tag", "name", "type", "brand", "model", "serial_number", "status", "assigned_to", "location", "purchase_date", "warranty_expiry"], rows);
    }
    res.status(400).json({ error: "Unknown export type" });
  } catch (err) { next(err); }
});

module.exports = router;
