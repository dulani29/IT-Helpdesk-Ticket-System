require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const path = require("path");
const pool = require("./src/db");
const { requireAuth, requireRole, csrfGuard } = require("./src/auth");
const { startScheduler } = require("./src/scheduler");
const { migrate } = require("./src/migrate");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const isProd = process.env.NODE_ENV === "production";

if (isProd) app.set("trust proxy", 1); // running behind a reverse proxy / PaaS load balancer

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:"],   // blob: = previews of pasted / dropped screenshots
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: process.env.COOKIE_SECURE === "true" ? [] : null // only force HTTPS when deployed behind TLS
    }
  }
}));
// Reply-by-email webhook: mounted before the global body parser and CSRF guard (providers send their own body formats).
app.use("/api/inbound", require("./src/routes/inbound"));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

// Pages: "/" is the public help desk landing page, "/login" the sign-in page, "/app" the signed-in portal
// (customers see their tickets, staff get the administration panel).
const page = file => (_req, res) => res.sendFile(path.join(__dirname, "public", file));
app.get("/", page("index.html"));
app.get("/login", page("login.html"));
app.get("/track", page("track.html"));
app.get("/kb/:id(\\d+)", page("article.html"));
app.get("/app", page("app.html"));
app.use(express.static(path.join(__dirname, "public"), { index: false }));
app.use("/api", csrfGuard);

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: "Too many attempts. Please wait 15 minutes and try again." } });
const publicLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false,
  message: { error: "Too many requests. Please slow down." } });

app.get("/api/health", async (_req, res) => {
  try { await pool.query("SELECT 1"); res.json({ status: "ok", database: "connected" }); }
  catch { res.status(503).json({ status: "degraded", database: "unreachable" }); }
});

app.use("/api/auth/login", loginLimiter);
app.use("/api/auth", require("./src/routes/auth"));
app.use("/api/public", publicLimiter, require("./src/routes/public")); // landing page knowledge base, no sign-in needed

// Everything below needs a signed-in user.
app.use("/api", requireAuth);
app.use("/api/users", require("./src/routes/users"));
app.use("/api/tickets", require("./src/routes/tickets"));
app.use("/api", require("./src/routes/attachments"));
app.use("/api", require("./src/routes/reports"));
app.use("/api/assets", require("./src/routes/assets"));
app.use("/api/kb", require("./src/routes/kb"));
app.use("/api/admin", requireRole("admin"), require("./src/routes/admin"));

app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));

app.use((err, _req, res, _next) => {
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid JSON" });
  console.error(err);
  res.status(500).json({ error: "Something went wrong. Check the server and database configuration." });
});

if (require.main === module) {
  migrate().catch(err => console.error("Database upgrade check failed:", err.message)).finally(() => {
    app.listen(PORT, () => {
      console.log(`IT Service Management System running at http://localhost:${PORT}`);
      startScheduler();
    });
  });
}
module.exports = app;
