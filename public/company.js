/* Fills the page footer with the company details saved under Settings. */
(async function () {
  const foot = document.getElementById("companyFoot"); if (!foot) return;
  try {
    const res = await fetch("/api/public/company", { credentials: "same-origin", headers: { "X-Requested-With": "helpdesk" } });
    if (!res.ok) return;
    const c = await res.json();
    const mk = (tag, text, attrs = {}) => { const n = document.createElement(tag); n.textContent = text; Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v)); return n; };
    const parts = [];
    if (c.address) parts.push(mk("span", c.address));
    if (c.phone) parts.push(mk("a", c.phone, { href: "tel:" + c.phone.replace(/[^+\d]/g, "") }));
    if (c.email) parts.push(mk("a", c.email, { href: "mailto:" + c.email }));
    if (c.website && /^https?:\/\//i.test(c.website)) parts.push(mk("a", c.website.replace(/^https?:\/\//i, "").replace(/\/$/, ""), { href: c.website, rel: "noopener" }));
    if (c.support_hours) parts.push(mk("span", "Support hours: " + c.support_hours));
    const top = document.createElement("div"); top.className = "foot-company";
    top.append(mk("b", c.company_name || "IT Service Desk"));
    if (c.tagline) top.append(mk("span", " — " + c.tagline));
    const lines = [top];
    if (parts.length) { const l = document.createElement("div"); l.className = "foot-details"; parts.forEach((p, i) => { if (i) l.append(" · "); l.append(p); }); lines.push(l); }
    if (c.registration_no) lines.push(mk("div", "Reg. no. " + c.registration_no, { class: "foot-details" }));
    foot.replaceChildren(...lines);
  } catch { /* keep the default footer */ }
})();
