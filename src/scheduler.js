const pool = require("./db");
const { slaInfo } = require("./sla");
const { notify } = require("./mailer");
const { audit } = require("./audit");
const { escalateTicket } = require("./escalation");

// Who should hear about an SLA problem: the assigned technician, otherwise every active technician/admin.
async function recipients(ticket) {
  if (ticket.technician_id) {
    const [r] = await pool.query("SELECT email FROM users WHERE id = ? AND is_active = 1", [ticket.technician_id]);
    if (r.length) return r.map(x => x.email);
  }
  const [r] = await pool.query("SELECT email FROM users WHERE role IN ('technician','admin') AND is_active = 1");
  return r.map(x => x.email);
}

async function runSlaCheck() {
  const [open] = await pool.query("SELECT * FROM tickets WHERE status IN ('Open','In Progress','Pending')");
  for (const t of open) {
    const s = slaInfo(t);
    try {
      if (s.resolution === "breached" && !t.sla_breach_sent) {
        await pool.query("UPDATE tickets SET sla_breach_sent = 1, sla_warning_sent = 1 WHERE id = ?", [t.id]);
        await audit({ entity: "ticket", entityId: t.id, ticketId: t.id, action: "sla_breached", details: "Resolution deadline passed" });
        (await recipients(t)).forEach(to => notify.slaBreach(to, t));
        if (process.env.AUTO_ESCALATE !== "false" && t.escalation_level === 0) {
          await escalateTicket({ ticketId: t.id, actorId: null, reason: "Automatic escalation: SLA resolution deadline breached" })
            .catch(err => console.warn(`Auto-escalation skipped for #${t.id}: ${err.message}`));
        }
      } else if (s.resolution === "at_risk" && !t.sla_warning_sent) {
        await pool.query("UPDATE tickets SET sla_warning_sent = 1 WHERE id = ?", [t.id]);
        await audit({ entity: "ticket", entityId: t.id, ticketId: t.id, action: "sla_warning", details: "Approaching resolution deadline" });
        (await recipients(t)).forEach(to => notify.slaWarning(to, t));
      }
    } catch (err) { console.error(`SLA check failed for ticket ${t.id}:`, err.message); }
  }
}

function startScheduler() {
  const seconds = Math.max(15, Number(process.env.SLA_CHECK_SECONDS || 60));
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await runSlaCheck(); } catch (err) { console.error("SLA scheduler error:", err.message); } finally { running = false; }
  };
  setTimeout(tick, 5000);
  return setInterval(tick, seconds * 1000);
}

module.exports = { startScheduler, runSlaCheck };
