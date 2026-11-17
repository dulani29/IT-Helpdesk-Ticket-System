const nodemailer = require("nodemailer");
const crypto = require("crypto");
const pool = require("./db");

let transporter = null;
if (process.env.SMTP_HOST) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === "true",
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
  });
}

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
const ticketRef = id => `HD-${String(id).padStart(4, "0")}`;

/* ---------- reply-by-email addressing ----------
   Customer emails carry a Reply-To such as helpdesk+t42.9f3a1c0b77de@example.com. The tag holds the ticket id plus a
   short HMAC, so only someone who received the email can post to that ticket. Needs INBOUND_EMAIL_ADDRESS + JWT_SECRET. */
const replyToken = id => crypto.createHmac("sha256", process.env.JWT_SECRET || "").update("reply:" + id).digest("hex").slice(0, 12);
function replyAddress(id) {
  const addr = String(process.env.INBOUND_EMAIL_ADDRESS || "").trim(), at = addr.lastIndexOf("@");
  if (at < 1 || !process.env.JWT_SECRET) return undefined;
  return `${addr.slice(0, at)}+t${id}.${replyToken(id)}${addr.slice(at)}`;
}
function verifyReplyToken(id, token) {
  if (!process.env.JWT_SECRET || !/^[a-f0-9]{12}$/.test(String(token))) return false;
  const a = Buffer.from(replyToken(id)), b = Buffer.from(String(token));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------- rendering ---------- */
// lines: paragraphs. opts: { accent, tag, cta: {label, url}, quote, replyTo }
function render(lines, opts = {}) {
  const accent = opts.accent || "#3b6a9c", cta = opts.cta, quote = opts.quote;
  const text = [...lines, ...(quote ? ["", quote.split("\n").map(l => "> " + l).join("\n"), ""] : []), ...(cta ? [`${cta.label}: ${cta.url}`] : []),
    "", `IT Service Desk · ${process.env.APP_URL || ""}`].join("\n");
  const html = `<div style="background:#ebeff3;padding:24px 12px;font-family:Arial,Helvetica,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e8edf5;border-radius:10px;overflow:hidden">
    <tr><td style="background:${accent};padding:14px 24px;color:#ffffff;font-size:14px;font-weight:700">IT Service Desk${opts.tag ? ` &middot; ${esc(opts.tag)}` : ""}</td></tr>
    <tr><td style="padding:24px;font-size:14px;line-height:1.6;color:#172033">
      ${lines.map(l => `<p style="margin:0 0 12px">${esc(l)}</p>`).join("")}
      ${quote ? `<div style="border-left:3px solid ${accent};background:#f6f8fb;padding:12px 14px;margin:14px 0;white-space:pre-wrap;word-break:break-word">${esc(quote)}</div>` : ""}
      ${cta ? `<p style="margin:20px 0 6px"><a href="${esc(cta.url)}" style="display:inline-block;background:${accent};color:#ffffff;padding:11px 20px;border-radius:7px;text-decoration:none;font-weight:700">${esc(cta.label)}</a></p>` : ""}
    </td></tr>
    <tr><td style="padding:14px 24px;border-top:1px solid #e8edf5;color:#718096;font-size:12px">IT Service Desk &middot; ${esc(process.env.APP_URL || "")}</td></tr>
  </table></div>`;
  return { text, html };
}

// Never throws: email problems must not break ticket workflows.
async function sendMail(to, subject, lines, opts = {}) {
  if (!to) return;
  const { text, html } = render(lines, opts);
  let status = "logged", error = null;
  try {
    if (transporter) {
      await transporter.sendMail({ from: process.env.MAIL_FROM || "helpdesk@example.com", to, subject, text, html, replyTo: opts.replyTo });
      status = "sent";
    } else {
      console.log(`[email not configured] To: ${to} | ${subject}${opts.replyTo ? ` | Reply-To: ${opts.replyTo}` : ""}\n${text}\n`);
    }
  } catch (err) { status = "failed"; error = err.message.slice(0, 480); console.error("Email failed:", err.message); }
  try { await pool.query("INSERT INTO email_log (to_email, subject, status, error) VALUES (?, ?, ?, ?)", [to, subject, status, error]); } catch {}
}

const base = () => process.env.APP_URL || "http://localhost:3000";
const link = id => `${base()}/app#ticket-${id}`;
const trackLink = id => `${base()}/track?ticket=${id}`;
const clip = (s, n) => { s = String(s ?? "").trim(); return s.length > n ? s.slice(0, n) + "…" : s; };

// Options shared by every email sent to a customer.
const forCustomer = (t, o) => ({ replyTo: replyAddress(t.id), tag: ticketRef(t.id), ...o });
const replyHint = t => replyAddress(t.id) ? ["You can simply reply to this email to answer."] : [];

const notify = {
  /* ---- to technicians ---- */
  newTicket: (tech, t, requesterName) => sendMail(tech.email, `[${ticketRef(t.id)}] New ${t.priority} ticket: ${t.title}`,
    [`A new ticket has been logged by ${requesterName}.`, `Title: ${t.title}`, `Priority: ${t.priority} · Category: ${t.category}`],
    { cta: { label: "Open ticket", url: link(t.id) } }),
  assigned: (tech, t) => sendMail(tech.email, `[${ticketRef(t.id)}] Ticket assigned to you`,
    [`Ticket ${ticketRef(t.id)} "${t.title}" (${t.priority}) is now assigned to you.`], { cta: { label: "Open ticket", url: link(t.id) } }),
  slaWarning: (to, t) => sendMail(to, `[${ticketRef(t.id)}] SLA warning: deadline approaching`,
    [`Ticket ${ticketRef(t.id)} "${t.title}" is close to its resolution deadline.`], { accent: "#c47b20", cta: { label: "Open ticket", url: link(t.id) } }),
  slaBreach: (to, t) => sendMail(to, `[${ticketRef(t.id)}] SLA BREACHED`,
    [`Ticket ${ticketRef(t.id)} "${t.title}" has passed its resolution deadline.`], { accent: "#d94a5b", cta: { label: "Open ticket", url: link(t.id) } }),
  escalated: (to, t, reason) => sendMail(to, `[${ticketRef(t.id)}] Ticket escalated to you`,
    [`Ticket ${ticketRef(t.id)} "${t.title}" (${t.priority}) was escalated.`, `Reason: ${reason}`], { accent: "#d94a5b", cta: { label: "Open ticket", url: link(t.id) } }),

  /* ---- to the customer ---- */
  // 1. Ticket created: confirmation with the reference number.
  created: (requester, t) => sendMail(requester.email, `[${ticketRef(t.id)}] We received your request: ${t.title}`,
    [`Hello ${requester.name},`, `Thanks for contacting the IT Service Desk. Your request has been logged and a technician will be in touch.`,
     `Ticket: ${ticketRef(t.id)} · Priority: ${t.priority} · Category: ${t.category}`, `Subject: ${t.title}`, ...replyHint(t),
     `You can also check its status without signing in (use ticket ${ticketRef(t.id)} and your email address): ${trackLink(t.id)}`],
    forCustomer(t, { accent: "#3976d8", cta: { label: "View your ticket", url: link(t.id) } })),
  // 2. A technician replied: includes the message itself.
  reply: (requester, t, author, message) => sendMail(requester.email, `[${ticketRef(t.id)}] New reply on your ticket: ${t.title}`,
    [`Hello ${requester.name},`, `${author} replied to your ticket "${t.title}":`],
    forCustomer(t, { accent: "#3b6a9c", quote: clip(message, 3000),
      cta: { label: "View ticket & reply", url: link(t.id) } })),
  // 3. Resolved.
  resolved: (requester, t) => sendMail(requester.email, `[${ticketRef(t.id)}] Your ticket has been resolved`,
    [`Hello ${requester.name},`, `Your ticket "${t.title}" has been marked as resolved.`,
     "Please confirm the fix and leave a quick rating. If the problem is not solved, reopen it from the ticket" + (replyAddress(t.id) ? " or just reply to this email." : "."),
     `Or check its status without signing in (ticket ${ticketRef(t.id)}, use your email address): ${trackLink(t.id)}`],
    forCustomer(t, { accent: "#15966a", cta: { label: "Confirm & rate", url: link(t.id) } })),
  updated: (requester, t, change) => sendMail(requester.email, `[${ticketRef(t.id)}] Your ticket was updated`,
    [`Hello ${requester.name},`, `Your ticket "${t.title}" was updated: ${change}`,
     `Or check its status without signing in (ticket ${ticketRef(t.id)}, use your email address): ${trackLink(t.id)}`],
    forCustomer(t, { cta: { label: "View ticket", url: link(t.id) } }))
};

module.exports = { sendMail, notify, ticketRef, replyAddress, verifyReplyToken };
