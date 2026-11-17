const pool = require("./db");

async function getPolicy(priority, conn = pool) {
  const [rows] = await conn.query("SELECT response_minutes, resolution_minutes FROM sla_policies WHERE priority = ?", [priority]);
  return rows[0] || { response_minutes: 240, resolution_minutes: 1440 };
}

// Deadlines are counted from the moment the ticket was created.
async function computeDeadlines(priority, createdAt, conn = pool) {
  const p = await getPolicy(priority, conn);
  const base = new Date(createdAt).getTime();
  return { response_due: new Date(base + p.response_minutes * 60000), resolution_due: new Date(base + p.resolution_minutes * 60000) };
}

const WARN_FRACTION = 0.25; // "approaching" = last 25% of the resolution window

// Returns a ready-to-display SLA summary for a ticket row.
function slaInfo(t, now = new Date()) {
  const closedLike = t.status === "Resolved" || t.status === "Closed";
  const created = new Date(t.created_at).getTime();
  const rDue = new Date(t.response_due).getTime();
  const sDue = new Date(t.resolution_due).getTime();
  const nowMs = now.getTime();

  let response;
  if (t.first_response_at) response = new Date(t.first_response_at).getTime() <= rDue ? "met" : "breached";
  else if (closedLike) response = "breached";
  else response = nowMs > rDue ? "breached" : (rDue - nowMs) < (rDue - created) * WARN_FRACTION ? "at_risk" : "ok";

  let resolution;
  if (t.resolved_at) resolution = new Date(t.resolved_at).getTime() <= sDue ? "met" : "breached";
  else if (closedLike) resolution = "met";
  else resolution = nowMs > sDue ? "breached" : (sDue - nowMs) < (sDue - created) * WARN_FRACTION ? "at_risk" : "ok";

  return {
    response, resolution,
    overdue: !closedLike && resolution === "breached",
    at_risk: !closedLike && resolution === "at_risk",
    minutes_to_resolution: closedLike ? null : Math.round((sDue - nowMs) / 60000)
  };
}

const withSla = rows => rows.map(r => ({ ...r, sla: slaInfo(r) }));

module.exports = { getPolicy, computeDeadlines, slaInfo, withSla };
