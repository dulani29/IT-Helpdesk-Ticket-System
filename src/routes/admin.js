const express = require("express");
const pool = require("../db");
const { audit } = require("../audit");
const httpError = require("../httpError");
const { priorities } = require("../tickets-common");
const { computeDeadlines } = require("../sla");

const router = express.Router(); // mounted behind requireRole("admin")

const COMPANY_FIELDS = { company_name: 150, tagline: 200, address: 300, phone: 50, email: 150, website: 200, support_hours: 200, registration_no: 80 };
router.put("/company", async (req, res, next) => {
  try {
    const vals = {};
    for (const [k, max] of Object.entries(COMPANY_FIELDS)) {
      const v = String(req.body[k] ?? "").trim();
      if (v.length > max) throw httpError(400, `${k.replace(/_/g, " ")} is too long (max ${max} characters)`);
      vals[k] = v || null;
    }
    if (!vals.company_name) throw httpError(400, "Company name is required");
    if (vals.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(vals.email)) throw httpError(400, "Enter a valid company email");
    if (vals.website && !/^https?:\/\//i.test(vals.website)) throw httpError(400, "Website must start with http:// or https://");
    await pool.query(
      `UPDATE company_settings SET ${Object.keys(vals).map(k => k + " = ?").join(", ")} WHERE id = 1`, Object.values(vals));
    await audit({ userId: req.user.id, entity: "settings", entityId: 1, action: "company_updated" });
    res.json(vals);
  } catch (err) { next(err); }
});

router.get("/sla", async (_req, res, next) => {
  try {
    const [rows] = await pool.query("SELECT priority, response_minutes, resolution_minutes FROM sla_policies ORDER BY FIELD(priority,'Critical','High','Medium','Low')");
    res.json(rows);
  } catch (err) { next(err); }
});

router.put("/sla/:priority", async (req, res, next) => {
  try {
    const { priority } = req.params;
    if (!priorities.includes(priority)) throw httpError(400, "Invalid priority");
    const resp = Number(req.body.response_minutes), reso = Number(req.body.resolution_minutes);
    if (!Number.isInteger(resp) || !Number.isInteger(reso) || resp < 1 || reso < 1 || resp > 525600 || reso > 525600) throw httpError(400, "Enter whole minutes (1 or more)");
    if (resp > reso) throw httpError(400, "Response time cannot be longer than resolution time");
    await pool.query("UPDATE sla_policies SET response_minutes = ?, resolution_minutes = ? WHERE priority = ?", [resp, reso, priority]);
    // Re-apply the new policy to tickets that are still open so deadlines stay consistent.
    const [open] = await pool.query("SELECT id, created_at FROM tickets WHERE priority = ? AND status IN ('Open','In Progress','Pending')", [priority]);
    for (const t of open) {
      const d = await computeDeadlines(priority, t.created_at);
      await pool.query("UPDATE tickets SET response_due = ?, resolution_due = ?, sla_warning_sent = 0, sla_breach_sent = 0 WHERE id = ?", [d.response_due, d.resolution_due, t.id]);
    }
    await audit({ userId: req.user.id, entity: "sla", action: "sla_updated", details: `${priority}: response ${resp}m, resolution ${reso}m (${open.length} open tickets recalculated)` });
    res.json({ message: `SLA updated; ${open.length} open ticket(s) recalculated` });
  } catch (err) { next(err); }
});

router.get("/audit", async (req, res, next) => {
  try {
    const { entity = "", search = "" } = req.query;
    const where = [], params = [];
    if (/^[a-z]{1,30}$/.test(entity)) { where.push("l.entity = ?"); params.push(entity); }
    if (String(search).trim()) { where.push("(l.action LIKE ? OR l.details LIKE ? OR u.name LIKE ?)"); const t = `%${String(search).trim()}%`; params.push(t, t, t); }
    const [rows] = await pool.query(`
      SELECT l.id, l.entity, l.entity_id, l.ticket_id, l.action, l.details, l.created_at, COALESCE(u.name, 'System') AS actor
      FROM audit_logs l LEFT JOIN users u ON u.id = l.user_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY l.id DESC LIMIT 300`, params);
    res.json(rows);
  } catch (err) { next(err); }
});

router.get("/emails", async (_req, res, next) => {
  try {
    const [rows] = await pool.query("SELECT id, to_email, subject, status, error, created_at FROM email_log ORDER BY id DESC LIMIT 100");
    res.json(rows);
  } catch (err) { next(err); }
});

module.exports = router;
