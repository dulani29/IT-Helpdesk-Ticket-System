const express = require("express");
const pool = require("../db");
const { issueToken, clearToken, requireAuth } = require("../auth");
const { passwordProblem, hashPassword, verifyPassword } = require("../password");
const { audit } = require("../audit");

const router = express.Router();
const publicUser = u => ({ id: u.id, name: u.name, email: u.email, role: u.role, tech_level: u.tech_level, department: u.department });

router.post("/login", async (req, res, next) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const [rows] = await pool.query("SELECT * FROM users WHERE email = ?", [email]);
    const user = rows[0];
    const ok = await verifyPassword(password, user && user.password_hash);
    if (!user || !ok || !user.is_active) return res.status(401).json({ error: "Invalid email or password" });
    await pool.query("UPDATE users SET last_login_at = NOW() WHERE id = ?", [user.id]);
    issueToken(res, user);
    await audit({ userId: user.id, entity: "user", entityId: user.id, action: "login" });
    res.json({ user: publicUser(user) });
  } catch (err) { next(err); }
});

router.post("/logout", (req, res) => { clearToken(res); res.json({ message: "Signed out" }); });

router.get("/me", requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

router.get("/profile", requireAuth, async (req, res, next) => {
  try {
    const [[u]] = await pool.query("SELECT id, name, email, role, tech_level, department, last_login_at, created_at FROM users WHERE id = ?", [req.user.id]);
    const [[c]] = await pool.query(
      `SELECT COUNT(*) AS assigned, COALESCE(SUM(status IN ('Open','In Progress','Pending')), 0) AS open_now,
              COALESCE(SUM(status IN ('Resolved','Closed')), 0) AS resolved FROM tickets WHERE ${u.role === "employee" ? "requester_id" : "technician_id"} = ?`, [u.id]);
    res.json({ ...u, stats: { total: Number(c.assigned), open: Number(c.open_now), resolved: Number(c.resolved) } });
  } catch (err) { next(err); }
});

router.patch("/profile", requireAuth, async (req, res, next) => {
  try {
    const name = String(req.body.name || "").trim(), department = String(req.body.department || "").trim();
    if (!name || name.length > 100) return res.status(400).json({ error: "Enter your name (max 100 characters)" });
    if (department.length > 100) return res.status(400).json({ error: "Department is too long" });
    await pool.query("UPDATE users SET name = ?, department = ? WHERE id = ?", [name, department || null, req.user.id]);
    await audit({ userId: req.user.id, entity: "user", entityId: req.user.id, action: "profile_updated" });
    res.json({ name, department });
  } catch (err) { next(err); }
});

router.post("/change-password", requireAuth, async (req, res, next) => {
  try {
    const { current_password, new_password } = req.body;
    const [rows] = await pool.query("SELECT password_hash FROM users WHERE id = ?", [req.user.id]);
    if (!(await verifyPassword(String(current_password || ""), rows[0].password_hash))) return res.status(400).json({ error: "Current password is incorrect" });
    const problem = passwordProblem(new_password);
    if (problem) return res.status(400).json({ error: problem });
    await pool.query("UPDATE users SET password_hash = ? WHERE id = ?", [await hashPassword(new_password), req.user.id]);
    await audit({ userId: req.user.id, entity: "user", entityId: req.user.id, action: "password_changed" });
    res.json({ message: "Password updated" });
  } catch (err) { next(err); }
});

module.exports = router;
