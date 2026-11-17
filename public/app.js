/* HelpDesk front end: vanilla JS single-page app. All user data is escaped before it is put in HTML. */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (v = "") => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const slug = v => String(v).toLowerCase().replace(/\s+/g, "-");
const ref = id => `#HD-${String(id).padStart(4, "0")}`;
const fmtDate = v => v ? new Date(v).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
const fmtDay = v => v ? new Date(v).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—";
const fmtMins = m => {
  if (m === null || m === undefined || isNaN(m)) return "—";
  m = Math.abs(Math.round(m));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return d ? `${d}d ${h}h` : h ? `${h}h ${mm}m` : `${mm}m`;
};
const fmtSize = b => b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB";
const PRIORITIES = ["Low", "Medium", "High", "Critical"];
const STATUSES = ["Open", "In Progress", "Pending", "Resolved", "Closed"];
const CATEGORIES = ["Hardware", "Software", "Network", "Account", "Email", "Printing", "Security", "Training", "Other"];
const options = (list, selected) => list.map(x => `<option ${x === selected ? "selected" : ""}>${esc(x)}</option>`).join("");

const state = { user: null, staff: [], directory: [], view: "dashboard", unread: 0 };
const isStaff = () => state.user && (state.user.role === "admin" || state.user.role === "technician");
const isAdmin = () => state.user && state.user.role === "admin";
const roleLabel = r => (r === "employee" ? "customer" : r);
const homeView = () => (isStaff() ? "dashboard" : "tickets");   // customers have no Overview page
const toLogin = () => { state.user = null; location.replace("/login" + (/^#(new|tickets|kb|dashboard|ticket-\d+)$/.test(location.hash) ? "?next=" + encodeURIComponent("/app" + location.hash) : "")); };

function toast(message) {
  const el = $("#toast"); el.textContent = message; el.classList.add("show");
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove("show"), 3000);
}

async function api(url, options = {}) {
  const headers = { "X-Requested-With": "helpdesk", ...(options.headers || {}) };
  let body = options.body;
  if (body && !(body instanceof FormData)) { headers["Content-Type"] = "application/json"; if (typeof body !== "string") body = JSON.stringify(body); }
  const res = await fetch(url, { credentials: "same-origin", ...options, headers, body });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.startsWith("/api/auth/")) { toLogin(); throw new Error(data.error || "Please sign in"); }
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}
const run = fn => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message); } };

/* ---------- modal ---------- */
function openModal(html, wide = false) {
  $("#modal").className = "modal" + (wide ? " detail-modal" + (typeof wide === "string" ? " " + wide : "") : "");
  $("#modal").innerHTML = html;
  $("#modalBackdrop").classList.add("show"); $("#modalBackdrop").setAttribute("aria-hidden", "false");
  $$("[data-close]", $("#modal")).forEach(b => b.addEventListener("click", closeModal));
}
function closeModal() {
  $("#modalBackdrop").classList.remove("show"); $("#modalBackdrop").setAttribute("aria-hidden", "true");
  if (/^#(ticket|kb)-/.test(location.hash)) history.replaceState(null, "", "#" + state.view);
}
$("#modalBackdrop").addEventListener("click", e => { if (e.target === $("#modalBackdrop")) closeModal(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });
const modalHead = (eyebrow, title) => `<div class="modal-heading"><div><p class="eyebrow">${esc(eyebrow)}</p><h2>${esc(title)}</h2></div><button class="icon-btn" data-close aria-label="Close">×</button></div>`;

/* ---------- badges & small components ---------- */
function slaBadge(t) {
  const s = t.sla, m = s.minutes_to_resolution;
  if (t.status === "Resolved" || t.status === "Closed") return s.resolution === "breached" ? '<span class="pill sla-overdue">SLA missed</span>' : '<span class="pill sla-met">SLA met</span>';
  const late = s.response === "breached" && !t.first_response_at ? ' <span class="pill sla-overdue">No response</span>' : "";
  if (s.resolution === "breached") return `<span class="pill sla-overdue">Overdue ${fmtMins(m)}</span>${late}`;
  if (s.resolution === "at_risk") return `<span class="pill sla-risk">Due in ${fmtMins(m)}</span>${late}`;
  return `<span class="pill sla-ok">Due in ${fmtMins(m)}</span>${late}`;
}
const pill = (kind, v) => `<span class="pill ${kind}-${slug(v)}">${esc(v)}</span>`;
const stars = n => "★".repeat(n) + "☆".repeat(5 - n);
function bars(entries, cls = "") {
  const max = Math.max(1, ...entries.map(e => e[1]));
  return entries.length ? `<div class="breakdown">${entries.map(([label, n]) =>
    `<div class="break-row"><span>${esc(label)}</span><div class="bar ${cls}"><span style="width:${(n / max) * 100}%"></span></div><strong>${n}</strong></div>`).join("")}</div>`
    : '<p class="muted">No data yet.</p>';
}
const stat = (label, value, sub, tone = "purple") => `<article class="stat-card"><div class="stat-top"><span>${esc(label)}</span><span class="stat-icon ${tone}"></span></div><strong>${esc(value)}</strong><small>${esc(sub)}</small></article>`;

// Staff have answered since the requester last opened this ticket (only meaningful to the requester themselves).
const isUnread = t => !!t.unread_reply && t.requester_id === state.user.id;

function ticketTable(tickets) {
  if (!tickets.length) return '<p class="empty">No tickets found.</p>';
  const staff = isStaff();
  return `<div class="table-wrap"><table><thead><tr><th>TICKET</th>${staff ? "<th>REQUESTER</th>" : ""}<th>CATEGORY</th><th>PRIORITY</th><th>STATUS</th><th>ASSIGNED TO</th><th>SLA</th></tr></thead><tbody>
    ${tickets.map(t => `<tr data-ticket="${t.id}" class="${t.sla.overdue ? "row-overdue" : ""} ${isUnread(t) ? "row-unread" : ""}">
      <td>${isUnread(t) ? '<span class="unread-dot" title="New reply"></span>' : ""}<span class="ticket-id">${ref(t.id)}</span>${isUnread(t) ? ' <span class="pill new-reply">New reply</span>' : ""}${t.escalation_level ? ` <span class="pill esc">Escalated L${t.escalation_level}</span>` : ""}<span class="ticket-sub block">${esc(t.title)}</span></td>
      ${staff ? `<td><span class="ticket-title">${esc(t.requester_name)}</span></td>` : ""}
      <td>${esc(t.category)}</td><td>${pill("priority", t.priority)}</td><td>${pill("status", t.status)}</td>
      <td>${esc(t.technician_name || "Unassigned")}</td><td>${slaBadge(t)}</td></tr>`).join("")}
  </tbody></table></div>`;
}
const bindTicketRows = root => $$("tr[data-ticket]", root).forEach(r => r.addEventListener("click", () => showTicket(r.dataset.ticket)));

/* ---------- navigation ---------- */
const STAFF_ROLES = ["admin", "technician"];
const NAV = [
  { id: "dashboard", label: () => "Overview", icon: "▦", roles: STAFF_ROLES },
  { id: "tickets", label: u => (u.role === "employee" ? "My tickets" : "All tickets"), icon: "▤" },
  { id: "kb", label: () => "Knowledge base", icon: "❖" },
  { id: "assets", label: () => "Assets", icon: "▣", roles: STAFF_ROLES },
  { id: "reports", label: () => "Reports", icon: "▥", roles: STAFF_ROLES },
  { id: "users", label: () => "Users", icon: "☺", roles: ["admin"] },
  { id: "sla", label: () => "SLA policies", icon: "◷", roles: ["admin"] },
  { id: "audit", label: () => "Audit log", icon: "≡", roles: ["admin"] },
  { id: "profile", label: () => "Profile", icon: "☺", hidden: true },
  { id: "settings", label: () => "Settings", icon: "⚙", hidden: true }
];
const TITLES = { dashboard: "Dashboard", tickets: "Tickets", kb: "Knowledge base", assets: "IT assets & inventory", reports: "Reports & analytics", users: "User management", sla: "SLA policies", audit: "Audit & email log", profile: "My profile", settings: "Settings" };

function renderNav() {
  const items = NAV.filter(n => !n.hidden && (!n.roles || n.roles.includes(state.user.role)));
  $("#nav").innerHTML = '<p class="nav-label">WORKSPACE</p>' + items.map(n =>
    `<a class="nav-link ${state.view === n.id ? "active" : ""}" href="#${n.id}"><span>${n.icon}</span> ${esc(n.label(state.user))}${n.id === "tickets" ? `<b class="nav-badge" id="unreadBadge" title="Tickets with new replies" ${state.unread ? "" : "hidden"}>${state.unread}</b>` : ""}</a>`).join("");
}
// Customers: count of their tickets with a reply they have not read yet.
async function refreshUnread() {
  if (!state.user || state.user.role !== "employee") return;
  try {
    state.unread = (await api("/api/tickets/unread/count")).count;
    const b = $("#unreadBadge"); if (b) { b.textContent = state.unread; b.hidden = !state.unread; }
  } catch {}
}

async function route() {
  if (!state.user) return;
  const hash = location.hash.slice(1);
  const m = hash.match(/^ticket-(\d+)$/), k = hash.match(/^kb-(\d+)$/);
  if (hash === "new") { history.replaceState(null, "", "#tickets"); await go("tickets", true); return openCreate(); }
  if (m) { if (!$("#view").innerHTML) await go(homeView(), true); return showTicket(m[1]); }
  if (k) { if (state.view !== "kb" || !$("#view").innerHTML) await go("kb", true); return showArticle(k[1]); }
  await go(views[hash] ? hash : homeView());
}
async function go(id, keepHash = false) {
  const allowed = NAV.find(n => n.id === id && (!n.roles || n.roles.includes(state.user.role)));
  if (!allowed) id = homeView();
  state.view = id;
  if (!keepHash && location.hash.slice(1) !== id) history.replaceState(null, "", "#" + id);
  renderNav(); refreshUnread();
  $("#viewTitle").textContent = TITLES[id];
  $("#openCreate").hidden = ["kb", "assets", "profile", "settings"].includes(id);
  $("#view").innerHTML = '<p class="empty">Loading…</p>';
  try { await views[id]($("#view")); } catch (e) { $("#view").innerHTML = `<p class="empty">${esc(e.message)}</p>`; }
}
window.addEventListener("hashchange", route);
const refresh = () => go(state.view, true);

/* ---------- dashboard: widget tiles + charts ---------- */
const views = {};
const DASH_COLORS = { ok: "#4ea72e", risk: "#e8a33d", late: "#c8102e", none: "#cfd4dc" };
const PRIO_COLORS = { Critical: "#e5484d", High: "#f59e0b", Medium: "#3b82f6", Low: "#22b573" };
const isOpenT = t => !isDone(t);
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const slaState = t => (t.sla.resolution === "breached" ? "late" : t.sla.resolution === "at_risk" ? "risk" : "ok");

function donutSvg(entries, total) {
  const R = 70, C = 2 * Math.PI * R; let off = 0;
  const sum = entries.reduce((s, e) => s + e.value, 0) || 1;
  const segs = entries.filter(e => e.value).map(e => {
    const len = (e.value / sum) * C, s = `<circle r="${R}" cx="100" cy="100" fill="none" stroke="${e.color}" stroke-width="38" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}" transform="rotate(-90 100 100)"><title>${esc(e.label)}: ${e.value}</title></circle>`;
    off += len; return s;
  }).join("");
  return `<svg viewBox="0 0 200 200" class="donut" role="img" aria-label="Chart"><circle r="${R}" cx="100" cy="100" fill="none" stroke="#eef1f5" stroke-width="38"/>${segs}<text x="100" y="96" text-anchor="middle" class="donut-t">Total</text><text x="100" y="120" text-anchor="middle" class="donut-n">${total}</text></svg>`;
}
const legend = (entries, total) => `<ul class="chart-legend">${entries.map(e => `<li><i style="background:${e.color}"></i>${esc(e.label)}: ${e.value} (${total ? ((e.value / total) * 100).toFixed(1) : "0.0"}%)</li>`).join("")}</ul>`;

function hbars(rows, max, stackedColors) {
  max = max || Math.max(1, ...rows.map(r => (Array.isArray(r.value) ? r.value.reduce((a, b) => a + b, 0) : r.value)));
  return `<div class="hbars">${rows.map(r => {
    const parts = Array.isArray(r.value) ? r.value : [r.value], cols = stackedColors || [r.color];
    return `<div class="hb-row"><span class="hb-label" title="${esc(r.label)}">${esc(r.label)}</span><div class="hb-track">${parts.map((v, i) => v ? `<b style="width:${(v / max) * 100}%;background:${cols[i] || cols[0]}" title="${v}"></b>` : "").join("")}</div><em>${parts.reduce((a, b) => a + b, 0)}</em></div>`;
  }).join("") || '<p class="muted">No data yet.</p>'}</div>`;
}

function hourlySvg(tickets) {
  const now = new Date(), hrs = Array.from({ length: 24 }, (_, h) => h).filter(h => h <= now.getHours());
  const counts = hrs.map(h => tickets.filter(t => sameDay(t.created_at, now) && new Date(t.created_at).getHours() === h).length);
  const W = 300, H = 140, L = 24, B = 20, max = Math.max(4, ...counts), n = Math.max(1, hrs.length - 1);
  const pt = (i, v) => [L + (i / n) * (W - L - 6), H - B - (v / max) * (H - B - 8)];
  const pts = counts.map((v, i) => pt(i, v)), line = pts.map(p => p.join(",")).join(" ");
  const area = `${pts[0][0]},${H - B} ${line} ${pts[pts.length - 1][0]},${H - B}`;
  const ticks = [0, Math.round(max / 2), max].map(v => `<text x="${L - 5}" y="${pt(0, v)[1] + 3}" text-anchor="end">${v}</text><line x1="${L}" x2="${W}" y1="${pt(0, v)[1]}" y2="${pt(0, v)[1]}" class="grid"/>`).join("");
  const xl = hrs.filter((h, i) => i % Math.ceil(hrs.length / 6) === 0).map(h => `<text x="${pt(hrs.indexOf(h), 0)[0]}" y="${H - 4}" text-anchor="middle">${h % 12 || 12}${h < 12 ? "am" : "pm"}</text>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="linechart" role="img" aria-label="Tickets created per hour today">${ticks}${xl}<polygon points="${area}" fill="#8ccbf0" opacity=".55"/><polyline points="${line}" fill="none" stroke="#1a8fe0" stroke-width="2"/>${pts.map(p => `<circle cx="${p[0]}" cy="${p[1]}" r="2.5" fill="#1a8fe0"/>`).join("")}</svg>`;
}

views.dashboard = async root => {
  const staff = isStaff();
  const all = await api("/api/tickets");
  const me = state.user.id, now = new Date();
  const open = all.filter(isOpenT), today = all.filter(t => sameDay(t.created_at, now));
  const todayDone = today.filter(isDone).length;
  const tiles = [
    ["Tickets I created today", today.filter(t => t.requester_id === me).length],
    ["My assigned tickets", open.filter(t => t.technician_id === me).length],
    ["Unassigned tickets", open.filter(t => !t.technician_id).length],
    ["Open tickets", open.length],
    ["Today's tickets", today.length],
    ["Today's tickets: resolved", (today.length ? Math.round((todayDone / today.length) * 100) : 0) + "%"]
  ];
  const byPrio = PRIORITIES.slice().reverse().map(p => ({ label: p, value: open.filter(t => t.priority === p).length, color: PRIO_COLORS[p] }));
  const slaCount = k => open.filter(t => slaState(t) === k).length;
  const slaEntries = [{ label: "On track", value: slaCount("ok"), color: DASH_COLORS.ok }, { label: "Approaching", value: slaCount("risk"), color: DASH_COLORS.risk }, { label: "Overdue", value: slaCount("late"), color: DASH_COLORS.late }];
  const prioSla = PRIORITIES.slice().reverse().map(p => ({ label: p, value: ["ok", "risk", "late"].map(k => open.filter(t => t.priority === p && slaState(t) === k).length) }));
  const reqMap = {}; open.forEach(t => (reqMap[t.requester_name] = (reqMap[t.requester_name] || 0) + 1));
  const topReq = Object.entries(reqMap).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([label, value]) => ({ label, value, color: "#1a8fe0" }));
  const unassignedLabel = staff ? "my groups" : "mine";
  const PAGE = 9; let page = 1, rows = open.slice().sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));

  root.innerHTML = `
    <section class="dash-tiles">${tiles.map(([l, v]) => `<article class="dash-tile"><span>${esc(l)}</span><strong>${esc(v)}</strong></article>`).join("")}</section>
    <section class="dash-grid">
      <div class="dash-left">
        <div class="panel dash-create">
          <div class="dash-tabs" role="tablist"><button class="on" data-tab="create">Create Ticket</button><button data-tab="tickets">Find Tickets</button><button data-tab="kb">Find Knowledge</button></div>
          <input id="dashQuick" type="text" autocomplete="off" placeholder="Describe the issue and press [Enter]" />
        </div>
        <div class="panel dash-list"><div class="dash-list-head"><h3>Open tickets: recent activity (${unassignedLabel})</h3><span class="muted">${open.length} open</span></div>
          <div id="dashRows"></div><div class="dash-pager" id="dashPager"></div></div>
      </div>
      <div class="dash-mid">
        <div class="panel chart-panel"><h3>Open tickets: priority level</h3>${donutSvg(byPrio, open.length)}${legend(byPrio, open.length)}</div>
      </div>
      <div class="dash-right">
        <div class="panel chart-panel"><h3>Open tickets: SLA</h3>${hbars(slaEntries.map(e => ({ label: e.label, value: e.value, color: e.color })), 0)}</div>
        <div class="panel chart-panel"><h3>Today's tickets: hourly</h3>${hourlySvg(all)}</div>
      </div>
    </section>
    <section class="dash-grid dash-lower">
      <div class="panel chart-panel"><h3>Open tickets: priority, SLA warning</h3>${hbars(prioSla, 0, [DASH_COLORS.ok, DASH_COLORS.risk, DASH_COLORS.late])}</div>
      <div class="panel chart-panel"><h3>Open tickets: top requesters</h3>${hbars(topReq, 0)}</div>
      <div class="panel chart-panel"><h3>Open tickets: SLA warning</h3>${donutSvg(slaEntries, open.length)}${legend(slaEntries, open.length)}</div>
    </section>`;

  const drawRows = () => {
    const slice = rows.slice((page - 1) * PAGE, page * PAGE);
    $("#dashRows").innerHTML = slice.length ? `<div class="table-wrap"><table class="dash-table"><thead><tr><th>Ticket #</th><th>SLA</th><th>Customer</th><th>Subject</th><th>Category</th><th>Priority</th><th>Status</th><th>Last updated ▾</th></tr></thead><tbody>${slice.map(t => `<tr data-ticket="${t.id}"><td><span class="ticket-id">${t.id}</span></td><td><span class="sla-dot" style="background:${DASH_COLORS[slaState(t)]}" title="${esc(slaState(t) === "late" ? "Overdue" : slaState(t) === "risk" ? "Approaching" : "On track")}"></span></td><td>${esc(t.requester_name)}</td><td class="wrap-cell">${esc(t.title)}</td><td>${esc(t.category)}</td><td>${esc(t.priority)}</td><td>${esc(t.status)}</td><td>${esc(fmtDate(t.updated_at))}</td></tr>`).join("")}</tbody></table></div>` : '<p class="empty">No open tickets.</p>';
    bindTicketRows($("#dashRows"));
    const pages = Math.max(1, Math.ceil(rows.length / PAGE)), from = rows.length ? (page - 1) * PAGE + 1 : 0;
    const nums = Array.from({ length: pages }, (_, i) => i + 1).filter(n => n <= 5 || n === pages || Math.abs(n - page) < 2);
    let last = 0;
    $("#dashPager").innerHTML = `<span>${from} - ${Math.min(page * PAGE, rows.length)} of ${rows.length} items</span><nav>${page > 1 ? '<button data-p="prev">Previous</button>' : ""}${nums.map(n => { const gap = last && n - last > 1 ? "<span>…</span>" : ""; last = n; return gap + `<button data-p="${n}" class="${n === page ? "on" : ""}">${n}</button>`; }).join("")}${page < pages ? '<button data-p="next">Next</button>' : ""}</nav>`;
    $$("[data-p]", $("#dashPager")).forEach(b => b.addEventListener("click", () => { const v = b.dataset.p; page = v === "prev" ? page - 1 : v === "next" ? page + 1 : Number(v); drawRows(); }));
  };
  drawRows();

  let tab = "create";
  const hints = { create: "Describe the issue and press [Enter]", tickets: "Search tickets by title, requester or number and press [Enter]", kb: "Search knowledge articles and press [Enter]" };
  $$(".dash-tabs button", root).forEach(b => b.addEventListener("click", () => {
    tab = b.dataset.tab; $$(".dash-tabs button", root).forEach(x => x.classList.toggle("on", x === b));
    $("#dashQuick").placeholder = hints[tab]; $("#dashQuick").focus();
  }));
  $("#dashQuick").addEventListener("keydown", run(async e => {
    if (e.key !== "Enter") return;
    const q = e.target.value.trim(); if (!q && tab !== "create") return;
    if (tab === "create") { await openCreate(); const f = $("#ticketForm [name=title]"); if (f) f.value = q; }
    else if (tab === "tickets") { sessionStorage.setItem("hd_find", q); location.hash = "#tickets"; }
    else if (tab === "kb") { sessionStorage.setItem("hd_kb_search", q); location.hash = "#kb"; }
  }));
};
function techTable(rows) {
  if (!rows.length) return '<p class="empty">No technicians yet.</p>';
  const max = Math.max(1, ...rows.map(r => Number(r.open_tickets ?? r.open_now ?? 0)));
  return `<div class="table-wrap"><table><thead><tr><th>TECHNICIAN</th><th>OPEN WORKLOAD</th><th>RESOLVED</th><th>AVG RESOLUTION</th><th>RATING</th></tr></thead><tbody>${rows.map(r => {
    const open = Number(r.open_tickets ?? r.open_now ?? 0), done = Number(r.resolved_tickets ?? r.resolved ?? 0);
    return `<tr><td><span class="ticket-title">${esc(r.name)}</span>${r.tech_level === 2 ? ' <span class="pill esc">Senior</span>' : ""}</td>
      <td><div class="load"><div class="bar"><span style="width:${(open / max) * 100}%"></span></div><strong>${open}</strong></div></td>
      <td>${done}</td><td>${fmtMins(r.avg_resolution_minutes)}</td><td>${r.avg_rating ? `<span class="stars">${stars(Math.round(r.avg_rating))}</span> ${r.avg_rating}` : '<span class="muted">No ratings</span>'}</td></tr>`;
  }).join("")}</tbody></table></div>`;
}

/* ---------- tickets: board (kanban) + list ---------- */
const BOARD_KEY = "hd_board_v1";
const STATUS_HEX = { Open: "#d94a5b", "In Progress": "#c47b20", Pending: "#3976d8", Resolved: "#15966a", Closed: "#718096" };
const board = (() => {
  const d = { mode: "board", group: "status", sort: "priority", hidden: {}, fields: { desc: true, date: true, priority: true, people: true, tags: true } };
  try { const o = JSON.parse(localStorage.getItem(BOARD_KEY) || "{}"); return { ...d, ...o, fields: { ...d.fields, ...(o.fields || {}) }, hidden: o.hidden || {} }; } catch { return d; }
})();
const saveBoard = () => { try { localStorage.setItem(BOARD_KEY, JSON.stringify(board)); } catch {} };
const collapsedCols = new Set();         // "group:value" keys, this visit only
let ticketTab = "all";

const GROUPS = {
  status:   { label: "Status",   of: t => t.status,   values: () => STATUSES,                      patch: v => ({ status: v }),   color: v => STATUS_HEX[v] },
  priority: { label: "Priority", of: t => t.priority, values: () => PRIORITIES.slice().reverse(),  patch: v => ({ priority: v }), color: v => PRIORITY_FLAG[v] },
  category: { label: "Category", of: t => t.category, values: () => CATEGORIES,                    patch: v => ({ category: v }), color: () => "#3b6a9c" },
  assignee: { label: "Assignee", of: t => t.technician_name || "Unassigned",
    values: tickets => ["Unassigned", ...(isStaff() ? state.staff.map(u => u.name) : [...new Set(tickets.map(t => t.technician_name).filter(Boolean))])],
    patch: v => ({ technician_id: (state.staff.find(u => u.name === v) || {}).id ?? null }), color: v => (v === "Unassigned" ? "#718096" : "#3b6a9c") }
};
const SORTS = {
  priority: ["Priority, then deadline", null],
  deadline: ["Deadline (soonest first)", (a, b) => new Date(a.resolution_due) - new Date(b.resolution_due)],
  newest:   ["Newest first", (a, b) => new Date(b.created_at) - new Date(a.created_at)],
  oldest:   ["Oldest first", (a, b) => new Date(a.created_at) - new Date(b.created_at)],
  updated:  ["Recently updated", (a, b) => new Date(b.updated_at) - new Date(a.updated_at)],
  title:    ["Title (A–Z)", (a, b) => a.title.localeCompare(b.title)]
};
const FIELDS = { desc: "Description", date: "Created date", priority: "Priority stars", people: "People", tags: "Tags & SLA" };
const tint = c => `background:${c}22;color:${c}`;
const isDone = t => t.status === "Resolved" || t.status === "Closed";

function boardCard(t, canDrag) {
  const f = board.fields, staff = isStaff(), unread = isUnread(t), n = PRIORITIES.indexOf(t.priority) + 1, pc = PRIORITY_FLAG[t.priority];
  return `<article class="kcard ${t.sla.overdue ? "overdue" : ""} ${unread ? "unread" : ""}" data-ticket="${t.id}" ${canDrag ? 'draggable="true"' : ""} tabindex="0">
    <h4>${unread ? '<span class="unread-dot" title="New reply"></span>' : ""}${esc(t.title)}</h4>
    <span class="kid">${esc(ref(t.id))}</span>
    ${f.desc ? `<p class="kdesc">${esc(t.description)}</p>` : ""}
    ${f.date ? `<div class="kmeta"><span class="kico">🗓</span>${esc(fmtDay(t.created_at))}</div>` : ""}
    ${f.people ? `<div class="kmeta">${staff ? `<span class="avatar-sm">${esc(initials(t.requester_name))}</span>${esc(t.requester_name)}<span class="karrow">→</span><span class="${t.technician_name ? "" : "muted"}">${esc(t.technician_name || "Unassigned")}</span>`
        : `<span class="kico">🛠</span>${esc(t.technician_name || "Not assigned yet")}`}</div>` : ""}
    ${f.priority ? `<div class="kimp"><span>Priority:</span><span class="kstars">${[1, 2, 3, 4].map(i => `<i style="color:${i <= n ? pc : "#d5dae5"}">★</i>`).join("")}</span><small>${esc(t.priority)}</small></div>` : ""}
    ${f.tags ? `<div class="ktags">${pill("status", t.status)}<span class="pill cat">${esc(t.category)}</span>${t.escalation_level ? `<span class="pill esc">Escalated L${t.escalation_level}</span>` : ""}${unread ? '<span class="pill new-reply">New reply</span>' : ""}${slaBadge(t)}</div>` : ""}
  </article>`;
}

function renderBoard(el, tickets, reload) {
  const g = GROUPS[board.group], staff = isStaff(), canDrag = staff;
  const cmp = SORTS[board.sort][1], sorted = cmp ? tickets.slice().sort(cmp) : tickets;
  const base = g.values(sorted), present = [...new Set(sorted.map(g.of))];
  const vals = [...base, ...present.filter(v => !base.includes(v))];
  const hidden = board.hidden[board.group] || [];
  const preset = v => (board.group === "status" ? { status: v } : board.group === "assignee" ? { technician_id: (state.staff.find(u => u.name === v) || {}).id || "" } : g.patch(v));
  const canAdd = v => staff || board.group !== "status" || v === "Open";

  el.innerHTML = `<div class="board">${vals.filter(v => !hidden.includes(v)).map(v => {
    const items = sorted.filter(t => g.of(t) === v), key = board.group + ":" + v, c = g.color(v);
    return `<section class="kcol ${collapsedCols.has(key) ? "collapsed" : ""}" data-val="${esc(v)}" data-key="${esc(key)}">
      <header class="kcol-head"><button type="button" class="kcol-toggle" aria-label="Collapse or expand ${esc(v)}">⌄</button><span class="kpill" style="${tint(c)}">${esc(v)}</span><span class="kcount">${items.length}</span></header>
      <div class="kcol-body">${items.length ? items.map(t => boardCard(t, canDrag)).join("") : '<p class="kempty">No tickets</p>'}</div>
      ${canAdd(v) ? `<button type="button" class="kadd" data-add="${esc(v)}" aria-label="Create ticket in ${esc(v)}" title="Create ticket">＋</button>` : ""}
    </section>`;
  }).join("") || '<p class="empty">All columns are hidden. Use Columns to show some.</p>'}</div>`;

  $$(".kcard", el).forEach(c => {
    c.addEventListener("click", () => showTicket(c.dataset.ticket));
    c.addEventListener("keydown", e => { if (e.key === "Enter") showTicket(c.dataset.ticket); });
    if (canDrag) {
      c.addEventListener("dragstart", e => { e.dataTransfer.setData("text/plain", c.dataset.ticket); e.dataTransfer.effectAllowed = "move"; setTimeout(() => c.classList.add("dragging"), 0); });
      c.addEventListener("dragend", () => c.classList.remove("dragging"));
    }
  });
  $$(".kcol-toggle", el).forEach(b => b.addEventListener("click", () => { const col = b.closest(".kcol"); col.classList.toggle("collapsed"); collapsedCols[col.classList.contains("collapsed") ? "add" : "delete"](col.dataset.key); }));
  $$(".kadd", el).forEach(b => b.addEventListener("click", () => openCreate(preset(b.dataset.add))));
  if (canDrag) $$(".kcol", el).forEach(col => {
    col.addEventListener("dragover", e => { if ($(".dragging", el)) { e.preventDefault(); col.classList.add("drop-over"); } });
    col.addEventListener("dragleave", e => { if (!col.contains(e.relatedTarget)) col.classList.remove("drop-over"); });
    col.addEventListener("drop", run(async e => {
      e.preventDefault(); col.classList.remove("drop-over");
      const t = tickets.find(x => String(x.id) === e.dataTransfer.getData("text/plain")), v = col.dataset.val;
      if (!t || g.of(t) === v) return;
      await api(`/api/tickets/${t.id}`, { method: "PATCH", body: g.patch(v) });
      toast(`${ref(t.id)} moved to ${v}`); await reload();
    }));
  });
}

views.tickets = async root => {
  const staff = isStaff();
  const TABS = staff
    ? [["all", "All tickets", () => true], ["mine", "Assigned to me", t => t.technician_id === state.user.id], ["unassigned", "Unassigned", t => !t.technician_id], ["overdue", "Overdue", t => t.sla.overdue]]
    : [["all", "All tickets", () => true], ["unread", "New replies", isUnread], ["open", "Open", t => !isDone(t)], ["done", "Resolved", isDone]];
  if (!TABS.some(x => x[0] === ticketTab)) ticketTab = "all";

  root.innerHTML = `<div class="panel board-panel">
    <div class="tab-strip" id="ticketTabs"></div>
    <div class="board-toolbar" id="boardToolbar">
      <div class="seg" role="group" aria-label="View"><button type="button" data-mode="board">▥ Board</button><button type="button" data-mode="list">☰ List</button></div>
      <button type="button" class="tb-btn" id="tbCols">▥ Columns</button>
      <button type="button" class="tb-btn" id="tbFilter">⏷ Filter <b class="tb-count" id="tbFilterCount" hidden></b></button>
      <button type="button" class="tb-btn tb-active" id="tbGroup"></button>
      <button type="button" class="tb-btn" id="tbSort"></button>
      <button type="button" class="tb-btn" id="tbCustom">⚙ Customize</button>
      <span class="tb-spacer"></span>
      ${staff ? '<a class="secondary-btn linklike small" href="/api/reports/export?type=tickets">Export CSV</a>' : ""}
    </div>
    <div class="filters" id="filterBar" hidden><div class="search-box"><span>⌕</span><input id="fSearch" type="search" placeholder="Search by title, requester or number…" /></div>
      <select id="fStatus"><option value="">All statuses</option>${options(STATUSES)}</select>
      <select id="fPriority"><option value="">All priorities</option>${options(PRIORITIES.slice().reverse())}</select>
      <select id="fCategory"><option value="">All categories</option>${options(CATEGORIES)}</select>
      ${staff ? `<select id="fAssigned"><option value="">Anyone</option><option value="me">Assigned to me</option><option value="unassigned">Unassigned</option></select>
      <select id="fSla"><option value="">Any SLA state</option><option value="overdue">Overdue</option><option value="at_risk">Approaching deadline</option></select>` : ""}</div>
    <div id="ticketList"></div><div class="table-footer"><span id="ticketCount"></span><span id="ticketHint"></span></div></div>`;

  let all = [];
  const filterCount = () => $$("#filterBar input, #filterBar select").filter(x => x.value).length;
  const paintToolbar = () => {
    const isBoard = board.mode === "board";
    $$("[data-mode]", root).forEach(b => b.classList.toggle("on", b.dataset.mode === board.mode));
    $("#tbGroup").textContent = `☰ Grouped by ${GROUPS[board.group].label}`;
    $("#tbSort").innerHTML = `⇅ ${board.sort === "priority" ? "Sort" : "1 Sort"}`;
    ["#tbCols", "#tbGroup", "#tbCustom"].forEach(id => ($(id).hidden = !isBoard));
    const fc = filterCount(); $("#tbFilterCount").hidden = !fc; $("#tbFilterCount").textContent = fc;
    $("#tbFilter").classList.toggle("tb-active", !!fc);
    $("#ticketHint").textContent = isBoard ? (staff ? "Drag a card to a column to update it · click to open" : "Click a ticket to open it") : "Click a ticket to open it";
  };
  const render = () => {
    const pred = TABS.find(x => x[0] === ticketTab)[2], shown = all.filter(pred);
    $("#ticketTabs").innerHTML = TABS.map(([id, label, fn]) => `<button type="button" class="tab ${id === ticketTab ? "on" : ""}" data-tab="${id}">${esc(label)}<b>${all.filter(fn).length}</b></button>`).join("");
    if (board.mode === "board") renderBoard($("#ticketList"), shown, load);
    else {
      const cmp = SORTS[board.sort][1];
      $("#ticketList").innerHTML = ticketTable(cmp ? shown.slice().sort(cmp) : shown);
      bindTicketRows($("#ticketList"));
    }
    $("#ticketCount").textContent = `${shown.length} ticket${shown.length === 1 ? "" : "s"}`;
    paintToolbar();
  };
  const load = run(async () => {
    const q = new URLSearchParams({ search: $("#fSearch").value, status: $("#fStatus").value, priority: $("#fPriority").value, category: $("#fCategory").value,
      assigned: staff ? $("#fAssigned").value : "", sla: staff ? $("#fSla").value : "" });
    all = await api("/api/tickets?" + q);
    render();
  });

  /* tabs + view switch */
  $("#ticketTabs").addEventListener("click", e => { const b = e.target.closest("[data-tab]"); if (b) { ticketTab = b.dataset.tab; render(); } });
  $$("[data-mode]", root).forEach(b => b.addEventListener("click", () => { board.mode = b.dataset.mode; saveBoard(); render(); }));

  /* menus */
  const closeMenu = () => { const m = $(".menu", root); if (m) m.remove(); document.removeEventListener("click", outside, true); };
  function outside(e) { if (!e.target.closest(".menu") && !e.target.closest(".tb-btn")) closeMenu(); }
  const openMenu = (btn, html, bind) => {
    const had = $(".menu", root) && $(".menu", root).dataset.for === btn.id; closeMenu(); if (had) return;
    const m = document.createElement("div"); m.className = "menu"; m.dataset.for = btn.id; m.innerHTML = html;
    m.style.left = Math.min(btn.offsetLeft, Math.max(0, $("#boardToolbar").clientWidth - 250)) + "px"; m.style.top = btn.offsetTop + btn.offsetHeight + 6 + "px";
    $("#boardToolbar").append(m); bind(m); setTimeout(() => document.addEventListener("click", outside, true));
  };
  const radios = (name, entries, current) => entries.map(([v, l]) => `<label class="menu-item"><input type="radio" name="${name}" value="${esc(v)}" ${v === current ? "checked" : ""}> ${esc(l)}</label>`).join("");

  $("#tbFilter").addEventListener("click", () => { $("#filterBar").hidden = !$("#filterBar").hidden; if (!$("#filterBar").hidden) $("#fSearch").focus(); });
  $("#tbGroup").addEventListener("click", e => openMenu(e.currentTarget, `<p class="menu-title">Group cards by</p>${radios("grp", Object.entries(GROUPS).map(([k, v]) => [k, v.label]), board.group)}`,
    m => m.addEventListener("change", ev => { board.group = ev.target.value; saveBoard(); closeMenu(); render(); })));
  $("#tbSort").addEventListener("click", e => openMenu(e.currentTarget, `<p class="menu-title">Sort by</p>${radios("srt", Object.entries(SORTS).map(([k, v]) => [k, v[0]]), board.sort)}`,
    m => m.addEventListener("change", ev => { board.sort = ev.target.value; saveBoard(); closeMenu(); render(); })));
  $("#tbCustom").addEventListener("click", e => openMenu(e.currentTarget, `<p class="menu-title">Show on cards</p>${Object.entries(FIELDS).map(([k, l]) => `<label class="menu-item"><input type="checkbox" data-f="${k}" ${board.fields[k] ? "checked" : ""}> ${l}</label>`).join("")}`,
    m => m.addEventListener("change", ev => { board.fields[ev.target.dataset.f] = ev.target.checked; saveBoard(); render(); })));
  $("#tbCols").addEventListener("click", e => {
    const g = GROUPS[board.group], base = g.values(all), present = [...new Set(all.map(g.of))], vals = [...base, ...present.filter(v => !base.includes(v))];
    openMenu(e.currentTarget, `<p class="menu-title">Show columns</p>${vals.map(v => `<label class="menu-item"><input type="checkbox" data-c="${esc(v)}" ${(board.hidden[board.group] || []).includes(v) ? "" : "checked"}> <span class="kpill" style="${tint(g.color(v))}">${esc(v)}</span><small>${all.filter(t => g.of(t) === v).length}</small></label>`).join("")}`,
      m => m.addEventListener("change", ev => {
        const h = new Set(board.hidden[board.group] || []); ev.target.checked ? h.delete(ev.target.dataset.c) : h.add(ev.target.dataset.c);
        board.hidden[board.group] = [...h]; saveBoard(); render();
      }));
  });

  let timer; $("#fSearch").addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(load, 250); });
  $$("#filterBar select").forEach(x => x.addEventListener("change", load));
  const pending = sessionStorage.getItem("hd_find"); sessionStorage.removeItem("hd_find");
  if (pending) { $("#fSearch").value = pending; $("#filterBar").hidden = false; }
  await load();
};

/* ---------- paste / drag-and-drop attachments ---------- */
const FILE_ACCEPT = ".png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.log,.csv,.json";
const dropzoneHtml = id => `<div class="dropzone" data-dropzone>
  <div class="dz-prompt">📎 <strong>Drag &amp; drop</strong> files here, <strong>paste a screenshot</strong> (Ctrl/⌘ + V) or <label class="dz-browse">browse<input type="file" id="${id}" name="files" multiple accept="${FILE_ACCEPT}" hidden /></label></div>
  <div class="dz-list"></div></div>`;

// Makes a dropzone collect files from the picker, drag-and-drop onto `scope`, and pasted images. The collected files are
// mirrored into the real <input type=file>, so the code that uploads `input.files` needs no changes.
function bindDropzone(scope, dz, { max = 5, maxBytes = 5 * 1024 * 1024 } = {}) {
  const input = $("input[type=file]", dz), list = $(".dz-list", dz), files = [], urls = new Map();
  const EXT = /\.(png|jpe?g|gif|webp|pdf|txt|log|csv|json)$/i, stamp = () => new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const urlFor = f => { if (!urls.has(f)) urls.set(f, URL.createObjectURL(f)); return urls.get(f); };

  const sync = () => {
    const dt = new DataTransfer(); files.forEach(f => dt.items.add(f)); input.files = dt.files;
    list.innerHTML = files.map((f, i) => `<div class="dz-item">${f.type.startsWith("image/") ? `<img src="${urlFor(f)}" alt="" />` : '<span class="dz-file">📄</span>'}
      <span class="dz-name">${esc(f.name)}</span><small>${fmtSize(f.size)}</small><button type="button" class="dz-remove" data-rm="${i}" aria-label="Remove ${esc(f.name)}">×</button></div>`).join("");
  };
  const add = incoming => {
    for (let f of incoming) {
      if (files.length >= max) { toast(`You can attach up to ${max} files`); break; }
      // Pasted screenshots arrive as a generic "image.png": give them a meaningful, unique name.
      if (!f.name || /^image\.(png|jpe?g|gif|webp)$/i.test(f.name)) {
        const ext = ({ "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" })[f.type] || "png";
        f = new File([f], `screenshot-${stamp()}${files.length ? "-" + (files.length + 1) : ""}.${ext}`, { type: f.type });
      }
      if (!EXT.test(f.name)) { toast(`${f.name}: file type not allowed`); continue; }
      if (f.size > maxBytes) { toast(`${f.name} is larger than ${Math.round(maxBytes / 1048576)} MB`); continue; }
      if (files.some(x => x.name === f.name && x.size === f.size)) continue;
      files.push(f);
    }
    sync();
  };

  input.addEventListener("change", () => add([...input.files]));
  list.addEventListener("click", e => { const b = e.target.closest("[data-rm]"); if (!b) return; const [f] = files.splice(Number(b.dataset.rm), 1); URL.revokeObjectURL(urls.get(f)); urls.delete(f); sync(); });

  // Paste: only intercept when the clipboard holds an image and no text (a screenshot), so normal text pasting is untouched.
  scope.addEventListener("paste", e => {
    const cd = e.clipboardData; if (!cd || cd.getData("text/plain")) return;
    const imgs = [...cd.items].filter(i => i.kind === "file" && i.type.startsWith("image/")).map(i => i.getAsFile()).filter(Boolean);
    if (!imgs.length) return;
    e.preventDefault(); add(imgs); toast(imgs.length > 1 ? `${imgs.length} screenshots added` : "Screenshot added");
  });
  // Drag and drop anywhere on the form.
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes("Files");
  let depth = 0;
  scope.addEventListener("dragenter", e => { if (hasFiles(e)) { e.preventDefault(); depth++; dz.classList.add("dz-over"); } });
  scope.addEventListener("dragover", e => { if (hasFiles(e)) e.preventDefault(); });
  scope.addEventListener("dragleave", e => { if (hasFiles(e) && --depth <= 0) { depth = 0; dz.classList.remove("dz-over"); } });
  scope.addEventListener("drop", e => { if (!hasFiles(e)) return; e.preventDefault(); depth = 0; dz.classList.remove("dz-over"); add([...e.dataTransfer.files]); });
}

/* ---------- create ticket ---------- */
async function loadStaffLists() {
  if (!isStaff()) return;
  [state.staff, state.directory] = await Promise.all([api("/api/users/technicians"), api("/api/users/directory")]);
}
const openCreate = run(async (preset = {}) => {
  const staff = isStaff();
  const devices = staff ? await api("/api/assets") : await api("/api/assets/mine");
  openModal(`${modalHead("SUPPORT WORKSPACE", "Create a ticket")}
    <form id="ticketForm"><div class="form-grid">
      <label class="full">Issue title<input name="title" required maxlength="180" placeholder="e.g. Laptop cannot connect to Wi-Fi" autocomplete="off" /></label>
      <div class="full kb-suggest" id="kbSuggest" hidden></div>
      <label>Category<select name="category">${options(CATEGORIES, "Other")}</select></label>
      <label>Priority<select name="priority">${options(PRIORITIES, "Medium")}</select></label>
      <label class="full">Description<textarea name="description" required rows="4" maxlength="10000" placeholder="Describe the issue, when it started and any error messages…"></textarea></label>
      <label class="full">Affected device (optional)<select name="asset_id"><option value="">Not sure / none</option>${devices.map(a => `<option value="${a.id}">${esc(a.asset_tag)} · ${esc(a.name)}</option>`).join("")}</select></label>
      ${staff ? `<label>Raised for<select name="requester_id"><option value="">Myself</option>${state.directory.map(u => `<option value="${u.id}">${esc(u.name)}${u.department ? " · " + esc(u.department) : ""}</option>`).join("")}</select></label>
      <label>Assign technician<select name="technician_id"><option value="">Unassigned</option>${state.staff.map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join("")}</select></label>` : ""}
      <div class="full"><span class="dz-title">Attach screenshots or logs <small>(PNG, JPG, PDF, TXT, LOG, CSV, JSON · up to 5 files)</small></span>${dropzoneHtml("createFiles")}</div>
    </div>
    <p class="form-error" id="createError" role="alert"></p>
    <div class="form-actions"><button type="button" class="secondary-btn" data-close>Cancel</button><button class="primary-btn" type="submit">Create ticket</button></div></form>`);

  bindDropzone($("#ticketForm"), $("[data-dropzone]", $("#ticketForm")));
  // Created from a board column: start with that column's value (category / priority / assignee).
  for (const k of ["category", "priority", "technician_id"]) { const el = $(`#ticketForm [name=${k}]`); if (el && preset[k] !== undefined && preset[k] !== null) el.value = preset[k]; }

  // Self-service deflection: suggest knowledge base articles while typing the title.
  let timer;
  $("input[name=title]").addEventListener("input", e => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const term = e.target.value.trim();
      if (term.length < 4) return ($("#kbSuggest").hidden = true);
      try {
        const words = term.split(/\s+/).filter(w => w.length > 3).slice(0, 3);
        const found = new Map();
        for (const w of words) for (const a of await api("/api/kb?search=" + encodeURIComponent(w))) found.set(a.id, a);
        const list = [...found.values()].slice(0, 3);
        $("#kbSuggest").hidden = !list.length;
        $("#kbSuggest").innerHTML = list.length ? `<strong>These guides might fix it:</strong>${list.map(a => `<a href="#kb-${a.id}" target="_blank" rel="noopener">${esc(a.title)}</a>`).join("")}` : "";
      } catch {}
    }, 400);
  });

  $("#ticketForm").addEventListener("submit", async e => {
    e.preventDefault();
    const btn = $("button[type=submit]", e.target); btn.disabled = true;
    try {
      const fd = new FormData(e.target), payload = {};
      for (const [k, v] of fd.entries()) if (k !== "files" && v !== "") payload[k] = v;
      const t = await api("/api/tickets", { method: "POST", body: payload });
      if (staff && preset.status && preset.status !== "Open") { try { await api(`/api/tickets/${t.id}`, { method: "PATCH", body: { status: preset.status } }); } catch {} }
      const files = $("#createFiles").files;
      if (files.length) {
        const up = new FormData(); [...files].slice(0, 5).forEach(f => up.append("files", f));
        try { await api(`/api/tickets/${t.id}/attachments`, { method: "POST", body: up }); }
        catch (err) { toast("Ticket created, but the files were not attached: " + err.message); }
      }
      closeModal(); toast(`Ticket ${ref(t.id)} created`); refresh();
    } catch (err) { $("#createError").textContent = err.message; btn.disabled = false; }
  });
});
$("#openCreate").addEventListener("click", () => openCreate());

/* ---------- ticket detail ---------- */
const timeAgo = v => {
  const m = Math.max(0, Math.round((Date.now() - new Date(v)) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `about ${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
};
const initials = n => String(n || "?").trim().split(/\s+/).map(w => w[0]).slice(0, 2).join("").toUpperCase();
const PRIORITY_FLAG = { Low: "#15966a", Medium: "#3976d8", High: "#e8ad42", Critical: "#d94a5b" };
const miniTickets = list => list.length
  ? `<ul class="tk-links">${list.map(x => `<li><span class="dot status-${slug(x.status)}" title="${esc(x.status)}"></span><a href="#ticket-${x.id}" title="${esc(x.title)}">${esc(x.title)}</a></li>`).join("")}</ul>` : "";
const sideCard = (title, body, open = true) => `<details class="tk-card tk-collapse" ${open ? "open" : ""}><summary>${esc(title)}</summary><div class="tk-card-body">${body}</div></details>`;
const kv = (k, v) => `<div class="tk-kv"><span>${esc(k)}</span><div>${v}</div></div>`;

async function showTicket(id) {
  try {
    const t = await api(`/api/tickets/${id}`);
    history.replaceState(null, "", "#ticket-" + id);
    const staff = isStaff(), mine = t.requester_id === state.user.id, s = t.sla;
    const done = t.status === "Resolved" || t.status === "Closed";
    const prevScroll = $("#modalBackdrop").classList.contains("show") && $("#modal").classList.contains("ticket-modal") ? $("#modal").scrollTop : 0;
    const thread = t.notes.slice().reverse();                       // oldest first
    const publicNotes = t.notes.filter(n => !n.is_internal);
    const lastReplier = publicNotes.length ? publicNotes[0].author : t.requester_name;

    const prop = (label, control) => `<div class="tk-row"><span class="tk-label">${label}</span><div class="tk-control">${control}</div></div>`;
    const statusControl = staff
      ? `<select id="eStatus" class="status-select" data-status="${esc(t.status)}" aria-label="Ticket status">${options(STATUSES, t.status)}</select>`
      : `<span class="status-text" data-status="${esc(t.status)}">${esc(t.status)}</span>`;
    const priorityControl = staff
      ? `<span class="flag" style="color:${PRIORITY_FLAG[t.priority]}">⚑</span><select id="ePriority" aria-label="Priority">${options(PRIORITIES, t.priority)}</select>`
      : `<span class="flag" style="color:${PRIORITY_FLAG[t.priority]}">⚑</span> ${esc(t.priority)}`;
    const techControl = staff
      ? `<select id="eTech" aria-label="Assigned to"><option value="">Unassigned</option>${state.staff.map(u => `<option value="${u.id}" ${t.technician_id === u.id ? "selected" : ""}>${esc(u.name)}${u.tech_level === 2 ? " (senior)" : ""}</option>`).join("")}</select>`
      : esc(t.technician_name || "Unassigned");
    const categoryControl = staff ? `<select id="eCategory" aria-label="Category">${options(CATEGORIES, t.category)}</select>` : esc(t.category);

    const propsCard = `<section class="tk-card tk-props">
        ${prop("Ticket status:", statusControl)}
        ${staff && !done ? '<div class="tk-resolve"><a href="#" id="markResolved">Mark as Resolved</a></div>' : ""}
        ${prop("Category:", categoryControl)}
        ${prop("Priority:", priorityControl)}
        ${prop("Assigned to:", techControl)}
        ${staff ? `<div class="tk-actions">${!done && t.escalation_level < 2 ? '<button type="button" class="secondary-btn small" id="escToggle">▲ Escalate</button>' : ""}${isAdmin() ? '<button type="button" class="danger-btn small" id="delTicket">Delete</button>' : ""}</div>
        <div id="escBox" class="esc-box" hidden><label>Reason for escalation<textarea id="escReason" rows="2" maxlength="500" placeholder="What has been tried and why a senior technician is needed…"></textarea></label>
          <label>Escalate to<select id="escTarget"><option value="">Least busy senior technician</option>${state.staff.filter(u => u.tech_level === 2).map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join("")}</select></label>
          <button class="primary-btn" type="button" id="escGo">Confirm escalation</button></div>` : ""}
      </section>`;

    const detailsCard = sideCard("Ticket Details", [
      kv("Ticket number", esc(ref(t.id))),
      kv("Created on", esc(fmtDate(t.created_at))),
      kv("Updated", esc(fmtDate(t.updated_at))),
      kv("Replies", String(publicNotes.length)),
      kv("Last replier", esc(lastReplier)),
      kv("First response", t.first_response_at ? esc(fmtDate(t.first_response_at)) : `Not yet · due ${esc(fmtDate(t.response_due))}`),
      kv("Due date", `${esc(fmtDate(t.resolution_due))}<br>${slaBadge(t)}`),
      t.escalation_level ? kv("Escalation", `<span class="pill esc">Level ${t.escalation_level}</span>`) : "",
      kv("Device", t.asset_tag ? esc(t.asset_tag + " · " + t.asset_name) : "None linked")
    ].join(""));

    const previousCard = staff ? sideCard("Previous tickets", miniTickets(t.previous_tickets || []) || '<p class="muted">No previous tickets from this requester.</p>') : "";
    const linkedCard = staff ? sideCard("Linked tickets", miniTickets(t.linked_tickets || []) || '<p class="muted">No other tickets for this device.</p>', false) : "";
    const historyCard = staff ? sideCard(`Ticket History (${t.history.length})`, `<div class="history">${t.history.map(h => `<div><span>${esc(fmtDate(h.created_at))}</span><strong>${esc(h.actor)}</strong> ${esc(h.action.replace(/_/g, " "))}${h.details ? `<em>${esc(h.details)}</em>` : ""}</div>`).join("") || '<p class="muted">No history.</p>'}</div>`, false) : "";

    // Replies from staff that arrived after this customer's previous visit.
    const lastSeen = t.previous_viewed_at ? new Date(t.previous_viewed_at) : new Date(0);
    const isNew = n => mine && !n.is_internal && n.author_role !== "employee" && n.author !== t.requester_name && new Date(n.created_at) > lastSeen;
    const message = (author, when, body, extra = "", cls = "") => `<article class="tk-msg ${cls}"><div class="avatar-sm">${esc(initials(author))}</div><div class="tk-msg-body"><header><strong>${esc(author)}</strong>${extra}<small>${esc(fmtDate(when))} · ${esc(timeAgo(when))}</small></header><p class="pre">${esc(body)}</p></div></article>`;

    const closeBox = !staff && mine && t.status === "Resolved"
      ? `<div class="tk-card tk-confirm"><span class="muted">Is the problem fixed?</span><span class="btn-row"><button class="secondary-btn" id="reopen">No, reopen</button><button class="primary-btn" id="closeIt">Yes, close ticket</button></span></div>`
      : !staff && mine && t.status === "Closed" ? `<div class="tk-card tk-confirm"><span class="muted">This ticket is closed.</span><button class="secondary-btn" id="reopen">Reopen ticket</button></div>` : "";

    openModal(`<div class="tk-topbar"><span class="eyebrow">${esc(ref(t.id))} · CREATED ${esc(fmtDate(t.created_at).toUpperCase())}</span>
        <span class="btn-row"><button type="button" class="secondary-btn small" id="printTicket">🖶 Print</button><button class="icon-btn" data-close aria-label="Close">×</button></span></div>
      <div class="tk-layout">
        <div class="tk-main">
          <section class="tk-card tk-original">
            <h2 class="tk-title">${esc(t.title)}</h2>
            <div class="tk-from"><span>From:</span><span class="from-chip"><span class="avatar-sm">${esc(initials(t.requester_name))}</span>${esc(t.requester_name)}</span>${staff ? `<small>&lt;${esc(t.requester_email)}&gt;</small>` : ""}<small>» ${esc(timeAgo(t.created_at))}</small></div>
            <p class="pre tk-text">${esc(t.description)}</p>
            ${t.attachments.length ? `<div class="tk-attachments"><h4>Attachments (${t.attachments.length})</h4><div class="attach-list">${t.attachments.map(a => attachItem(a, staff)).join("")}</div></div>` : ""}
          </section>

          ${thread.length ? `<section class="tk-thread">${thread.map(n => message(n.author, n.created_at, n.note, n.is_internal ? ' <span class="pill internal">Internal note</span>' : (isNew(n) ? ' <span class="pill new-reply">New</span>' : ""), n.is_internal ? "internal" : (n.author_role === "employee" ? "from-customer" : ""))).join("")}</section>` : ""}

          ${renderFeedback(t, mine)}
          ${closeBox}

          ${staff ? `<section class="tk-card tk-note">
            <button type="button" class="secondary-btn" id="noteToggle">📝 Add a note</button>
            <form id="noteForm" hidden><p class="tk-hint">Notes are hidden from customers!</p>
              <textarea name="note" rows="4" required maxlength="5000" placeholder="Record checks performed, findings and the next action…"></textarea>
              <div class="btn-row"><button class="primary-btn" type="submit">Submit note</button></div></form></section>` : ""}

          <section class="tk-card tk-reply">
            <form id="replyForm">
              <label class="tk-label" for="replyText">${staff ? "Reply to customer" : "Reply to the support team"}</label>
              <textarea id="replyText" name="note" rows="5" required maxlength="5000" placeholder="${staff ? "Type your message…" : "Add more information or reply to the technician…"}"></textarea>
              <div class="tk-attachments"><h4>Attachments <small>(PNG, JPG, PDF, TXT, LOG, CSV, JSON · up to 5 files, 5 MB each)</small></h4>${dropzoneHtml("replyFiles")}</div>
              <div class="tk-submit"><button class="primary-btn" type="submit">Submit reply</button>
                ${staff && !done ? '<button class="secondary-btn" type="button" id="replyResolve">Submit &amp; mark resolved</button>' : ""}</div>
            </form></section>
        </div>
        <aside class="tk-side">${propsCard}${detailsCard}${previousCard}${linkedCard}${historyCard}</aside>
      </div>`, "ticket-modal");
    $("#modal").scrollTop = prevScroll;
    bindDropzone($("#replyForm"), $("[data-dropzone]", $("#replyForm")));
    bindTicketDetail(t);
    // Opening your own ticket marks its replies as read: clear the badge in the list behind the modal.
    if (mine) { $$(`tr[data-ticket="${t.id}"]`).forEach(r => { r.classList.remove("row-unread"); $$(".new-reply, .unread-dot", r).forEach(x => x.remove()); }); refreshUnread(); }
  } catch (e) { toast(e.message); if (location.hash.startsWith("#ticket-")) history.replaceState(null, "", "#" + state.view); }
}
function attachItem(a, staff) {
  const img = a.mime_type.startsWith("image/");
  const canDelete = staff || false;
  return `<div class="attach">${img ? `<a href="/api/attachments/${a.id}" target="_blank" rel="noopener"><img class="thumb" src="/api/attachments/${a.id}" alt="${esc(a.original_name)}" loading="lazy" /></a>` : '<div class="thumb file">📄</div>'}
    <div><a href="/api/attachments/${a.id}?download=1">${esc(a.original_name)}</a><small>${fmtSize(a.size_bytes)} · ${esc(a.uploaded_by)} · ${fmtDay(a.created_at)}</small></div>
    ${canDelete ? `<button class="icon-btn small" data-delatt="${a.id}" aria-label="Remove">×</button>` : ""}</div>`;
}
function renderFeedback(t, mine) {
  if (t.feedback) return `<div class="feedback-box"><strong>Customer rating</strong> <span class="stars">${stars(t.feedback.rating)}</span>${t.feedback.comment ? `<p class="pre">${esc(t.feedback.comment)}</p>` : ""}</div>`;
  if (!mine || (t.status !== "Resolved" && t.status !== "Closed")) return "";
  return `<form class="feedback-box" id="fbForm"><strong>How did we do?</strong>
    <div class="rate">${[5, 4, 3, 2, 1].map(n => `<input type="radio" name="rating" id="r${n}" value="${n}" required /><label for="r${n}" title="${n} star${n > 1 ? "s" : ""}">★</label>`).join("")}</div>
    <textarea name="comment" rows="2" maxlength="1000" placeholder="Optional comment"></textarea><button class="secondary-btn" type="submit">Submit feedback</button></form>`;
}
function bindTicketDetail(t) {
  const reload = () => Promise.all([showTicket(t.id), refresh()]);
  const on = (sel, ev, fn) => { const el = $(sel); if (el) el.addEventListener(ev, run(fn)); };
  const patch = body => async () => { await api(`/api/tickets/${t.id}`, { method: "PATCH", body }); toast("Ticket updated."); await reload(); };

  // Staff property changes save as soon as they are picked (colour of the status updates on reload).
  on("#eStatus", "change", e => patch({ status: e.target.value })());
  on("#ePriority", "change", e => patch({ priority: e.target.value })());
  on("#eCategory", "change", e => patch({ category: e.target.value })());
  on("#eTech", "change", e => patch({ technician_id: e.target.value || null })());
  on("#markResolved", "click", e => { e.preventDefault(); return patch({ status: "Resolved" })(); });

  on("#printTicket", "click", () => window.print());
  on("#escToggle", "click", () => { $("#escBox").hidden = !$("#escBox").hidden; });
  on("#escGo", "click", async () => {
    const r = await api(`/api/tickets/${t.id}/escalate`, { method: "POST", body: { reason: $("#escReason").value, technician_id: $("#escTarget").value || null } });
    toast(r.message); await reload();
  });
  on("#delTicket", "click", async () => {
    if (!confirm(`Delete ${ref(t.id)} permanently, including its notes and attachments?`)) return;
    await api(`/api/tickets/${t.id}`, { method: "DELETE" }); closeModal(); toast("Ticket deleted"); refresh();
  });
  on("#closeIt", "click", async () => { await api(`/api/tickets/${t.id}`, { method: "PATCH", body: { status: "Closed" } }); toast("Ticket closed. Thank you!"); await reload(); });
  on("#reopen", "click", async () => { await api(`/api/tickets/${t.id}`, { method: "PATCH", body: { status: "Open" } }); toast("Ticket reopened."); await reload(); });

  // Internal note (staff only, hidden from the customer)
  on("#noteToggle", "click", () => { const f = $("#noteForm"); f.hidden = !f.hidden; if (!f.hidden) f.note.focus(); });
  on("#noteForm", "submit", async e => {
    e.preventDefault();
    await api(`/api/tickets/${t.id}/notes`, { method: "POST", body: { note: e.target.note.value, is_internal: true } });
    toast("Note added."); await reload();
  });

  // Public reply (+ optional attachments, + optional "mark resolved")
  const sendReply = async (resolve = false) => {
    const f = $("#replyForm"), text = f.note.value.trim();
    if (!text) return toast("Please type a message");
    const files = $("#replyFiles").files;
    await api(`/api/tickets/${t.id}/notes`, { method: "POST", body: { note: text, is_internal: false } });
    if (files.length) {
      const fd = new FormData(); [...files].slice(0, 5).forEach(x => fd.append("files", x));
      try { await api(`/api/tickets/${t.id}/attachments`, { method: "POST", body: fd }); }
      catch (err) { toast("Reply sent, but the files were not attached: " + err.message); }
    }
    if (resolve) await api(`/api/tickets/${t.id}`, { method: "PATCH", body: { status: "Resolved" } });
    toast(resolve ? "Reply sent and ticket resolved." : "Reply sent."); await reload();
  };
  on("#replyForm", "submit", async e => { e.preventDefault(); await sendReply(false); });
  on("#replyResolve", "click", () => sendReply(true));

  on("#fbForm", "submit", async e => {
    e.preventDefault();
    const f = e.target;
    await api(`/api/tickets/${t.id}/feedback`, { method: "POST", body: { rating: f.rating.value, comment: f.comment.value } });
    toast("Thanks for your feedback!"); await reload();
  });
  $$("[data-delatt]").forEach(b => b.addEventListener("click", run(async () => {
    if (!confirm("Remove this attachment?")) return;
    await api(`/api/attachments/${b.dataset.delatt}`, { method: "DELETE" }); await showTicket(t.id);
  })));
}

/* ---------- knowledge base ---------- */
const dOnly = v => (v ? String(v).slice(0, 10) : "—");
const KB_CATS = {
  Account:  { title: "Accounts, Access, and Passwords", icon: "M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5zm-3 8V7a3 3 0 0 1 6 0v3z" },
  Hardware: { title: "Hardware and Devices", icon: "M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-6v2h3v2H7v-2h3v-2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm0 2v9h16V6z" },
  Software: { title: "Software and Applications", icon: "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm0 4v10h16V8z" },
  Network:  { title: "Wireless, Networking, and VPN", icon: "M12 18.5a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1 0-3.6zM12 12c2.4 0 4.5.9 6 2.4l-1.8 1.8A6.3 6.3 0 0 0 12 14.5c-1.7 0-3.3.7-4.2 1.7L6 14.4A8.7 8.7 0 0 1 12 12zm0-6c4 0 7.6 1.6 10.2 4.2l-1.8 1.8A12.4 12.4 0 0 0 12 8.5c-3.4 0-6.5 1.4-8.4 3.5L1.8 10.2A15 15 0 0 1 12 6z" },
  Email:    { title: "Email and Calendar", icon: "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm8 7L4.5 6.5v1.8L12 13l7.5-4.7V6.5z" },
  Printing: { title: "Printing and Scanning", icon: "M6 3h12v5H6zM4 9h16a2 2 0 0 1 2 2v6h-4v-3H6v3H2v-6a2 2 0 0 1 2-2zm2 7h12v5H6z" },
  Security: { title: "Security and Safe Computing", icon: "M12 2l8 3v6c0 5-3.4 9.4-8 11-4.6-1.6-8-6-8-11V5zm0 2.2L6 6.5V11c0 3.9 2.4 7.4 6 8.9 3.6-1.5 6-5 6-8.9V6.5z" },
  Training: { title: "Training and How-to Guides", icon: "M12 3L1 9l11 6 9-4.9V17h2V9zM5 13.2v4L12 21l7-3.8v-4L12 17z" },
  Other:    { title: "General IT Help", icon: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-2h2zm0-4h-2V7h2z" }
};
views.kb = async root => {
  root.innerHTML = `<div class="kb-page">
    <div class="filters kb-filters"><div class="search-box"><span>⌕</span><input id="kSearch" type="search" placeholder="Search guides, e.g. wifi, printer, password…" /></div>
      <select id="kCat"><option value="">All categories</option>${options(CATEGORIES)}</select>${isStaff() ? '<button class="primary-btn" id="newArticle" type="button">＋ New article</button>' : ""}</div>
    <div id="kbList"></div></div>`;
  const load = run(async () => {
    const search = $("#kSearch").value.trim(), cat = $("#kCat").value;
    const list = await api("/api/kb?" + new URLSearchParams({ search, category: cat }));
    const groups = CATEGORIES.map(c => [c, list.filter(a => a.category === c)]).filter(([c, items]) => items.length || (!search && (!cat || cat === c)));
    $("#kbList").innerHTML = groups.length ? `<h3 class="kb-sub">Categories (${groups.length})</h3><div class="kb-cats">${groups.map(([c, items]) => {
      const m = KB_CATS[c] || KB_CATS.Other;
      return `<section class="kb-cat"><svg viewBox="0 0 24 24" class="kb-ico" aria-hidden="true"><path d="${m.icon}"/></svg>
        <div><h4>${esc(m.title)}</h4>
        <ul class="kb-links">${!items.length ? '<li class="kb-none">No articles yet</li>' : ''}${items.slice(0, cat ? 999 : 4).map(a => `<li><a href="#kb-${a.id}" data-kb="${a.id}">${esc(a.title)}</a>${a.is_published ? "" : ' <span class="pill internal">Draft</span>'}</li>`).join("")}</ul>
        ${!cat && items.length > 4 ? `<button type="button" class="kb-more" data-cat="${esc(c)}">View all ${items.length} articles…</button>` : ""}</div></section>`;
    }).join("")}</div>` : '<p class="empty">No guides match your search.</p>';
    $$("[data-kb]", $("#kbList")).forEach(a => a.addEventListener("click", e => { e.preventDefault(); showArticle(a.dataset.kb); }));
    $$(".kb-more", $("#kbList")).forEach(b => b.addEventListener("click", () => { $("#kCat").value = b.dataset.cat; load(); }));
  });
  let timer; $("#kSearch").addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(load, 250); });
  $("#kCat").addEventListener("change", load);
  const nb = $("#newArticle"); if (nb) nb.addEventListener("click", () => articleForm());
  const pre = sessionStorage.getItem("hd_kb_search"); sessionStorage.removeItem("hd_kb_search");
  if (pre) $("#kSearch").value = pre;
  await load();
};
const showArticle = run(async id => {
  const a = await api("/api/kb/" + id);
  openModal(`${modalHead(`${a.category.toUpperCase()} · ${a.views + 1} VIEWS`, a.title)}
    <p class="muted">${esc(a.summary || "")}</p><div class="article" id="articleBody"></div>
    <p class="muted">${a.rating_count ? `<span class="stars">${stars(Math.round(a.rating_avg))}</span> ${a.rating_avg}/5 (${a.rating_count}) · ` : "No ratings yet · "}${a.helpful_yes} found helpful, ${a.helpful_no} did not</p>
    <p class="muted">By ${esc(a.author || "IT team")} · updated ${fmtDay(a.updated_at)}</p>
    <div class="form-actions"><span>${isAdmin() ? '<button class="danger-btn" id="delArticle">Delete</button>' : ""}</span>
      <span class="btn-row">${isStaff() ? '<button class="secondary-btn" id="editArticle">Edit</button>' : ""}<button class="primary-btn" data-close>Done</button></span></div>`, true);
  $("#articleBody").append(renderRich(a.content));
  const ed = $("#editArticle"); if (ed) ed.addEventListener("click", () => articleForm(a));
  const del = $("#delArticle");
  if (del) del.addEventListener("click", run(async () => {
    if (!confirm("Delete this article?")) return;
    await api("/api/kb/" + a.id, { method: "DELETE" }); closeModal(); toast("Article deleted"); refresh();
  }));
});
function articleForm(a) {
  openModal(`${modalHead("KNOWLEDGE BASE", a ? "Edit article" : "New article")}
    <form id="kbForm"><div class="form-grid">
      <label class="full">Title<input name="title" required maxlength="200" value="${esc(a?.title || "")}" /></label>
      <label>Category<select name="category">${options(CATEGORIES, a?.category || "Other")}</select></label>
      <label class="check-label">Visibility<select name="is_published"><option value="1" ${a?.is_published === 0 ? "" : "selected"}>Published</option><option value="0" ${a?.is_published === 0 ? "selected" : ""}>Draft (staff only)</option></select></label>
      <label class="full">Short summary<input name="summary" maxlength="300" value="${esc(a?.summary || "")}" /></label>
      <div class="full editor"><span class="lbl">Article content</span>
        <div class="toolbar" role="toolbar" aria-label="Formatting">
          <button type="button" data-fmt="bold" title="Bold"><b>B</b></button><button type="button" data-fmt="italic" title="Italic"><i>I</i></button>
          <button type="button" data-fmt="h" title="Heading">H</button><button type="button" data-fmt="ul" title="Bulleted list">• List</button>
          <button type="button" data-fmt="ol" title="Numbered list">1. List</button><button type="button" data-fmt="link" title="Link">Link</button>
          <button type="button" data-fmt="code" title="Code">&lt;/&gt;</button><button type="button" id="imgBtn" title="Insert an image">Image</button>
          <span class="spacer"></span><button type="button" id="prevTab" class="prev-toggle">Preview</button>
          <input type="file" id="imgFile" accept=".png,.jpg,.jpeg,.gif,.webp" hidden /></div>
        <textarea name="content" required rows="12" maxlength="20000" placeholder="Write steps here. Use the toolbar for bold, lists, links and images.">${esc(a?.content || "")}</textarea>
        <div class="article" id="preview" hidden></div>
        <small class="muted">Formatting: **bold**, *italic*, # Heading, - bullets, 1. steps, [text](https://link), ![alt](image). Images are uploaded with the Image button.</small></div></div>
    <div class="form-actions"><button type="button" class="secondary-btn" data-close>Cancel</button><button class="primary-btn" type="submit">Save article</button></div></form>`, true);
  const ta = $("#kbForm textarea[name=content]");
  const wrap = (before, after = before, ph = "text") => {
    const s = ta.selectionStart, e = ta.selectionEnd, sel = ta.value.slice(s, e) || ph;
    ta.setRangeText(before + sel + after, s, e, "end"); ta.focus();
  };
  const linePrefix = (fn) => {                         // apply a prefix to every selected line
    const s = ta.selectionStart, e = ta.selectionEnd, from = ta.value.lastIndexOf("\n", s - 1) + 1;
    const block = ta.value.slice(from, e || s).split("\n").map(fn).join("\n");
    ta.setRangeText(block, from, e || s, "end"); ta.focus();
  };
  const FMT = {
    bold: () => wrap("**"), italic: () => wrap("*"), code: () => wrap("`", "`", "code"),
    h: () => linePrefix(l => "## " + l.replace(/^#+ /, "")), ul: () => linePrefix(l => "- " + l),
    ol: () => { let n = 0; linePrefix(l => `${++n}. ${l}`); },
    link: () => { const url = prompt("Link address (https://…)"); if (url) wrap("[", `](${url})`, "link text"); }
  };
  $$("[data-fmt]", $("#kbForm")).forEach(b => b.addEventListener("click", () => FMT[b.dataset.fmt]()));
  $("#imgBtn").addEventListener("click", () => $("#imgFile").click());
  $("#imgFile").addEventListener("change", run(async e => {
    const file = e.target.files[0]; if (!file) return;
    const fd = new FormData(); fd.append("image", file);
    const r = await api("/api/kb/images", { method: "POST", body: fd });
    const pos = ta.selectionStart, lead = pos > 0 && ta.value[pos - 1] !== "\n" ? "\n\n" : "";
    wrap(`${lead}![${file.name.replace(/\.[^.]+$/, "").replace(/[\[\]()]/g, "")}](${r.url})`, "\n\n", ""); e.target.value = ""; toast("Image added");
  }));
  $("#prevTab").addEventListener("click", () => {
    const showing = !$("#preview").hidden;
    $("#preview").hidden = showing; ta.hidden = !showing;
    $("#prevTab").textContent = showing ? "Preview" : "Edit";
    $$("[data-fmt],#imgBtn", $("#kbForm")).forEach(b => (b.disabled = !showing));
    if (!showing) $("#preview").replaceChildren(renderRich(ta.value));
  });
  $("#kbForm").addEventListener("submit", run(async e => {
    e.preventDefault();
    const f = e.target, body = { title: f.title.value, category: f.category.value, summary: f.summary.value, content: f.content.value, is_published: f.is_published.value === "1" };
    await api(a ? `/api/kb/${a.id}` : "/api/kb", { method: a ? "PUT" : "POST", body });
    closeModal(); toast("Article saved"); refresh();
  }));
}

/* ---------- assets ---------- */
const ASSET_TYPES = ["Laptop", "Desktop", "Printer", "Monitor", "Network Device", "Phone", "Server", "Other"];
const ASSET_STATUSES = ["Available", "Assigned", "In Repair", "Retired"];
const warranty = v => {
  if (!v) return '<span class="muted">—</span>';
  const days = Math.round((new Date(dOnly(v)) - new Date(new Date().toISOString().slice(0, 10))) / 86400000);
  return `<span class="${days < 0 ? "warn-red" : days <= 60 ? "warn-amber" : ""}">${dOnly(v)}${days < 0 ? " · expired" : days <= 60 ? ` · ${days}d left` : ""}</span>`;
};
views.assets = async root => {
  await loadStaffLists();
  const sum = await api("/api/assets/summary");
  const n = s => sum.byStatus.find(x => x.status === s)?.count || 0;
  root.innerHTML = `<section class="stats-grid stats-wide">${stat("Total assets", sum.byStatus.reduce((a, b) => a + b.count, 0), "In the register")}${stat("Available", n("Available"), "In stock", "green")}${stat("Assigned", n("Assigned"), "In use", "blue")}${stat("In repair", n("In Repair"), "With IT / vendor", "orange")}${stat("Warranty ending", sum.warranty_expiring_60d, "Within 60 days", "amber")}</section>
    <div class="panel"><div class="panel-heading"><div><h3>Device register</h3><p>Computers, printers, monitors and network equipment.</p></div>
      <span class="btn-row"><a class="secondary-btn linklike" href="/api/reports/export?type=assets">Export CSV</a><button class="primary-btn" id="newAsset">＋ Add asset</button></span></div>
    <div class="filters"><div class="search-box"><span>⌕</span><input id="aSearch" type="search" placeholder="Search tag, name, serial or person…" /></div>
      <select id="aStatus"><option value="">All statuses</option>${options(ASSET_STATUSES)}</select><select id="aType"><option value="">All types</option>${options(ASSET_TYPES)}</select></div>
    <div id="assetList"></div></div>`;
  const load = run(async () => {
    const rows = await api("/api/assets?" + new URLSearchParams({ search: $("#aSearch").value, status: $("#aStatus").value, type: $("#aType").value }));
    $("#assetList").innerHTML = rows.length ? `<div class="table-wrap"><table><thead><tr><th>TAG</th><th>DEVICE</th><th>TYPE</th><th>STATUS</th><th>ASSIGNED TO</th><th>LOCATION</th><th>WARRANTY</th><th>TICKETS</th></tr></thead><tbody>
      ${rows.map(a => `<tr data-asset="${a.id}"><td><span class="ticket-id">${esc(a.asset_tag)}</span></td><td><span class="ticket-title">${esc(a.name)}</span><span class="ticket-sub">${esc([a.brand, a.model].filter(Boolean).join(" "))}</span></td>
      <td>${esc(a.type)}</td><td>${pill("astatus", a.status)}</td><td>${esc(a.assigned_name || "—")}</td><td>${esc(a.location || "—")}</td><td>${warranty(a.warranty_expiry)}</td><td>${a.ticket_count}</td></tr>`).join("")}</tbody></table></div>` : '<p class="empty">No assets found.</p>';
    $$("tr[data-asset]", $("#assetList")).forEach(r => r.addEventListener("click", () => showAsset(r.dataset.asset)));
  });
  let timer; $("#aSearch").addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(load, 250); });
  $("#aStatus").addEventListener("change", load); $("#aType").addEventListener("change", load);
  $("#newAsset").addEventListener("click", () => assetForm());
  await load();
};
const showAsset = run(async id => {
  const a = await api("/api/assets/" + id);
  openModal(`${modalHead(`${a.type.toUpperCase()} · ${a.asset_tag}`, a.name)}
    <div class="detail-summary"><div>${pill("astatus", a.status)}</div><p>${esc([a.brand, a.model].filter(Boolean).join(" ") || "No make/model recorded")}${a.serial_number ? " · S/N " + esc(a.serial_number) : ""}</p>${a.notes ? `<p class="pre">${esc(a.notes)}</p>` : ""}</div>
    <div class="detail-meta"><div class="detail-field">ASSIGNED TO<span>${esc(a.assigned_name || "Not assigned")}</span></div><div class="detail-field">LOCATION<span>${esc(a.location || "—")}</span></div>
      <div class="detail-field">PURCHASED<span>${dOnly(a.purchase_date)}</span></div><div class="detail-field">WARRANTY EXPIRES<span>${warranty(a.warranty_expiry)}</span></div></div>
    ${a.status === "Retired" || a.status === "In Repair" ? "" : `<div class="detail-controls"><label>${a.assigned_to ? "Reassign to" : "Assign to"}<select id="assignTo"><option value="">Choose a person…</option>${state.directory.map(u => `<option value="${u.id}">${esc(u.name)}${u.department ? " · " + esc(u.department) : ""}</option>`).join("")}</select></label>
      <div class="btn-row end"><button class="primary-btn" id="assignBtn">Assign</button>${a.assigned_to ? '<button class="secondary-btn" id="returnBtn">Return to stock</button>' : ""}</div></div>`}
    <div class="notes"><h3>Assignment history</h3>${a.history.length ? a.history.map(h => `<div class="note-item"><strong>${esc(h.name)}</strong><small>${fmtDay(h.assigned_at)} → ${h.returned_at ? fmtDay(h.returned_at) : "current"}</small></div>`).join("") : '<p class="muted">Never assigned.</p>'}</div>
    <div class="notes"><h3>Related tickets (${a.tickets.length})</h3>${a.tickets.length ? a.tickets.map(t => `<div class="note-item"><a href="#ticket-${t.id}" data-close>${ref(t.id)}</a> ${esc(t.title)} ${pill("status", t.status)}</div>`).join("") : '<p class="muted">No tickets for this device.</p>'}</div>
    <div class="form-actions"><span>${isAdmin() ? '<button class="danger-btn" id="delAsset">Delete</button>' : ""}</span><span class="btn-row"><button class="secondary-btn" id="editAsset">Edit</button><button class="primary-btn" data-close>Done</button></span></div>`, true);
  $("#editAsset").addEventListener("click", () => assetForm(a));
  const ab = $("#assignBtn");
  if (ab) ab.addEventListener("click", run(async () => {
    const uid = $("#assignTo").value; if (!uid) return toast("Choose a person");
    const r = await api(`/api/assets/${a.id}/assign`, { method: "POST", body: { user_id: uid } }); toast(r.message); await showAsset(a.id); refresh();
  }));
  const rb = $("#returnBtn");
  if (rb) rb.addEventListener("click", run(async () => { await api(`/api/assets/${a.id}/return`, { method: "POST" }); toast("Returned to stock"); await showAsset(a.id); refresh(); }));
  const del = $("#delAsset");
  if (del) del.addEventListener("click", run(async () => {
    if (!confirm("Delete this asset record?")) return;
    await api("/api/assets/" + a.id, { method: "DELETE" }); closeModal(); toast("Asset deleted"); refresh();
  }));
});
function assetForm(a) {
  openModal(`${modalHead("INVENTORY", a ? "Edit asset" : "Add asset")}
    <form id="assetForm"><div class="form-grid">
      <label>Asset tag<input name="asset_tag" required maxlength="40" value="${esc(a?.asset_tag || "")}" placeholder="LAP-0010" /></label>
      <label>Name<input name="name" required maxlength="120" value="${esc(a?.name || "")}" /></label>
      <label>Type<select name="type">${options(ASSET_TYPES, a?.type || "Laptop")}</select></label>
      ${a ? `<label>Status<select name="status">${options(a.assigned_to ? ASSET_STATUSES : ASSET_STATUSES.filter(s => s !== "Assigned"), a.status)}</select></label>` : "<span></span>"}
      <label>Brand<input name="brand" maxlength="80" value="${esc(a?.brand || "")}" /></label><label>Model<input name="model" maxlength="80" value="${esc(a?.model || "")}" /></label>
      <label>Serial number<input name="serial_number" maxlength="100" value="${esc(a?.serial_number || "")}" /></label><label>Location<input name="location" maxlength="120" value="${esc(a?.location || "")}" /></label>
      <label>Purchase date<input name="purchase_date" type="date" value="${a?.purchase_date ? dOnly(a.purchase_date) : ""}" /></label><label>Warranty expiry<input name="warranty_expiry" type="date" value="${a?.warranty_expiry ? dOnly(a.warranty_expiry) : ""}" /></label>
      <label class="full">Notes<textarea name="notes" rows="3" maxlength="2000">${esc(a?.notes || "")}</textarea></label></div>
    <div class="form-actions"><button type="button" class="secondary-btn" data-close>Cancel</button><button class="primary-btn" type="submit">Save asset</button></div></form>`);
  $("#assetForm").addEventListener("submit", run(async e => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    await api(a ? `/api/assets/${a.id}` : "/api/assets", { method: a ? "PATCH" : "POST", body });
    closeModal(); toast("Asset saved"); refresh();
  }));
}

/* ---------- reports ---------- */
views.reports = async root => {
  const r = await api("/api/reports/summary");
  const pct = r.sla_compliance_pct;
  root.innerHTML = `<section class="stats-grid stats-wide">
      ${stat("Total tickets", r.total, "All time")}${stat("Open", r.open, "Not yet resolved", "blue")}${stat("Closed", r.closed, "Resolved or closed", "green")}
      ${stat("Avg resolution", fmtMins(r.avg_resolution_minutes), "Create to resolve")}${stat("Avg first response", fmtMins(r.avg_response_minutes), "Create to first reply")}
      ${stat("SLA compliance", pct === null ? "—" : pct + "%", "Resolved within deadline", pct !== null && pct < 80 ? "red" : "green")}
      ${stat("Customer rating", r.feedback.avg_rating ? r.feedback.avg_rating + " / 5" : "—", `${r.feedback.responses} response${r.feedback.responses === 1 ? "" : "s"}`, "amber")}</section>
    <div class="panel" id="rangeReport"></div>
    <div class="panel export-bar"><div><h3>Export reports</h3><p>Download CSV files for Excel or Google Sheets.</p></div>
      <span class="btn-row"><a class="secondary-btn linklike" href="/api/reports/export?type=tickets">Tickets CSV</a><a class="secondary-btn linklike" href="/api/reports/export?type=technicians">Technician performance CSV</a><a class="secondary-btn linklike" href="/api/reports/export?type=assets">Assets CSV</a></span></div>
    <section class="reports-grid">
      <div class="panel"><div class="panel-heading"><div><h3>Open vs closed</h3></div></div>${bars([["Open", r.open], ["Closed", r.closed]])}</div>
      <div class="panel"><div class="panel-heading"><div><h3>Tickets by category</h3></div></div>${bars(r.byCategory.map(x => [x.category, x.count]))}</div>
      <div class="panel"><div class="panel-heading"><div><h3>Tickets by priority</h3></div></div>${bars(r.byPriority.map(x => [x.priority, x.count]), "prio")}</div>
      <div class="panel"><div class="panel-heading"><div><h3>Last 6 months</h3></div></div>${r.monthly.length ? `<div class="table-wrap"><table><thead><tr><th>MONTH</th><th>CREATED</th><th>RESOLVED</th></tr></thead><tbody>${r.monthly.map(m => `<tr><td>${esc(m.month)}</td><td>${m.created}</td><td>${m.resolved}</td></tr>`).join("")}</tbody></table></div>` : '<p class="muted">No tickets in the last 6 months.</p>'}</div></section>
    <div class="panel"><div class="panel-heading"><div><h3>Most common technical problems</h3><p>Repeated issues are good candidates for a knowledge base article.</p></div></div>
      ${r.topProblems.length ? `<div class="table-wrap"><table><thead><tr><th>PROBLEM</th><th>CATEGORY</th><th>TICKETS</th></tr></thead><tbody>${r.topProblems.map(p => `<tr><td>${esc(p.problem)}</td><td>${esc(p.category)}</td><td>${p.count}</td></tr>`).join("")}</tbody></table></div>` : '<p class="muted">No data yet.</p>'}</div>
    <div class="panel"><div class="panel-heading"><div><h3>Tickets resolved per technician</h3><p>Includes workload, average response and resolution times, overdue items and ratings.</p></div></div>
      ${r.technicians.length ? `<div class="table-wrap"><table><thead><tr><th>TECHNICIAN</th><th>ASSIGNED</th><th>OPEN</th><th>RESOLVED</th><th>OVERDUE</th><th>AVG RESPONSE</th><th>AVG RESOLUTION</th><th>RATING</th></tr></thead><tbody>
      ${r.technicians.map(t => `<tr><td><span class="ticket-title">${esc(t.name)}</span></td><td>${t.assigned_total}</td><td>${t.open_now}</td><td><strong>${t.resolved}</strong></td><td class="${t.overdue_now ? "warn-red" : ""}">${t.overdue_now}</td><td>${fmtMins(t.avg_response_minutes)}</td><td>${fmtMins(t.avg_resolution_minutes)}</td><td>${t.avg_rating ? stars(Math.round(t.avg_rating)) + " " + t.avg_rating : "—"}</td></tr>`).join("")}</tbody></table></div>` : '<p class="muted">No technicians.</p>'}</div>`;
  rangeReport($("#rangeReport", root));
};

function rangeReport(box) {
  const iso = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const now = new Date(), day = n => { const d = new Date(now); d.setDate(d.getDate() - n); return iso(d); };
  const PRESETS = {
    month: ["This month", () => [iso(new Date(now.getFullYear(), now.getMonth(), 1)), iso(now)]],
    last_month: ["Last month", () => [iso(new Date(now.getFullYear(), now.getMonth() - 1, 1)), iso(new Date(now.getFullYear(), now.getMonth(), 0))]],
    d7: ["Last 7 days", () => [day(6), iso(now)]], d30: ["Last 30 days", () => [day(29), iso(now)]],
    year: ["This year", () => [iso(new Date(now.getFullYear(), 0, 1)), iso(now)]], custom: ["Custom range", null]
  };
  const TYPES = { day: "Tickets per day", technician: "Tickets per technician", category: "Tickets per category", priority: "Tickets per priority" };
  const LABEL = { day: "DAY", technician: "TECHNICIAN", category: "CATEGORY", priority: "PRIORITY" };
  box.innerHTML = `<div class="panel-heading"><div><h3>Ticket activity report</h3><p>Pick a period and a breakdown, then run the report.</p></div></div>
    <div class="range-filters">
      <label>Period<select id="rgPreset">${Object.entries(PRESETS).map(([k, v]) => `<option value="${k}">${v[0]}</option>`).join("")}</select></label>
      <label>From<input type="date" id="rgFrom" /></label><label>To<input type="date" id="rgTo" /></label>
      <label>Breakdown<select id="rgType">${Object.entries(TYPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></label>
      <button class="primary-btn" id="rgRun">Run report</button></div>
    <div id="rgOut"></div>`;
  const preset = $("#rgPreset", box), from = $("#rgFrom", box), to = $("#rgTo", box);
  const sync = () => { const p = PRESETS[preset.value]; if (p[1]) { [from.value, to.value] = p[1](); } from.disabled = to.disabled = !p[1]; };
  preset.addEventListener("change", () => { sync(); run(); });
  async function run() {
    const out = $("#rgOut", box);
    try {
      const r = await api(`/api/reports/range?from=${from.value}&to=${to.value}&type=${$("#rgType", box).value}`);
      const max = Math.max(1, ...r.rows.map(x => Math.max(x.created, x.resolved)));
      out.innerHTML = `<div class="range-summary"><strong>${esc(r.from)} → ${esc(r.to)}</strong>
        <span class="chip">New <b>${r.totals.created}</b></span><span class="chip">Resolved <b>${r.totals.resolved}</b></span>
        <span class="chip">Still open <b>${r.totals.still_open}</b></span><span class="chip ${r.totals.overdue ? "chip-red" : ""}">Overdue <b>${r.totals.overdue}</b></span></div>
        ${r.rows.length ? `<div class="table-wrap"><table><thead><tr><th>${LABEL[r.type]}</th><th>NEW</th><th>RESOLVED</th><th>STILL OPEN</th><th>OVERDUE</th><th style="width:30%">NEW vs RESOLVED</th></tr></thead><tbody>
        ${r.rows.map(x => `<tr><td>${esc(r.type === "day" ? new Date(x.label + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" }) : x.label)}</td><td>${x.created}</td><td>${x.resolved}</td><td>${x.still_open}</td><td class="${x.overdue ? "warn-red" : ""}">${x.overdue}</td>
        <td><div class="mini-bar"><i class="mb-new" style="width:${x.created / max * 100}%"></i></div><div class="mini-bar"><i class="mb-res" style="width:${x.resolved / max * 100}%"></i></div></td></tr>`).join("")}</tbody></table></div>` : '<p class="muted">No tickets in this period.</p>'}`;
    } catch (err) { out.innerHTML = `<p class="form-error">${esc(err.message)}</p>`; }
  }
  $("#rgRun", box).addEventListener("click", run);
  sync(); run();
}


/* ---------- profile (everyone) ---------- */
views.profile = async root => {
  const u = await api("/api/auth/profile");
  const level = u.role === "technician" && u.tech_level === 2 ? "Senior technician" : roleLabel(u.role);
  const initials = u.name.split(/\s+/).map(w => w[0]).slice(0, 2).join("").toUpperCase();
  const label = u.role === "employee" ? ["Tickets raised", "Open", "Resolved"] : ["Assigned", "Open", "Resolved"];
  root.innerHTML = `<div class="two-col">
    <section class="panel id-card"><div class="avatar big">${esc(initials)}</div><h3>${esc(u.name)}</h3><p class="muted">${esc(u.email)}</p>
      <span class="pill role-${esc(u.role)}">${esc(level)}</span>
      <div class="mini-stats"><div><strong>${u.stats.total}</strong><small>${label[0].toUpperCase()}</small></div><div><strong>${u.stats.open}</strong><small>${label[1].toUpperCase()}</small></div><div><strong>${u.stats.resolved}</strong><small>${label[2].toUpperCase()}</small></div></div>
      <div class="btn-row" style="margin-top:18px;justify-content:center"><button class="secondary-btn" id="pfPwd" type="button">Change password</button></div></section>
    <section class="panel"><div class="panel-heading"><div><h3>Personal details</h3><p>Your name and department appear on tickets and in reports.</p></div></div>
      <form id="pfForm"><div class="form-grid">
        <label>Full name<input name="name" required maxlength="100" value="${esc(u.name)}" /></label>
        <label>Department<input name="department" maxlength="100" value="${esc(u.department || "")}" /></label>
        <label>Email<input value="${esc(u.email)}" disabled /></label>
        <label>Role<input value="${esc(level)}" disabled /></label></div>
        <p class="form-error" id="pfError" role="alert"></p>
        <div class="form-actions"><button class="primary-btn" type="submit">Save profile</button></div></form>
      <dl class="kv" style="margin-top:14px">
        <div class="row"><dt>Last sign-in</dt><dd>${fmtDate(u.last_login_at)}</dd></div>
        <div class="row"><dt>Member since</dt><dd>${fmtDay(u.created_at)}</dd></div></dl></section></div>`;
  $("#pfPwd", root).addEventListener("click", () => $("#changePwd").click());
  $("#pfForm", root).addEventListener("submit", async e => {
    e.preventDefault(); const f = e.target;
    try {
      const r = await api("/api/auth/profile", { method: "PATCH", body: { name: f.name.value, department: f.department.value } });
      state.user.name = r.name; state.user.department = r.department; paintProfile(); toast("Profile saved"); refresh();
    } catch (err) { $("#pfError").textContent = err.message; }
  });
};

/* ---------- settings: company details (admins edit, staff can read) ---------- */
views.settings = async root => {
  const c = await api("/api/public/company");
  const admin = isAdmin();
  const fields = [["company_name", "Company name", 150, true], ["tagline", "Tagline", 200], ["address", "Address", 300, false, true], ["phone", "Phone", 50], ["email", "Email", 150], ["website", "Website (https://…)", 200], ["support_hours", "Support hours", 200], ["registration_no", "Registration / tax no.", 80]];
  root.innerHTML = `<section class="panel" style="max-width:860px"><div class="panel-heading"><div><h3>Company details</h3><p>Shown in the footer of the help desk, knowledge base and ticket lookup pages.</p></div></div>
    ${admin ? "" : '<p class="ro-note">Only administrators can change company details.</p>'}
    <form id="coForm"><div class="form-grid">${fields.map(([k, l, max, req, full]) => `<label class="${full || k === "tagline" ? "full" : ""}">${esc(l)}<input name="${k}" maxlength="${max}" ${req ? "required" : ""} ${admin ? "" : "disabled"} value="${esc(c[k] || "")}" /></label>`).join("")}</div>
      <p class="form-error" id="coError" role="alert"></p>
      ${admin ? '<div class="form-actions"><button class="primary-btn" type="submit">Save company details</button></div>' : ""}</form></section>`;
  if (!admin) return;
  $("#coForm", root).addEventListener("submit", async e => {
    e.preventDefault();
    try { await api("/api/admin/company", { method: "PUT", body: Object.fromEntries(new FormData(e.target).entries()) }); toast("Company details saved"); }
    catch (err) { $("#coError").textContent = err.message; }
  });
};

/* ---------- users (admin) ---------- */
views.users = async root => {
  const users = await api("/api/users");
  root.innerHTML = `<div class="panel"><div class="panel-heading"><div><h3>Accounts</h3><p>Admins manage everything and create all accounts, technicians work tickets and assets, customers raise and track requests.</p></div><button class="primary-btn" id="newUser">＋ Add user</button></div>
    <div class="table-wrap"><table><thead><tr><th>NAME</th><th>EMAIL</th><th>ROLE</th><th>DEPARTMENT</th><th>STATUS</th><th>LAST SIGN-IN</th></tr></thead><tbody>
    ${users.map(u => `<tr data-user="${u.id}"><td><span class="ticket-title">${esc(u.name)}</span></td><td>${esc(u.email)}</td><td><span class="pill role-${u.role}">${esc(roleLabel(u.role))}</span>${u.role === "technician" && u.tech_level === 2 ? ' <span class="pill esc">Senior</span>' : ""}</td><td>${esc(u.department || "—")}</td>
    <td>${u.is_active ? '<span class="pill sla-ok">Active</span>' : '<span class="pill sla-overdue">Disabled</span>'}</td><td>${fmtDate(u.last_login_at)}</td></tr>`).join("")}</tbody></table></div></div>`;
  $("#newUser").addEventListener("click", () => userForm());
  $$("tr[data-user]", root).forEach(r => r.addEventListener("click", () => userForm(users.find(u => u.id === Number(r.dataset.user)))));
};
function userForm(u) {
  openModal(`${modalHead("ADMINISTRATION", u ? "Edit user" : "Add user")}
    <form id="userForm"><div class="form-grid">
      <label>Full name<input name="name" required maxlength="100" value="${esc(u?.name || "")}" /></label>
      <label>Email<input name="email" type="email" required ${u ? "disabled" : ""} value="${esc(u?.email || "")}" /></label>
      <label>Role<select name="role">${["employee", "technician", "admin"].map(r => `<option value="${r}" ${u?.role === r ? "selected" : ""}>${roleLabel(r)}</option>`).join("")}</select></label>
      <label>Technician level<select name="tech_level"><option value="1" ${u?.tech_level === 2 ? "" : "selected"}>Standard</option><option value="2" ${u?.tech_level === 2 ? "selected" : ""}>Senior (escalation target)</option></select></label>
      <label>Department<input name="department" maxlength="100" value="${esc(u?.department || "")}" /></label>
      ${u ? `<label>Account<select name="is_active"><option value="1" ${u.is_active ? "selected" : ""}>Active</option><option value="0" ${u.is_active ? "" : "selected"}>Disabled</option></select></label>` : "<span></span>"}
      <label class="full">${u ? "Reset password (leave blank to keep)" : "Temporary password"}<input name="password" type="password" minlength="8" ${u ? "" : "required"} autocomplete="new-password" /></label></div>
    <p class="form-error" id="userError" role="alert"></p>
    <div class="form-actions"><button type="button" class="secondary-btn" data-close>Cancel</button><button class="primary-btn" type="submit">Save user</button></div></form>`);
  $("#userForm").addEventListener("submit", async e => {
    e.preventDefault();
    const f = e.target;
    const body = { name: f.name.value, role: f.role.value, tech_level: Number(f.tech_level.value), department: f.department.value };
    if (f.password.value) body.password = f.password.value;
    try {
      if (u) { body.is_active = f.is_active.value === "1"; await api("/api/users/" + u.id, { method: "PATCH", body }); }
      else { body.email = f.email.value; await api("/api/users", { method: "POST", body }); }
      closeModal(); toast("User saved"); refresh();
    } catch (err) { $("#userError").textContent = err.message; }
  });
}

/* ---------- SLA policies (admin) ---------- */
views.sla = async root => {
  const rows = await api("/api/admin/sla");
  root.innerHTML = `<div class="panel"><div class="panel-heading"><div><h3>Response &amp; resolution targets</h3><p>Deadlines are counted from ticket creation. Saving recalculates every open ticket of that priority.</p></div></div>
    <div class="table-wrap"><table><thead><tr><th>PRIORITY</th><th>FIRST RESPONSE (MIN)</th><th>RESOLUTION (MIN)</th><th></th></tr></thead><tbody>
    ${rows.map(r => `<tr data-p="${r.priority}"><td>${pill("priority", r.priority)}</td>
      <td><input class="num" type="number" min="1" name="resp" value="${r.response_minutes}" /> <small class="muted">${fmtMins(r.response_minutes)}</small></td>
      <td><input class="num" type="number" min="1" name="reso" value="${r.resolution_minutes}" /> <small class="muted">${fmtMins(r.resolution_minutes)}</small></td>
      <td><button class="secondary-btn" data-save="${r.priority}">Save</button></td></tr>`).join("")}</tbody></table></div>
    <p class="muted pad">A ticket is "approaching its deadline" during the last 25% of its resolution window. Overdue tickets are escalated automatically and technicians are emailed.</p></div>`;
  $$("[data-save]", root).forEach(b => b.addEventListener("click", run(async () => {
    const tr = b.closest("tr");
    const r = await api("/api/admin/sla/" + b.dataset.save, { method: "PUT", body: { response_minutes: Number($("[name=resp]", tr).value), resolution_minutes: Number($("[name=reso]", tr).value) } });
    toast(r.message);
  })));
};

/* ---------- audit & email log (admin) ---------- */
views.audit = async root => {
  root.innerHTML = `<div class="panel"><div class="panel-heading"><div><h3>Audit log</h3><p>Who changed what, and when. System = automatic action.</p></div>
      <span class="btn-row"><button class="secondary-btn" id="tabAudit">Audit</button><button class="secondary-btn" id="tabMail">Email log</button></span></div>
    <div class="filters" id="auditFilters"><div class="search-box"><span>⌕</span><input id="auSearch" type="search" placeholder="Search action, detail or person…" /></div>
      <select id="auEntity"><option value="">All records</option><option value="ticket">Tickets</option><option value="user">Users</option><option value="asset">Assets</option><option value="kb">Knowledge base</option><option value="sla">SLA</option></select></div>
    <div id="auditList"></div></div>`;
  const loadAudit = run(async () => {
    $("#auditFilters").hidden = false;
    const rows = await api("/api/admin/audit?" + new URLSearchParams({ search: $("#auSearch").value, entity: $("#auEntity").value }));
    $("#auditList").innerHTML = rows.length ? `<div class="table-wrap"><table><thead><tr><th>WHEN</th><th>WHO</th><th>RECORD</th><th>ACTION</th><th>DETAILS</th></tr></thead><tbody>
      ${rows.map(l => `<tr><td>${fmtDate(l.created_at)}</td><td>${esc(l.actor)}</td><td>${esc(l.entity)}${l.entity_id ? " #" + l.entity_id : ""}</td><td>${esc(l.action.replace(/_/g, " "))}</td><td class="wrap-cell">${esc(l.details || "")}</td></tr>`).join("")}</tbody></table></div>` : '<p class="empty">No entries.</p>';
  });
  const loadMail = run(async () => {
    $("#auditFilters").hidden = true;
    const rows = await api("/api/admin/emails");
    $("#auditList").innerHTML = rows.length ? `<div class="table-wrap"><table><thead><tr><th>WHEN</th><th>TO</th><th>SUBJECT</th><th>STATUS</th></tr></thead><tbody>
      ${rows.map(m => `<tr><td>${fmtDate(m.created_at)}</td><td>${esc(m.to_email)}</td><td>${esc(m.subject)}</td><td><span class="pill ${m.status === "sent" ? "sla-ok" : m.status === "failed" ? "sla-overdue" : "sla-risk"}" title="${esc(m.error || "")}">${esc(m.status)}</span></td></tr>`).join("")}</tbody></table></div>
      <p class="muted pad">"logged" means SMTP is not configured, so emails are written to the server console instead of being sent.</p>` : '<p class="empty">No emails yet.</p>';
  });
  let timer; $("#auSearch").addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(loadAudit, 250); });
  $("#auEntity").addEventListener("change", loadAudit); $("#tabAudit").addEventListener("click", loadAudit); $("#tabMail").addEventListener("click", loadMail);
  await loadAudit();
};

/* ---------- account, auth, start-up ---------- */
$("#changePwd").addEventListener("click", () => {
  openModal(`${modalHead("ACCOUNT", "Change password")}
    <form id="pwdForm"><div class="form-grid"><label class="full">Current password<input name="current" type="password" required autocomplete="current-password" /></label>
      <label class="full">New password<input name="next" type="password" minlength="8" required autocomplete="new-password" /></label></div>
    <p class="muted">At least 8 characters, with a letter and a number.</p><p class="form-error" id="pwdError" role="alert"></p>
    <div class="form-actions"><button type="button" class="secondary-btn" data-close>Cancel</button><button class="primary-btn" type="submit">Update password</button></div></form>`);
  $("#pwdForm").addEventListener("submit", async e => {
    e.preventDefault();
    try { await api("/api/auth/change-password", { method: "POST", body: { current_password: e.target.current.value, new_password: e.target.next.value } }); closeModal(); toast("Password updated"); }
    catch (err) { $("#pwdError").textContent = err.message; }
  });
});
const paintProfile = () => {
  const user = state.user;
  $("#profileName").textContent = user.name; $("#profileRole").textContent = user.role === "technician" && user.tech_level === 2 ? "Senior technician" : roleLabel(user.role);
  $("#avatar").textContent = user.name.split(/\s+/).map(w => w[0]).slice(0, 2).join("").toUpperCase();
};
const closeProfileMenu = () => { $("#profileMenu").hidden = true; $("#profileBtn").setAttribute("aria-expanded", "false"); };
$("#profileBtn").addEventListener("click", e => { e.stopPropagation(); const m = $("#profileMenu"); m.hidden = !m.hidden; $("#profileBtn").setAttribute("aria-expanded", String(!m.hidden)); });
$("#profileMenu").addEventListener("click", closeProfileMenu);
document.addEventListener("click", e => { if (!e.target.closest("#profileMenu") && !e.target.closest("#profileBtn")) closeProfileMenu(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") closeProfileMenu(); });
$("#logoutBtn").addEventListener("click", async () => { try { await api("/api/auth/logout", { method: "POST" }); } catch {} state.user = null; location.assign("/"); });

async function showApp(user) {
  if (user.role === "employee") return location.replace("/");   // customers work from the landing page; /app is staff-only
  state.user = user;
  $("#appView").hidden = false;
  paintProfile();
  await loadStaffLists().catch(() => {});
  $(".brand").setAttribute("href", "#" + homeView());
  if (!location.hash || location.hash === "#") history.replaceState(null, "", "#" + homeView());
  await route();
}

(async function init() {
  let me;
  try { me = await api("/api/auth/me"); } catch { return toLogin(); }
  await showApp(me.user);
})();
