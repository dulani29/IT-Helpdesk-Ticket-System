/* Knowledge base article page (/kb/:id). All text goes in via textContent (never innerHTML). */
const $ = s => document.querySelector(s);
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) { if (k === "text") n.textContent = v; else if (k === "class") n.className = v; else n.setAttribute(k, v); }
  kids.forEach(k => n.append(k));
  return n;
}
async function getJSON(url, opts = {}) {
  const res = await fetch(url, { credentials: "same-origin", ...opts, headers: { "X-Requested-With": "helpdesk", ...(opts.body ? { "Content-Type": "application/json" } : {}) } });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Request failed");
  return res.json();
}
const stars = avg => { const s = el("span", { class: "rstars", "aria-hidden": "true", text: "★★★★★" }); s.style.setProperty("--p", Math.max(0, Math.min(100, (avg || 0) * 20)) + "%"); return s; };
const fmtDateTime = v => { if (!v) return "—"; const d = new Date(v), p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };

/* search box sends the visitor back to the help desk home with the term filled in */
$("#searchForm").addEventListener("submit", e => {
  e.preventDefault();
  const q = $("#searchInput").value.trim();
  location.assign(q ? "/?search=" + encodeURIComponent(q) : "/");
});
$("#goBack").addEventListener("click", e => { e.preventDefault(); if (document.referrer && new URL(document.referrer).origin === location.origin && history.length > 1) history.back(); else location.assign("/#kb"); });

/* reader feedback: star rating + "was this helpful?" */
function feedbackBox(a, onChange) {
  let current = a;
  const sum = el("span", { class: "fb-note" });
  const pick = el("span", { class: "star-pick", role: "radiogroup", "aria-label": "Rate this article" });
  const yes = el("button", { class: "vote-btn", type: "button" }), no = el("button", { class: "vote-btn", type: "button" });
  const msg = el("span", { class: "fb-note", role: "status" });
  const btns = [1, 2, 3, 4, 5].map(n => el("button", { type: "button", role: "radio", "aria-label": `${n} star${n > 1 ? "s" : ""}`, text: "★" }));
  btns.forEach(b => pick.append(b));
  const paint = n => btns.forEach((b, i) => b.classList.toggle("on", i < n));
  function show(s) {
    current = s; paint(s.my_rating || 0);
    btns.forEach((b, i) => b.setAttribute("aria-checked", String(s.my_rating === i + 1)));
    sum.textContent = s.rating_count ? `Average ${s.rating_avg} out of 5 from ${s.rating_count} rating${s.rating_count === 1 ? "" : "s"}` : "Be the first to rate this article";
    yes.classList.toggle("on", s.my_helpful === true); no.classList.toggle("on", s.my_helpful === false);
    yes.textContent = "Yes" + (s.helpful_yes ? ` (${s.helpful_yes})` : ""); no.textContent = "No" + (s.helpful_no ? ` (${s.helpful_no})` : "");
    if (onChange) onChange(s);
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

function details(a) {
  const list = $("#detailList"); list.replaceChildren();
  const row = (label, ...value) => list.append(el("div", { class: "dr" }, el("dt", { text: label }), el("dd", {}, ...value)));
  row("Article ID:", document.createTextNode(String(a.id)));
  row("Category:", el("a", { href: "/#kb", text: "Knowledgebase" }), ...(a.category ? [document.createTextNode(" · " + a.category)] : []));
  row("Date added:", document.createTextNode(fmtDateTime(a.created_at)));
  row("Views:", document.createTextNode((Number(a.views) + 1).toLocaleString()));
  const rating = el("span", { class: "kb-rating-inline" });
  const paintRating = s => { rating.replaceChildren(...(s.rating_count ? [stars(s.rating_avg), el("small", { text: `(${s.rating_count})` })] : [document.createTextNode("No ratings yet")])); };
  paintRating(a);
  row("Rating (Votes):", rating);
  $("#details").hidden = false;
  return paintRating;
}

(async function init() {
  const id = (location.pathname.match(/^\/kb\/(\d+)/) || [])[1];
  const root = $("#article");
  try {
    const a = await getJSON("/api/public/kb/" + id);
    document.title = a.title + " — Help Desk";
    $("#crumbTitle").textContent = a.title;
    const paintRating = details(a);
    root.replaceChildren(
      el("h1", { text: a.title }),
      ...(a.summary ? [el("p", { class: "art-summary", text: a.summary })] : []),
      el("div", { class: "rich art-body" }, window.renderRich(a.content)),
      feedbackBox(a, paintRating),
      el("div", { class: "art-foot" }, document.createTextNode("Still need help? "), el("a", { href: "/?submit=1", text: "Submit a ticket" })));
    if (a.related && a.related.length) {
      const ul = $("#relatedList");
      a.related.forEach(r => ul.append(el("li", {}, el("a", { href: "/kb/" + r.id, text: r.title }))));
      $("#relatedBox").hidden = false;
    }
  } catch (e) {
    $("#crumbTitle").textContent = "Not found";
    root.replaceChildren(el("h1", { text: "Article not found" }), el("p", { text: "This article does not exist or is no longer published." }), el("p", {}, el("a", { href: "/#kb", text: "Browse the knowledgebase" })));
  }
})();
