const pool = require("./db");

// userId = null means "the system did this" (scheduler, auto-escalation).
async function audit({ userId = null, entity, entityId = null, ticketId = null, action, details = null }, conn = pool) {
  try {
    await conn.query(
      "INSERT INTO audit_logs (user_id, entity, entity_id, ticket_id, action, details) VALUES (?, ?, ?, ?, ?, ?)",
      [userId, entity, entityId, ticketId, action, details ? String(details).slice(0, 2000) : null]);
  } catch (err) { console.error("Audit log failed:", err.message); }
}

module.exports = { audit };
