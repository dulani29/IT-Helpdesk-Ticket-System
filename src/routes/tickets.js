const express = require("express");
const fs = require("fs");
const path = require("path");
const pool = require("../db");
const { requireRole, isStaff } = require("../auth");
const { audit } = require("../audit");
const { notify } = require("../mailer");
const { computeDeadlines, withSla, slaInfo } = require("../sla");
const { escalateTicket } = require("../escalation");
const httpError = require("../httpError");
const { UPLOAD_DIR, priorities, statuses, categories, TICKET_SELECT, UNREAD_SQL, getTicket, canAccess } = require("../tickets-common");

const router = express.Router();

// Look up a ticket and enforce access. Unknown and forbidden both return 404 so ids cannot be probed.
async function loadAccessible(req) {
  const t = await getTicket(req.params.id);
  if (!t || !canAccess(req.user, t)) throw httpError(404, "Ticket not found");
  return t;
}

async function staffUser(id) {
  const [r] = await pool.query("SELECT id, name, email FROM users WHERE id = ? AND is_active = 1 AND role IN ('technician','admin')", [id]);
  return r[0] || null;
}

/* ---------- list ---------- */
router.get("/", async (req, res, next) => {
  try {
    const { search = "", status = "", priority = "", category = "", assigned = "", sla = "" } = req.query;
    const where = [], params = [];
    if (!isStaff(req.user)) { where.push("t.requester_id = ?"); params.push(req.user.id); }
    if (statuses.includes(status)) { where.push("t.status = ?"); params.push(status); }
    if (priorities.includes(priority)) { where.push("t.priority = ?"); params.push(priority); }
    if (categories.includes(category)) { where.push("t.category = ?"); params.push(category); }
    if (assigned === "me") { where.push("t.technician_id = ?"); params.push(req.user.id); }
    else if (assigned === "unassigned") where.push("t.technician_id IS NULL");
    else if (/^\d+$/.test(assigned)) { where.push("t.technician_id = ?"); params.push(Number(assigned)); }
    if (String(search).trim()) {
      const term = `%${String(search).trim()}%`;
      where.push("(t.title LIKE ? OR req.name LIKE ? OR req.email LIKE ? OR CAST(t.id AS CHAR) LIKE ?)");
      params.push(term, term, term, term);
    }
    const [rows] = await pool.query(`${TICKET_SELECT}
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY (t.status IN ('Resolved','Closed')), FIELD(t.priority,'Critical','High','Medium','Low'), t.resolution_due ASC
      LIMIT 500`, params);
    let tickets = withSla(rows);
    if (sla === "overdue") tickets = tickets.filter(t => t.sla.overdue);
    if (sla === "at_risk") tickets = tickets.filter(t => t.sla.at_risk);
    res.json(tickets);
  } catch (err) { next(err); }
});

/* ---------- unread replies (badge in the navigation) ---------- */
router.get("/unread/count", async (req, res, next) => {
  try {
    const [r] = await pool.query(`SELECT COUNT(*) AS n FROM tickets t WHERE t.requester_id = ? AND ${UNREAD_SQL}`, [req.user.id]);
    res.json({ count: Number(r[0].n) });
  } catch (err) { next(err); }
});

/* ---------- detail ---------- */
router.get("/:id", async (req, res, next) => {
  try {
    const t = await loadAccessible(req);
    const staff = isStaff(req.user);
    // Opening your own ticket marks its replies as seen. We hand back the previous visit time so the page can
    // highlight what was new, and read it before overwriting it.
    let previousViewedAt = null;
    if (t.requester_id === req.user.id) {
      const [prev] = await pool.query("SELECT last_viewed_at FROM ticket_reads WHERE ticket_id = ? AND user_id = ?", [t.id, req.user.id]);
      previousViewedAt = prev[0] ? prev[0].last_viewed_at : null;
      await pool.query("INSERT INTO ticket_reads (ticket_id, user_id, last_viewed_at) VALUES (?, ?, NOW()) ON DUPLICATE KEY UPDATE last_viewed_at = NOW()", [t.id, req.user.id]);
    }
    const [notes] = await pool.query(`
      SELECT n.id, n.note, n.is_internal, n.created_at, COALESCE(u.name, 'System') AS author, u.role AS author_role
      FROM ticket_notes n LEFT JOIN users u ON u.id = n.user_id
      WHERE n.ticket_id = ? ${staff ? "" : "AND n.is_internal = 0"} ORDER BY n.created_at DESC, n.id DESC`, [t.id]);
    const [attachments] = await pool.query(`
      SELECT a.id, a.original_name, a.mime_type, a.size_bytes, a.created_at, u.name AS uploaded_by
      FROM attachments a JOIN users u ON u.id = a.user_id WHERE a.ticket_id = ? ORDER BY a.created_at`, [t.id]);
    const [fb] = await pool.query("SELECT rating, comment, created_at FROM feedback WHERE ticket_id = ?", [t.id]);
    let history = [];
    if (staff) {
      [history] = await pool.query(`
        SELECT l.id, l.action, l.details, l.created_at, COALESCE(u.name, 'System') AS actor
        FROM audit_logs l LEFT JOIN users u ON u.id = l.user_id
        WHERE l.ticket_id = ? ORDER BY l.created_at DESC, l.id DESC`, [t.id]);
    }
    // Sidebar context for staff: the requester's other tickets, and tickets raised for the same device.
    let previous = [], linked = [];
    if (staff) {
      [previous] = await pool.query(
        "SELECT id, title, status FROM tickets WHERE requester_id = ? AND id <> ? ORDER BY created_at DESC, id DESC LIMIT 5", [t.requester_id, t.id]);
      if (t.asset_id) [linked] = await pool.query(
        "SELECT id, title, status FROM tickets WHERE asset_id = ? AND id <> ? ORDER BY created_at DESC, id DESC LIMIT 10", [t.asset_id, t.id]);
    }
    res.json({ ...t, sla: slaInfo(t), notes, attachments, feedback: fb[0] || null, history, previous_tickets: previous, linked_tickets: linked, previous_viewed_at: previousViewedAt });
  } catch (err) { next(err); }
});

/* ---------- create ---------- */
router.post("/", async (req, res, next) => {
  try {
    const b = req.body, staff = isStaff(req.user), errors = [];
    const title = String(b.title || "").trim(), description = String(b.description || "").trim();
    if (!title) errors.push("Title is required"); else if (title.length > 180) errors.push("Title must be 180 characters or fewer");
    if (!description) errors.push("Description is required"); else if (description.length > 10000) errors.push("Description is too long");
    const category = b.category || "Other", priority = b.priority || "Medium";
    if (!categories.includes(category)) errors.push("Invalid category");
    if (!priorities.includes(priority)) errors.push("Invalid priority");
    if (errors.length) return res.status(400).json({ error: errors.join(", ") });

    let requester = { id: req.user.id, name: req.user.name };
    if (staff && b.requester_id) {
      const [u] = await pool.query("SELECT id, name FROM users WHERE id = ? AND is_active = 1", [Number(b.requester_id)]);
      if (!u.length) return res.status(400).json({ error: "Requester does not exist" });
      requester = u[0];
    }
    let technicianId = null;
    if (staff && b.technician_id) {
      if (!(await staffUser(Number(b.technician_id)))) return res.status(400).json({ error: "Selected technician does not exist" });
      technicianId = Number(b.technician_id);
    }
    let assetId = null;
    if (b.asset_id) {
      const [a] = await pool.query("SELECT id, assigned_to FROM assets WHERE id = ?", [Number(b.asset_id)]);
      if (!a.length) return res.status(400).json({ error: "Selected device does not exist" });
      if (!staff && a[0].assigned_to !== req.user.id) return res.status(403).json({ error: "You can only report issues for devices assigned to you" });
      assetId = a[0].id;
    }

    const now = new Date();
    const due = await computeDeadlines(priority, now);
    const [r] = await pool.query(
      `INSERT INTO tickets (title, description, requester_id, category, priority, technician_id, asset_id, response_due, resolution_due, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [title, description, requester.id, category, priority, technicianId, assetId, due.response_due, due.resolution_due, now]);
    const ticket = await getTicket(r.insertId);
    await audit({ userId: req.user.id, entity: "ticket", entityId: ticket.id, ticketId: ticket.id, action: "created", details: `${priority} ${category}: ${title}` });

    // Notify the assigned technician, or every active technician when unassigned.
    if (technicianId) { const tech = await staffUser(technicianId); if (tech) notify.newTicket(tech, ticket, requester.name); }
    else {
      const [techs] = await pool.query("SELECT name, email FROM users WHERE role = 'technician' AND is_active = 1");
      techs.forEach(tech => notify.newTicket(tech, ticket, requester.name));
    }
    // Confirmation to the customer (the person the ticket is raised for).
    notify.created({ name: ticket.requester_name, email: ticket.requester_email }, ticket);
    res.status(201).json({ ...ticket, sla: slaInfo(ticket) });
  } catch (err) { next(err); }
});

/* ---------- update ---------- */
router.patch("/:id", async (req, res, next) => {
  try {
    const t = await loadAccessible(req);
    const b = req.body, staff = isStaff(req.user);
    const updates = {}; // column -> new value

    if (staff) {
      if (b.status !== undefined) { if (!statuses.includes(b.status)) throw httpError(400, "Invalid status"); updates.status = b.status; }
      if (b.priority !== undefined) { if (!priorities.includes(b.priority)) throw httpError(400, "Invalid priority"); updates.priority = b.priority; }
      if (b.category !== undefined) { if (!categories.includes(b.category)) throw httpError(400, "Invalid category"); updates.category = b.category; }
      if (b.title !== undefined) { const v = String(b.title).trim(); if (!v || v.length > 180) throw httpError(400, "Invalid title"); updates.title = v; }
      if (b.description !== undefined) { const v = String(b.description).trim(); if (!v) throw httpError(400, "Invalid description"); updates.description = v; }
      if (b.technician_id !== undefined) {
        if (b.technician_id === null || b.technician_id === "") updates.technician_id = null;
        else { if (!(await staffUser(Number(b.technician_id)))) throw httpError(400, "Selected technician does not exist"); updates.technician_id = Number(b.technician_id); }
      }
      if (b.asset_id !== undefined) {
        if (!b.asset_id) updates.asset_id = null;
        else { const [a] = await pool.query("SELECT id FROM assets WHERE id = ?", [Number(b.asset_id)]); if (!a.length) throw httpError(400, "Device not found"); updates.asset_id = Number(b.asset_id); }
      }
    } else {
      // Employees may only confirm a fix (close) or reopen their own ticket.
      if (Object.keys(b).some(k => k !== "status")) throw httpError(403, "You can only close or reopen your ticket");
      const closing = b.status === "Closed" && t.status === "Resolved";
      const reopening = b.status === "Open" && (t.status === "Resolved" || t.status === "Closed");
      if (!closing && !reopening) throw httpError(400, "That status change is not allowed");
      updates.status = b.status;
    }

    // Drop no-op changes, remember what changed for the audit trail.
    const changed = [];
    for (const [col, val] of Object.entries(updates)) {
      if (String(t[col] ?? "") === String(val ?? "")) delete updates[col]; else changed.push(`${col}: ${t[col] ?? "none"} → ${val ?? "none"}`);
    }
    if (!changed.length) return res.json({ message: "No changes" });

    const sets = Object.keys(updates).map(c => `${c} = ?`), vals = Object.values(updates);
    if (updates.priority) {
      const due = await computeDeadlines(updates.priority, t.created_at);
      sets.push("response_due = ?", "resolution_due = ?", "sla_warning_sent = 0", "sla_breach_sent = 0");
      vals.push(due.response_due, due.resolution_due);
    }
    if (updates.status) {
      if (staff && updates.status !== "Open" && !t.first_response_at) sets.push("first_response_at = NOW()");
      if (updates.status === "Resolved") { if (!t.resolved_at) sets.push("resolved_at = NOW()"); sets.push("closed_at = NULL"); }
      if (updates.status === "Closed") { if (!t.resolved_at) sets.push("resolved_at = NOW()"); sets.push("closed_at = NOW()"); }
      if (updates.status === "Open" || updates.status === "In Progress" || updates.status === "Pending") sets.push("resolved_at = NULL", "closed_at = NULL");
    }
    await pool.query(`UPDATE tickets SET ${sets.join(", ")} WHERE id = ?`, [...vals, t.id]);
    await audit({ userId: req.user.id, entity: "ticket", entityId: t.id, ticketId: t.id, action: "updated", details: changed.join("; ") });

    // Notifications
    const requester = { name: t.requester_name, email: t.requester_email };
    if (req.user.id !== t.requester_id) {
      if (updates.status === "Resolved") notify.resolved(requester, t);
      else notify.updated(requester, t, changed.join("; "));
    } else if (updates.status === "Open" && t.technician_id) {
      const tech = await staffUser(t.technician_id);
      if (tech) notify.updated(tech, t, `reopened by ${req.user.name}`);
    }
    if (updates.technician_id && updates.technician_id !== req.user.id) {
      const tech = await staffUser(updates.technician_id);
      if (tech) notify.assigned(tech, { ...t, ...updates });
    }
    res.json({ message: "Ticket updated successfully" });
  } catch (err) { next(err); }
});

/* ---------- notes ---------- */
router.post("/:id/notes", async (req, res, next) => {
  try {
    const t = await loadAccessible(req);
    const note = String(req.body.note || "").trim();
    if (!note) return res.status(400).json({ error: "Please enter a note" });
    if (note.length > 5000) return res.status(400).json({ error: "Note is too long" });
    const staff = isStaff(req.user);
    const internal = staff && !!req.body.is_internal;
    await pool.query("INSERT INTO ticket_notes (ticket_id, user_id, note, is_internal) VALUES (?, ?, ?, ?)", [t.id, req.user.id, note, internal ? 1 : 0]);
    await audit({ userId: req.user.id, entity: "ticket", entityId: t.id, ticketId: t.id, action: internal ? "internal_note" : "note_added" });
    // A public reply from staff is the "first response" for SLA purposes.
    if (staff && !internal) {
      if (!t.first_response_at) await pool.query("UPDATE tickets SET first_response_at = NOW() WHERE id = ?", [t.id]);
      if (req.user.id !== t.requester_id) notify.reply({ name: t.requester_name, email: t.requester_email }, t, req.user.name, note);
    } else if (!staff && t.technician_id) {
      const tech = await staffUser(t.technician_id);
      if (tech) notify.updated(tech, t, `${req.user.name} added a comment`);
    }
    res.status(201).json({ message: "Note added" });
  } catch (err) { next(err); }
});

/* ---------- escalation (staff) ---------- */
router.post("/:id/escalate", requireRole("admin", "technician"), async (req, res, next) => {
  try {
    const t = await getTicket(req.params.id);
    if (!t) throw httpError(404, "Ticket not found");
    const reason = String(req.body.reason || "").trim();
    if (!reason) throw httpError(400, "Please give a reason for escalating");
    const target = await escalateTicket({
      ticketId: t.id, actorId: req.user.id, reason: reason.slice(0, 500),
      targetId: req.body.technician_id ? Number(req.body.technician_id) : null });
    res.json({ message: `Escalated to ${target.name}` });
  } catch (err) { next(err); }
});

/* ---------- feedback (requester, after resolution) ---------- */
router.post("/:id/feedback", async (req, res, next) => {
  try {
    const t = await loadAccessible(req);
    if (t.requester_id !== req.user.id) throw httpError(403, "Only the person who raised the ticket can rate it");
    if (t.status !== "Resolved" && t.status !== "Closed") throw httpError(400, "You can rate a ticket once it is resolved");
    const rating = Number(req.body.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw httpError(400, "Choose a rating from 1 to 5");
    const comment = String(req.body.comment || "").trim().slice(0, 1000) || null;
    const [dupe] = await pool.query("SELECT id FROM feedback WHERE ticket_id = ?", [t.id]);
    if (dupe.length) throw httpError(409, "You have already rated this ticket");
    await pool.query("INSERT INTO feedback (ticket_id, user_id, rating, comment) VALUES (?, ?, ?, ?)", [t.id, req.user.id, rating, comment]);
    await audit({ userId: req.user.id, entity: "ticket", entityId: t.id, ticketId: t.id, action: "feedback", details: `${rating}/5` });
    res.status(201).json({ message: "Thank you for your feedback" });
  } catch (err) { next(err); }
});

/* ---------- delete (admin) ---------- */
router.delete("/:id", requireRole("admin"), async (req, res, next) => {
  try {
    const t = await getTicket(req.params.id);
    if (!t) throw httpError(404, "Ticket not found");
    const [files] = await pool.query("SELECT stored_name FROM attachments WHERE ticket_id = ?", [t.id]);
    await pool.query("DELETE FROM tickets WHERE id = ?", [t.id]);
    files.forEach(f => fs.unlink(path.join(UPLOAD_DIR, f.stored_name), () => {}));
    await audit({ userId: req.user.id, entity: "ticket", entityId: t.id, action: "deleted", details: `#${t.id} ${t.title}` });
    res.json({ message: "Ticket deleted" });
  } catch (err) { next(err); }
});

module.exports = router;
