/* Landing page: public knowledge base + sign-in aware links. All text goes in via textContent (never innerHTML). */
const $ = s => document.querySelector(s);
const SHORT = 5;
let sort = "top", showAll = false, term = "";

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "text") n.textContent = v; else if (k === "class") n.className = v; else n.setAttribute(k, v);
  }
  kids.forEach(k => n.append(k));
  return n;
}
const svg = markup => { const t = document.createElement("template"); t.innerHTML = markup.trim(); return t.content.firstChild; };
const BOOK = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 5.5C4 4 7.5 4 12 6c4.5-2 8-2 10-.5V19c-2-1.5-5.5-1.5-10 .5-4.5-2-8-2-10-.5z"/><path d="M12 6v13.5"/></svg>';
const EYE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';

const stars = (avg) => { const s = el("span", { class: "rstars", "aria-hidden": "true", text: "★★★★★" }); s.style.setProperty("--p", Math.max(0, Math.min(100, (avg || 0) * 20)) + "%"); return s; };
const ratingLine = a => a.rating_count
  ? el("span", { class: "kb-rating", title: `${a.rating_avg} out of 5` }, stars(a.rating_avg), document.createTextNode(`(${a.rating_count})`))
  : el("span", { class: "kb-rating", text: "No ratings yet" });

async function getJSON(url, opts = {}) {
  const res = await fetch(url, { credentials: "same-origin", ...opts, headers: { "X-Requested-With": "helpdesk", ...(opts.body ? { "Content-Type": "application/json" } : {}) } });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Request failed");
  return res.json();
}

/* ---------- knowledge base: category cards ---------- */
const CATS = {
  Account: ["Accounts, Access, and Passwords", "M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5zm-3 8V7a3 3 0 0 1 6 0v3z"],
  Hardware: ["Hardware and Devices", "M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-6v2h3v2H7v-2h3v-2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm0 2v9h16V6z"],
  Software: ["Software and Applications", "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm0 4v10h16V8z"],
  Network: ["Wireless, Networking, and VPN", "M12 18.5a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1 0-3.6zM12 12c2.4 0 4.5.9 6 2.4l-1.8 1.8A6.3 6.3 0 0 0 12 14.5c-1.7 0-3.3.7-4.2 1.7L6 14.4A8.7 8.7 0 0 1 12 12zm0-6c4 0 7.6 1.6 10.2 4.2l-1.8 1.8A12.4 12.4 0 0 0 12 8.5c-3.4 0-6.5 1.4-8.4 3.5L1.8 10.2A15 15 0 0 1 12 6z"],
  Email: ["Email and Calendar", "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm8 7L4.5 6.5v1.8L12 13l7.5-4.7V6.5z"],
  Printing: ["Printing and Scanning", "M6 3h12v5H6zM4 9h16a2 2 0 0 1 2 2v6h-4v-3H6v3H2v-6a2 2 0 0 1 2-2zm2 7h12v5H6z"],
  Security: ["Security and Safe Computing", "M12 2l8 3v6c0 5-3.4 9.4-8 11-4.6-1.6-8-6-8-11V5zm0 2.2L6 6.5V11c0 3.9 2.4 7.4 6 8.9 3.6-1.5 6-5 6-8.9V6.5z"],
  Training: ["Training and How-to Guides", "M12 3L1 9l11 6 9-4.9V17h2V9zM5 13.2v4L12 21l7-3.8v-4L12 17z"],
  Other: ["General IT Help", "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-2h2zm0-4h-2V7h2z"]
};
const CAT_ORDER = ["Account", "Hardware", "Software", "Network", "Email", "Printing", "Security", "Training", "Other"];
const expanded = new Set();
function renderList(items) {
  const list = $("#kbList"); list.replaceChildren();
  const groups = CAT_ORDER.map(c => [c, items.filter(a => a.category === c)]).filter(([, g]) => g.length || !term);
  if (!groups.length) { list.append(el("p", { class: "kb-note", text: term ? "No articles match your search." : "No articles have been published yet." })); return; }
  for (const [cat, arts] of groups) {
    const [title, path] = CATS[cat] || CATS.Other;
    const shown = expanded.has(cat) || term ? arts : arts.slice(0, 4);
    const ul = el("ul", { class: "kb-links" });
    if (!arts.length) ul.append(el("li", { class: "kb-none", text: "No articles yet" }));
    for (const a of shown) {
      const link = el("a", { href: "/kb/" + a.id, text: a.title });
      ul.append(el("li", {}, link));
    }
    const body = el("div", {}, el("h4", { text: title }), ul);
    if (!term && arts.length > 4) {
      const more = el("button", { type: "button", class: "kb-more", text: expanded.has(cat) ? "Show fewer" : `View all ${arts.length} articles…` });
      more.addEventListener("click", () => { expanded.has(cat) ? expanded.delete(cat) : expanded.add(cat); renderList(items); });
      body.append(more);
    }
    list.append(el("section", { class: "kb-cat" }, svg(`<svg viewBox="0 0 24 24" class="kb-ico" aria-hidden="true"><path d="${path}"/></svg>`), body));
  }
}
async function loadList() {
  const q = new URLSearchParams({ sort: "top", limit: "100" });
  if (term) q.set("search", term);
  try { renderList(await getJSON("/api/public/kb?" + q)); }
  catch (e) { $("#kbList").replaceChildren(el("p", { class: "kb-note", text: "Articles are unavailable right now. Please try again shortly." })); }
}

let timer;
const doSearch = () => { term = $("#searchInput").value.trim(); loadList(); };
$("#searchInput").addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(doSearch, 250); });
$("#searchForm").addEventListener("submit", e => { e.preventDefault(); clearTimeout(timer); doSearch(); $("#kbList").scrollIntoView({ behavior: "smooth", block: "start" }); });

/* ---------- reader feedback: star rating + "was this helpful?" ---------- */
function feedbackBox(a) {
  let current = a;
  const sum = el("span", { class: "fb-note" });
  const pick = el("span", { class: "star-pick", role: "radiogroup", "aria-label": "Rate this article" });
  const yes = el("button", { class: "vote-btn", type: "button" }), no = el("button", { class: "vote-btn", type: "button" });
  const msg = el("span", { class: "fb-note", role: "status" });
  const btns = [1, 2, 3, 4, 5].map(n => el("button", { type: "button", role: "radio", "aria-label": `${n} star${n > 1 ? "s" : ""}`, text: "★" }));
  btns.forEach(b => pick.append(b));
  const paint = n => btns.forEach((b, i) => b.classList.toggle("on", i < n));
  function show(s) {
    current = s;
    paint(s.my_rating || 0);
    btns.forEach((b, i) => b.setAttribute("aria-checked", String(s.my_rating === i + 1)));
    sum.textContent = s.rating_count ? `Average ${s.rating_avg} out of 5 from ${s.rating_count} rating${s.rating_count === 1 ? "" : "s"}` : "Be the first to rate this article";
    yes.classList.toggle("on", s.my_helpful === true); no.classList.toggle("on", s.my_helpful === false);
    yes.textContent = "Yes" + (s.helpful_yes ? ` (${s.helpful_yes})` : ""); no.textContent = "No" + (s.helpful_no ? ` (${s.helpful_no})` : "");
  }
  async function send(path, body, thanks) {
    try { show(await getJSON(`/api/public/kb/${a.id}/${path}`, { method: "POST", body: JSON.stringify(body) })); msg.textContent = thanks; }
    catch (e) { msg.textContent = e.message; }
  }
  btns.forEach((b, i) => {
    b.addEventListener("mouseenter", () => paint(i + 1)); b.addEventListener("focus", () => paint(i + 1));
    b.addEventListener("click", () => send("rating", { rating: i + 1 }, "Thanks for rating!"));
  });
  pick.addEventListener("mouseleave", () => paint(current.my_rating || 0));
  pick.addEventListener("focusout", () => paint(current.my_rating || 0));
  yes.addEventListener("click", () => send("helpful", { helpful: true }, "Glad it helped!"));
  no.addEventListener("click", () => send("helpful", { helpful: false }, "Thanks. Submit a ticket if you still need help."));
  show(a);
  return el("div", { class: "feedback" },
    el("div", { class: "fb-row" }, el("b", { text: "Rate this article" }), pick, sum),
    el("div", { class: "fb-row" }, el("b", { text: "Was this article helpful?" }), yes, no, msg));
}

/* ---------- article dialog ---------- */
let lastFocus = null;
function closeDialog() {
  const o = $("#overlay"); if (!o) return;
  o.remove(); document.removeEventListener("keydown", onKey);
  if (lastFocus) lastFocus.focus();
}
function onKey(e) { if (e.key === "Escape") closeDialog(); }

/* ---------- submit a ticket (on the landing page: sign in if needed, then the same form as the portal) ---------- */
const CATEGORIES = ["Hardware", "Software", "Network", "Account", "Email", "Printing", "Security", "Training", "Other"], PRIORITIES = ["Low", "Medium", "High", "Critical"];
const FILE_TYPES = ".png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.log,.csv,.json";
const field = (label, control, cls = "") => el("label", { class: "f " + cls }, document.createTextNode(label), control);
const select = (name, list, sel) => { const s = el("select", { name }); list.forEach(v => { const o = el("option", { text: v }); if (v === sel) o.selected = true; s.append(o); }); return s; };

function openShell(eyebrow, title) {
  closeDialog(); lastFocus = document.activeElement;
  const close = el("button", { class: "x", "aria-label": "Close", type: "button", text: "×" });
  const body = el("div", {});
  const dlg = el("div", { class: "dialog form-dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": "dlgTitle" },
    close, el("p", { class: "eyebrow", text: eyebrow }), el("h2", { id: "dlgTitle", text: title }), body);
  const overlay = el("div", { class: "overlay", id: "overlay" }, dlg);
  overlay.addEventListener("mousedown", e => { if (e.target === overlay) closeDialog(); });
  close.addEventListener("click", closeDialog); document.addEventListener("keydown", onKey);
  document.body.append(overlay);
  return { body, dlg, setTitle: t => { $("#dlgTitle").textContent = t; } };
}

function signInStep(shell, next) {
  shell.setTitle("Sign in to submit a ticket");
  const err = el("p", { class: "err", role: "alert" }), btn = el("button", { class: "btn", type: "submit", text: "Sign in" });
  const email = el("input", { name: "email", type: "email", autocomplete: "username", required: "" }), pw = el("input", { name: "password", type: "password", autocomplete: "current-password", required: "" });
  const form = el("form", { novalidate: "" }, el("p", { class: "sub", text: "Use your help desk account. Accounts are created by the service desk administrator." }),
    field("Email", email), field("Password", pw), err, btn);
  form.addEventListener("submit", async e => {
    e.preventDefault(); err.textContent = "";
    if (!email.value.trim() || !pw.value) { err.textContent = "Enter your email and password."; return; }
    btn.disabled = true; btn.textContent = "Signing in…";
    try {
      const { user } = await getJSON("/api/auth/login", { method: "POST", body: JSON.stringify({ email: email.value.trim(), password: pw.value }) });
      setSignedIn(user); next(user);
    } catch (ex) { err.textContent = ex.message; btn.disabled = false; btn.textContent = "Sign in"; pw.select(); }
  });
  shell.body.replaceChildren(form); email.focus();
}

async function ticketStep(shell) {
  shell.setTitle("Submit a ticket");
  let devices = []; try { devices = await getJSON("/api/assets/mine"); } catch {}
  const err = el("p", { class: "err", role: "alert" }), btn = el("button", { class: "btn", type: "submit", text: "Submit ticket" });
  const title = el("input", { name: "title", required: "", maxlength: "180", autocomplete: "off", placeholder: "e.g. Laptop cannot connect to Wi-Fi" });
  const desc = el("textarea", { name: "description", required: "", rows: "5", maxlength: "10000", placeholder: "Describe the issue, when it started and any error messages…" });
  const files = el("input", { type: "file", name: "files", multiple: "", accept: FILE_TYPES });
  const suggest = el("div", { class: "suggest", hidden: "" });
  const dev = el("select", { name: "asset_id" }, el("option", { value: "", text: "Not sure / none" }));
  devices.forEach(d => dev.append(el("option", { value: d.id, text: `${d.asset_tag} · ${d.name}` })));
  const form = el("form", { novalidate: "" }, el("div", { class: "grid" },
    field("Issue title", title, "full"), suggest,
    field("Category", select("category", CATEGORIES, "Other")), field("Priority", select("priority", PRIORITIES, "Medium")),
    field("Description", desc, "full"),
    ...(devices.length ? [field("Affected device (optional)", dev, "full")] : []),
    field("Attach screenshots or logs (PNG, JPG, PDF, TXT, LOG, CSV, JSON · up to 5 files)", files, "full")),
    err, el("div", { class: "form-actions" }, btn));

  // Self-service deflection: suggest articles while typing the title.
  let t; title.addEventListener("input", () => {
    clearTimeout(t); t = setTimeout(async () => {
      const term = title.value.trim(); if (term.length < 4) { suggest.hidden = true; return; }
      try {
        const found = new Map();
        for (const w of term.split(/\s+/).filter(w => w.length > 3).slice(0, 3)) for (const a of await getJSON("/api/public/kb?limit=3&search=" + encodeURIComponent(w))) found.set(a.id, a);
        const list = [...found.values()].slice(0, 3); suggest.hidden = !list.length; suggest.replaceChildren();
        if (list.length) { suggest.append(el("b", { text: "These guides might fix it:" })); list.forEach(a => { suggest.append(el("a", { href: "/kb/" + a.id, target: "_blank", rel: "noopener", text: a.title })); }); }
      } catch {}
    }, 400);
  });

  form.addEventListener("submit", async e => {
    e.preventDefault(); err.textContent = "";
    const payload = {}; for (const [k, v] of new FormData(form).entries()) if (k !== "files" && v !== "") payload[k] = v;
    if (!payload.title || !payload.description) { err.textContent = "Please add a title and a description."; return; }
    btn.disabled = true; btn.textContent = "Submitting…";
    try {
      const tk = await getJSON("/api/tickets", { method: "POST", body: JSON.stringify(payload) });
      let note = "";
      if (files.files.length) {
        const up = new FormData(); [...files.files].slice(0, 5).forEach(f => up.append("files", f));
        const r = await fetch(`/api/tickets/${tk.id}/attachments`, { method: "POST", credentials: "same-origin", headers: { "X-Requested-With": "helpdesk" }, body: up });
        if (!r.ok) note = "Your files could not be attached. You can add them from the ticket page.";
      }
      doneStep(shell, tk, note);
    } catch (ex) { err.textContent = ex.message; btn.disabled = false; btn.textContent = "Submit ticket"; }
  });
  shell.body.replaceChildren(form); title.focus();
}

function doneStep(shell, tk, note) {
  shell.setTitle("Ticket submitted");
  const ref = `#HD-${String(tk.id).padStart(4, "0")}`, again = el("button", { class: "btn-outline", type: "button", text: "Submit another" }), done = el("button", { class: "btn", type: "button", text: "Done" });
  again.addEventListener("click", () => ticketStep(shell)); done.addEventListener("click", closeDialog);
  shell.body.replaceChildren(
    el("p", { class: "ok" }, document.createTextNode("Thanks! Your ticket "), el("b", { text: ref }), document.createTextNode(" has been created. Our support team will reply soon.")),
    ...(note ? [el("p", { class: "err", text: note })] : []),
    el("div", { class: "form-actions" }, (() => { const a = el("a", { href: "#", text: "View ticket" }); a.addEventListener("click", e => { e.preventDefault(); openMyTickets(tk.id); }); return a; })(), again, done));
  done.focus();
}

function openSubmit() {
  const shell = openShell("IT SERVICE MANAGEMENT", "Submit a ticket");
  if (window.__signedIn) ticketStep(shell); else signInStep(shell, () => ticketStep(shell));
}


/* ---------- my tickets (customers view and follow their tickets on the landing page) ---------- */
const STATUSES = ["Open", "In Progress", "Pending", "Resolved", "Closed"];
const refOf = id => `#HD-${String(id).padStart(4, "0")}`;
const fmtDate = v => v ? new Date(v).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
const slugOf = v => String(v).toLowerCase().replace(/\s+/g, "-");
const pill = (kind, v) => el("span", { class: `pill ${kind}-${slugOf(v)}`, text: v });
const send = (url, method, body) => getJSON(url, { method, body: JSON.stringify(body) });
const PRIO_ORDER = { Critical: 0, High: 1, Medium: 2, Low: 3 };

function openMyTickets(openId) {
  const shell = openShell("IT SERVICE MANAGEMENT", "My tickets");
  shell.dlg.classList.add("wide");
  if (openId) ticketDetail(shell, openId); else ticketList(shell);
}

async function ticketList(shell) {
  shell.setTitle("My tickets");
  const search = el("input", { type: "search", placeholder: "Search by title or number…", "aria-label": "Search tickets" });
  const status = select("status", ["All statuses", ...STATUSES], "All statuses");
  const list = el("div", { class: "tk-list", "aria-live": "polite" }), count = el("span", { class: "fb-note" });
  const newBtn = el("button", { class: "btn", type: "button", text: "+ Submit a ticket" });
  newBtn.addEventListener("click", () => { closeDialog(); openSubmit(); });
  shell.body.replaceChildren(el("div", { class: "tk-bar" }, search, status, newBtn), list, el("div", { class: "tk-foot" }, count, el("span", { class: "fb-note", text: "Click a ticket to open it" })));
  let all = [];
  const draw = () => {
    const q = search.value.trim().toLowerCase().replace(/^#?(hd-?)?0*/, ""), raw = search.value.trim().toLowerCase();
    const rows = all.filter(t => (status.value === "All statuses" || t.status === status.value) && (!raw || t.title.toLowerCase().includes(raw) || refOf(t.id).toLowerCase().includes(raw) || String(t.id) === q));
    count.textContent = `${rows.length} ticket${rows.length === 1 ? "" : "s"}`;
    list.replaceChildren();
    if (!rows.length) { list.append(el("p", { class: "kb-note", text: all.length ? "No tickets match your search." : "No tickets found." })); return; }
    rows.forEach(t => {
      const row = el("button", { class: "tk-row", type: "button" },
        el("span", { class: "tk-id", text: refOf(t.id) }),
        el("span", { class: "tk-title" }, el("b", { text: t.title }), el("small", { text: `${t.category} · ${fmtDate(t.created_at)}` })),
        pill("priority", t.priority), pill("status", t.status),
        el("span", { class: "tk-tech", text: t.technician_name || "Unassigned" }));
      row.addEventListener("click", () => ticketDetail(shell, t.id));
      list.append(row);
    });
  };
  search.addEventListener("input", draw); status.addEventListener("change", draw);
  list.append(el("p", { class: "kb-note", text: "Loading…" }));
  try {
    all = (await getJSON("/api/tickets")).sort((a, b) => (a.status === "Resolved" || a.status === "Closed") - (b.status === "Resolved" || b.status === "Closed") || PRIO_ORDER[a.priority] - PRIO_ORDER[b.priority] || new Date(a.resolution_due) - new Date(b.resolution_due));
    draw();
  } catch (e) { list.replaceChildren(el("p", { class: "err", text: e.message })); }
}

async function ticketDetail(shell, id) {
  shell.body.replaceChildren(el("p", { class: "kb-note", text: "Loading…" }));
  let t;
  try { t = await getJSON("/api/tickets/" + id); } catch (e) { shell.body.replaceChildren(el("p", { class: "err", text: e.message })); return; }
  shell.setTitle(`${refOf(t.id)} · ${t.title}`);
  const done = t.status === "Resolved" || t.status === "Closed";
  const back = el("button", { class: "btn-outline back", type: "button", text: "← All my tickets" });
  back.addEventListener("click", () => ticketList(shell));
  const msg = el("p", { class: "err", role: "alert" });
  const reload = () => ticketDetail(shell, id);
  const act = (btn, fn) => btn.addEventListener("click", async () => { msg.textContent = ""; btn.disabled = true; try { await fn(); await reload(); } catch (e) { msg.textContent = e.message; btn.disabled = false; } });

  const meta = el("div", { class: "t-meta" },
    ...[["CATEGORY", t.category], ["CREATED", fmtDate(t.created_at)], ["ASSIGNED TECHNICIAN", t.technician_name || "Unassigned"], ["FIRST RESPONSE", t.first_response_at ? fmtDate(t.first_response_at) : "Not yet"], ["TARGET RESOLUTION", t.resolved_at ? "Resolved " + fmtDate(t.resolved_at) : fmtDate(t.resolution_due)]]
      .map(([k, v]) => el("div", {}, el("span", { text: k }), el("strong", { text: v }))));

  const atts = el("div", { class: "tk-atts" });
  if (!t.attachments.length) atts.append(el("p", { class: "fb-note", text: "No attachments." }));
  t.attachments.forEach(a => atts.append(el("a", { href: `/api/attachments/${a.id}?download=1`, text: a.original_name })));
  const upInput = el("input", { type: "file", multiple: "", accept: FILE_TYPES }), upBtn = el("button", { class: "btn-outline", type: "button", text: "Upload" });
  act(upBtn, async () => {
    if (!upInput.files.length) throw new Error("Choose at least one file");
    const fd = new FormData(); [...upInput.files].slice(0, 5).forEach(f => fd.append("files", f));
    const r = await fetch(`/api/tickets/${id}/attachments`, { method: "POST", credentials: "same-origin", headers: { "X-Requested-With": "helpdesk" }, body: fd });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Upload failed");
  });

  const convo = el("div", { class: "t-conv" }, el("h3", { text: `Conversation (${t.notes.length})` }));
  if (!t.notes.length) convo.append(el("p", { class: "fb-note", text: "Nothing yet." }));
  t.notes.forEach(n => convo.append(el("div", { class: "msg" + (n.author_role === "admin" || n.author_role === "technician" ? " staff" : "") },
    el("b", { text: n.author }), el("small", { text: fmtDate(n.created_at) }), el("p", { text: n.note }))));
  const reply = el("textarea", { rows: "3", maxlength: "5000", placeholder: "Add more information or reply to the support team…" }), replyBtn = el("button", { class: "btn", type: "button", text: "Send reply" });
  act(replyBtn, async () => { if (!reply.value.trim()) throw new Error("Write a message first"); await send(`/api/tickets/${id}/notes`, "POST", { note: reply.value }); });

  const parts = [back,
    el("div", { class: "t-head" }, el("span", { class: "t-ref", text: refOf(t.id) }), el("span", {}, pill("priority", t.priority), document.createTextNode(" "), pill("status", t.status))),
    el("p", { class: "t-desc", text: t.description }), meta];

  if (done || t.feedback || true) {
    const row = el("div", { class: "form-actions left" });
    if (t.status === "Resolved") {
      const no = el("button", { class: "btn-outline", type: "button", text: "No, reopen" }), yes = el("button", { class: "btn", type: "button", text: "Yes, close ticket" });
      act(no, () => send("/api/tickets/" + id, "PATCH", { status: "Open" })); act(yes, () => send("/api/tickets/" + id, "PATCH", { status: "Closed" }));
      row.append(el("span", { class: "fb-note", text: "Is the problem fixed?" }), no, yes);
    } else if (t.status === "Closed") {
      const re = el("button", { class: "btn-outline", type: "button", text: "Reopen ticket" }); act(re, () => send("/api/tickets/" + id, "PATCH", { status: "Open" })); row.append(re);
    }
    if (row.children.length) parts.push(row);
  }
  if (t.feedback) parts.push(el("p", { class: "fb-note" }, document.createTextNode("Your rating: "), el("span", { class: "rstars", text: "★★★★★", style: `--p:${t.feedback.rating * 20}%` })));
  else if (done) {
    let chosen = 0; const stars2 = el("span", { class: "star-pick" }), comment = el("textarea", { rows: "2", maxlength: "1000", placeholder: "Optional comment" }), go = el("button", { class: "btn-outline", type: "button", text: "Submit feedback" });
    const bs = [1, 2, 3, 4, 5].map(n => { const b = el("button", { type: "button", "aria-label": `${n} stars`, text: "★" }); b.addEventListener("click", () => { chosen = n; bs.forEach((x, i) => x.classList.toggle("on", i < n)); }); stars2.append(b); return b; });
    act(go, async () => { if (!chosen) throw new Error("Choose a star rating"); await send(`/api/tickets/${id}/feedback`, "POST", { rating: chosen, comment: comment.value }); });
    parts.push(el("div", { class: "feedback" }, el("b", { text: "How did we do?" }), stars2, comment, go));
  }
  parts.push(el("div", { class: "t-conv" }, el("h3", { text: `Attachments (${t.attachments.length})` }), atts, el("div", { class: "tk-up" }, upInput, upBtn)), convo, reply, el("div", { class: "form-actions" }, replyBtn), msg);
  shell.body.replaceChildren(...parts);
}

function openPassword() {
  const shell = openShell("ACCOUNT", "Change password");
  const err = el("p", { class: "err", role: "alert" }), btn = el("button", { class: "btn", type: "submit", text: "Update password" });
  const cur = el("input", { type: "password", required: "", autocomplete: "current-password" }), nxt = el("input", { type: "password", required: "", minlength: "8", autocomplete: "new-password" });
  const form = el("form", { novalidate: "" }, field("Current password", cur), field("New password", nxt), el("p", { class: "fb-note", text: "At least 8 characters, with a letter and a number." }), err, el("div", { class: "form-actions" }, btn));
  form.addEventListener("submit", async e => {
    e.preventDefault(); err.textContent = ""; btn.disabled = true;
    try { await send("/api/auth/change-password", "POST", { current_password: cur.value, new_password: nxt.value }); shell.body.replaceChildren(el("p", { class: "ok", text: "Password updated." })); }
    catch (ex) { err.textContent = ex.message; btn.disabled = false; }
  });
  shell.body.replaceChildren(form); cur.focus();
}

/* ---------- signed-in state: swap links so a logged-in customer goes straight to the portal ---------- */
function setSignedIn(user) {
  window.__signedIn = true;
  const staff = user.role !== "employee";
  const link = (text, onClick, href = "#") => { const a = el("a", { href, text }); if (onClick) a.addEventListener("click", e => { e.preventDefault(); onClick(); }); return a; };
  const out = link("Sign out", async () => {
    try { await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin", headers: { "X-Requested-With": "helpdesk" } }); } catch {}
    location.reload();
  });
  $("#topNav").replaceChildren(...(staff ? [link("Administration panel", null, "/app"), out] : [link("My tickets", () => openMyTickets()), link("Password", openPassword), out]));
  const view = $("#viewCard");
  if (staff) view.href = "/app#tickets";
  else { view.href = "#"; view.setAttribute("role", "button"); view.addEventListener("click", e => { e.preventDefault(); openMyTickets(); }); }
}

(async function init() {
  const pre = new URLSearchParams(location.search).get("search");
  if (pre) { $("#searchInput").value = pre.slice(0, 100); term = $("#searchInput").value.trim(); }
  loadList();
  $("#submitCard").addEventListener("click", e => { e.preventDefault(); openSubmit(); });
  if (location.hash === "#new") { history.replaceState(null, "", location.pathname); }
  try { const { user } = await getJSON("/api/auth/me"); setSignedIn(user); } catch { /* not signed in: submit asks for sign-in in place */ }
  if (/[?&]submit=1/.test(location.search) || location.hash === "#submit") openSubmit();
})();
