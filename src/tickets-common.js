const path = require("path");
const pool = require("./db");
const { isStaff } = require("./auth");

const UPLOAD_DIR = path.join(__dirname, "..", "uploads");
const priorities = ["Low", "Medium", "High", "Critical"];
const statuses = ["Open", "In Progress", "Pending", "Resolved", "Closed"];
const categories = ["Hardware", "Software", "Network", "Account", "Email", "Printing", "Security", "Training", "Other"];

// 1 when staff have posted a public reply since the requester last opened the ticket.
const UNREAD_SQL = `EXISTS (SELECT 1 FROM ticket_notes n WHERE n.ticket_id = t.id AND n.is_internal = 0
    AND n.user_id IS NOT NULL AND n.user_id <> t.requester_id
    AND n.created_at > COALESCE((SELECT r.last_viewed_at FROM ticket_reads r WHERE r.ticket_id = t.id AND r.user_id = t.requester_id), '1970-01-01 00:00:01'))`;

const TICKET_SELECT = `
  SELECT t.*, req.name AS requester_name, req.email AS requester_email,
         tech.name AS technician_name, a.asset_tag, a.name AS asset_name,
         ${UNREAD_SQL} AS unread_reply
  FROM tickets t
  JOIN users req ON req.id = t.requester_id
  LEFT JOIN users tech ON tech.id = t.technician_id
  LEFT JOIN assets a ON a.id = t.asset_id`;

async function getTicket(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) return null;
  const [rows] = await pool.query(`${TICKET_SELECT} WHERE t.id = ?`, [n]);
  return rows[0] || null;
}

// Employees can only touch their own tickets; staff can touch all.
const canAccess = (user, ticket) => isStaff(user) || ticket.requester_id === user.id;

module.exports = { UPLOAD_DIR, priorities, statuses, categories, TICKET_SELECT, UNREAD_SQL, getTicket, canAccess };
