/* Sign-in page. Customers and staff share it; the portal at /app shows the right workspace for the role. */
const form = document.getElementById("loginForm");
const errBox = document.getElementById("loginError");
const btn = document.getElementById("loginBtn");

// Only ever redirect to a page inside the portal (prevents open redirects through ?next=).
function nextUrl() {
  const n = new URLSearchParams(location.search).get("next") || "";
  return /^\/app(#[a-z0-9-]+)?$/i.test(n) ? n : "/app";
}
const call = (url, opts = {}) => fetch(url, { credentials: "same-origin", ...opts, headers: { "X-Requested-With": "helpdesk", "Content-Type": "application/json" } });

// Already signed in? Skip the form.
const destination = user => (user && user.role === "employee" ? "/" : nextUrl());   // customers use the landing page, staff the panel
call("/api/auth/me").then(async r => { if (r.ok) location.replace(destination((await r.json()).user)); }).catch(() => {});

form.addEventListener("submit", async e => {
  e.preventDefault(); errBox.textContent = "";
  const email = form.email.value.trim(), password = form.password.value;
  if (!email || !password) { errBox.textContent = "Enter your email and password."; return; }
  btn.disabled = true; btn.textContent = "Signing in…";
  try {
    const res = await call("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Sign in failed");
    location.assign(destination(data.user));
  } catch (err) {
    errBox.textContent = err.message; btn.disabled = false; btn.textContent = "Sign in"; form.password.select();
  }
});
