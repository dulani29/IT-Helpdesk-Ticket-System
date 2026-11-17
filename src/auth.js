const jwt = require("jsonwebtoken");
const pool = require("./db");

const COOKIE = "hd_token";
const isProd = process.env.NODE_ENV === "production";

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 16 || s.startsWith("change_me")) {
    if (isProd) throw new Error("Set a strong JWT_SECRET in .env before running in production");
    console.warn("WARNING: weak/missing JWT_SECRET. Set one in .env (see .env.example).");
    return s || "dev-only-insecure-secret";
  }
  return s;
}

function issueToken(res, user) {
  const hours = Number(process.env.JWT_EXPIRES_HOURS || 8);
  const token = jwt.sign({ sub: user.id }, secret(), { expiresIn: `${hours}h` });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.COOKIE_SECURE === "true",
    maxAge: hours * 3600 * 1000
  });
}

function clearToken(res) { res.clearCookie(COOKIE, { httpOnly: true, sameSite: "strict", secure: process.env.COOKIE_SECURE === "true" }); }

// Loads the user from the DB on every request so deactivation / role changes apply immediately.
async function requireAuth(req, res, next) {
  try {
    const token = req.cookies && req.cookies[COOKIE];
    if (!token) return res.status(401).json({ error: "Please sign in" });
    let payload;
    try { payload = jwt.verify(token, secret()); } catch { return res.status(401).json({ error: "Session expired. Please sign in again." }); }
    const [rows] = await pool.query(
      "SELECT id, name, email, role, tech_level, department, is_active FROM users WHERE id = ?", [payload.sub]);
    if (!rows.length || !rows[0].is_active) return res.status(401).json({ error: "Account is not available" });
    req.user = rows[0];
    next();
  } catch (err) { next(err); }
}

const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : res.status(403).json({ error: "You do not have permission to do that" });

const isStaff = user => user.role === "admin" || user.role === "technician";

// Basic CSRF defence on top of SameSite=Strict: state-changing calls must carry a custom header
// that a cross-site form post cannot set.
function csrfGuard(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (req.get("X-Requested-With") !== "helpdesk") return res.status(403).json({ error: "Missing request header" });
  next();
}

module.exports = { issueToken, clearToken, requireAuth, requireRole, isStaff, csrfGuard };
