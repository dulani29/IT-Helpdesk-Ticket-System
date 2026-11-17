/* Guest ticket lookup: ticket number + email. All server text is inserted with textContent. */
const $ = s => document.querySelector(s);
const form = $("#trackForm"), errBox = $("#trackError"), out = $("#result"), btn = $("#trackBtn");
const slug = v => String(v).toLowerCase().replace(/\s+/g, "-");
const ref = id => "HD-" + String(id).padStart(4, "0");
const fmt = v => v ? new Date(v).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }
function field(label, value) { const d = el("div"); d.append(el("span", "", label), el("strong", "", value)); return d; }

const STATUS_HINT = {
  "Open": "We've received your ticket and a technician will pick it up soon.",
  "In Progress": "A technician is working on your ticket.",
  "Pending": "We're waiting on something (for example, more information or a part).",
  "Resolved": "We believe this is fixed. Sign in to confirm and close the ticket, or reopen it if the problem is still there.",
  "Closed": "This ticket is closed."
};

function render({ ticket: t, notes }) {
  out.replaceChildren();
  const head = el("div", "t-head"), left = el("div");
  left.append(el("div", "t-ref", ref(t.id)), el("h2", "", t.title));
  const pills = el("div"); pills.append(el("span", "pill status-" + slug(t.status), t.status), document.createTextNode(" "), el("span", "pill priority-" + slug(t.priority), t.priority + " priority"));
  head.append(left, pills);
  const meta = el("div", "t-meta");
  meta.append(field("CATEGORY", t.category), field("SUBMITTED", fmt(t.created_at)), field("LAST UPDATE", fmt(t.updated_at)),
    field("HANDLED BY", t.technician_name || "Not assigned yet"), ...(t.resolved_at ? [field("RESOLVED", fmt(t.resolved_at))] : []));
  const hint = el("p", "t-desc", STATUS_HINT[t.status] || "");
  const desc = el("div", "t-conv"); desc.append(el("h3", "", "Your request"), el("p", "t-desc", t.description));
  const conv = el("div", "t-conv"); conv.append(el("h3", "", `Replies (${notes.length})`));
  if (!notes.length) conv.append(el("p", "fb-note", "No replies yet. We'll get back to you soon."));
  for (const n of notes) {
    const m = el("div", "msg" + (n.from_staff ? " staff" : "")), who = el("b", "", n.from_staff ? n.author + " (support)" : n.author);
    m.append(who, el("small", "", fmt(n.created_at)), el("p", "", n.note)); conv.append(m);
  }
  const foot = el("p", "t-foot"); foot.append("Need to reply or add attachments? ");
  const a = el("a", "", "Sign in to your account"); a.href = "/login?next=" + encodeURIComponent("/app#ticket-" + t.id); foot.append(a, ".");
  out.append(head, meta, hint, desc, conv, foot); out.hidden = false;
}

async function lookup(ticket, email) {
  errBox.textContent = ""; out.hidden = true;
  if (!ticket || !email) { errBox.textContent = "Enter both the ticket number and your email address."; return; }
  btn.disabled = true; btn.textContent = "Looking up…";
  try {
    const res = await fetch("/api/public/track", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-Requested-With": "helpdesk" }, body: JSON.stringify({ ticket, email }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Lookup failed");
    render(data);
  } catch (e) { errBox.textContent = e.message; }
  finally { btn.disabled = false; btn.textContent = "View ticket"; }
}
form.addEventListener("submit", e => { e.preventDefault(); lookup(form.ticket.value.trim(), form.email.value.trim()); });

// Links from emails look like /track?ticket=7 : prefill the number.
const pre = new URLSearchParams(location.search).get("ticket");
if (pre && /^[\w-]{1,20}$/.test(pre)) { form.ticket.value = pre; form.email.focus(); } else form.ticket.focus();
