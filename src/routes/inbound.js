// Reply by email. An email provider (Mailgun, SendGrid Inbound Parse, Postmark, ...) POSTs each message that arrives at
// INBOUND_EMAIL_ADDRESS to /api/inbound/email?secret=... . A reply to one of our notification emails carries a signed
// ticket tag in its address (see mailer.js), and becomes a public reply on that ticket.
const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const pool = require("../db");
const { audit } = require("../audit");
const { notify, verifyReplyToken } = require("../mailer");
const { getTicket } = require("../tickets-common");

const router = express.Router();
const limiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });

// Body parsers live here (not globally) because providers send JSON, urlencoded or multipart bodies, some very large.
const parsers = [
  express.json({ limit: "10mb" }),
  express.urlencoded({ extended: false, limit: "10mb" }),
  multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 20 } }).any()   // attachments are read but not stored
];

function secretOk(req) {
  const expected = process.env.INBOUND_EMAIL_SECRET;
  if (!expected) return false;
  const given = String(req.query.secret || req.get("x-inbound-secret") || "");
  const a = crypto.createHash("sha256").update(given).digest(), b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

const first = (...v) => v.find(x => typeof x === "string" && x.trim()) || "";
const addressOf = s => { const m = String(s || "").match(/<([^<>\s]+@[^<>\s]+)>/) || String(s || "").match(/([^\s<>,;"']+@[^\s<>,;"']+)/); return m ? m[1].toLowerCase() : ""; };

// Cut the quoted original and signatures off a reply so only the new text is posted.
const CUTS = [
  /\n[ \t]*On\s[^\n]{0,200}(?:\n[^\n]{0,200})?\bwrote:[\s\S]*$/i,
  /\n[ \t]*-{2,}\s*Original Message\s*-{2,}[\s\S]*$/i,
  /\n[ \t]*_{8,}\s*\n[ \t]*From:[\s\S]*$/i,
  /\n[ \t]*From:[^\n]+\n[ \t]*(?:Sent|Date):[\s\S]*$/i,
  /\n[ \t]*>[\s\S]*$/,
  /\n-- ?\n[\s\S]*$/
];
function stripQuoted(text) {
  let t = "\n" + String(text || "").replace(/\r\n?/g, "\n");
  for (const re of CUTS) t = t.replace(re, "");
  return t.trim();
}

// Normalise the field names of the common providers.
function normalise(b) {
  let envelopeTo = "";
  try { envelopeTo = [].concat(JSON.parse(b.envelope || "{}").to || []).join(" "); } catch {}
  const toField = [b.to, b.To, b.recipient, b.OriginalRecipient, b["X-Original-To"], envelopeTo, b.MailboxHash ? "+" + b.MailboxHash + "@x" : ""]
    .filter(x => typeof x === "string").join(" ");
  return {
    from: addressOf(first(b.from, b.From, b.sender, b.Sender)),
    recipients: toField,
    subject: first(b.subject, b.Subject),
    text: first(b["stripped-text"], b.StrippedTextReply, b.text, b["body-plain"], b.TextBody)
  };
}

router.post("/email", limiter, (req, res, next) => (secretOk(req) ? next() : res.status(process.env.INBOUND_EMAIL_SECRET ? 403 : 404).json({ error: "Not available" })),
  ...parsers, async (req, res) => {
  // Always answer 200 for mail we deliberately ignore, so the provider does not keep retrying it.
  const ignore = reason => res.json({ ok: false, ignored: reason });
  try {
    const m = normalise(req.body || {});
    if (/^\s*(automatic reply|auto[- ]?reply|out of office|undeliverable|delivery status|mail delivery)/i.test(m.subject)) return ignore("auto-reply");

    const tag = m.recipients.match(/\+t(\d{1,9})\.([a-f0-9]{12})@/i);
    if (!tag || !verifyReplyToken(Number(tag[1]), tag[2].toLowerCase())) return ignore("no valid ticket address");
    const t = await getTicket(Number(tag[1]));
    if (!t) return ignore("unknown ticket");
    if (!m.from || m.from !== String(t.requester_email).toLowerCase()) return ignore("sender is not the requester");

    const body = stripQuoted(m.text).slice(0, 5000);
    if (!body) return ignore("empty message");
    const [dupe] = await pool.query("SELECT id FROM ticket_notes WHERE ticket_id = ? AND user_id = ? AND note = ? AND created_at > NOW() - INTERVAL 5 MINUTE", [t.id, t.requester_id, body]);
    if (dupe.length) return ignore("duplicate");

    await pool.query("INSERT INTO ticket_notes (ticket_id, user_id, note, is_internal) VALUES (?, ?, ?, 0)", [t.id, t.requester_id, body]);
    await audit({ userId: t.requester_id, entity: "ticket", entityId: t.id, ticketId: t.id, action: "note_added", details: "reply received by email" });

    // A reply to a resolved or closed ticket means the problem is not fixed: reopen it.
    const reopened = t.status === "Resolved" || t.status === "Closed";
    if (reopened) {
      await pool.query("UPDATE tickets SET status = 'Open', resolved_at = NULL, closed_at = NULL WHERE id = ?", [t.id]);
      await audit({ userId: t.requester_id, entity: "ticket", entityId: t.id, ticketId: t.id, action: "updated", details: `status: ${t.status} → Open (customer replied by email)` });
    }

    // Tell the assigned technician, or every active technician when nobody owns the ticket yet.
    const [techs] = t.technician_id
      ? await pool.query("SELECT name, email FROM users WHERE id = ? AND is_active = 1", [t.technician_id])
      : await pool.query("SELECT name, email FROM users WHERE role = 'technician' AND is_active = 1");
    techs.forEach(tech => notify.updated(tech, t, `${t.requester_name} replied by email${reopened ? " and the ticket was reopened" : ""}`));
    res.json({ ok: true, ticket: t.id, reopened });
  } catch (err) {
    console.error("Inbound email failed:", err.message);
    res.status(500).json({ error: "Could not process the message" });   // transient: let the provider retry
  }
});

router.stripQuoted = stripQuoted;
module.exports = router;
