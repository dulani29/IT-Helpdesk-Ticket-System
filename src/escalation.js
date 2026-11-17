const pool = require("./db");
const { audit } = require("./audit");
const { notify } = require("./mailer");
const httpError = require("./httpError");

// Least-loaded senior technician (or admin), excluding whoever currently holds the ticket.
async function pickSenior(excludeId) {
  const [rows] = await pool.query(`
    SELECT u.id, u.name, u.email, COUNT(t.id) AS open_count
    FROM users u
    LEFT JOIN tickets t ON t.technician_id = u.id AND t.status IN ('Open','In Progress','Pending')
    WHERE u.is_active = 1 AND u.id <> ? AND (u.role = 'admin' OR (u.role = 'technician' AND u.tech_level = 2))
    GROUP BY u.id, u.name, u.email
    ORDER BY open_count ASC, u.id ASC LIMIT 1`, [excludeId || 0]);
  return rows[0] || null;
}

// actorId = null means the system escalated it automatically (SLA breach).
async function escalateTicket({ ticketId, actorId = null, reason, targetId = null }) {
  const [rows] = await pool.query("SELECT * FROM tickets WHERE id = ?", [ticketId]);
  const t = rows[0];
  if (!t) throw httpError(404, "Ticket not found");
  if (t.status === "Resolved" || t.status === "Closed") throw httpError(400, "Resolved or closed tickets cannot be escalated");
  if (t.escalation_level >= 2) throw httpError(400, "This ticket is already at the highest escalation level");

  let target;
  if (targetId) {
    const [u] = await pool.query(
      "SELECT id, name, email FROM users WHERE id = ? AND is_active = 1 AND (role = 'admin' OR (role = 'technician' AND tech_level = 2))", [targetId]);
    target = u[0];
    if (!target) throw httpError(400, "Choose a senior technician or an administrator");
  } else {
    target = await pickSenior(t.technician_id);
  }
  if (!target) throw httpError(400, "No senior technician is available. An admin can mark a technician as senior in Users.");

  await pool.query(
    "UPDATE tickets SET technician_id = ?, escalation_level = escalation_level + 1, escalated_at = NOW() WHERE id = ?", [target.id, ticketId]);
  const noteText = `Escalated to level ${t.escalation_level + 1} and assigned to ${target.name}. Reason: ${reason}`;
  await pool.query("INSERT INTO ticket_notes (ticket_id, user_id, note, is_internal) VALUES (?, ?, ?, 1)", [ticketId, actorId, noteText]);
  await audit({ userId: actorId, entity: "ticket", entityId: ticketId, ticketId, action: "escalated", details: noteText });
  notify.escalated(target.email, t, reason);
  return target;
}

module.exports = { escalateTicket, pickSenior };
