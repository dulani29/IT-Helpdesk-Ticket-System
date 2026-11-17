const express = require("express");
const pool = require("../db");
const { requireRole, isStaff } = require("../auth");
const { passwordProblem, hashPassword } = require("../password");
const { audit } = require("../audit");

const router = express.Router();
const ROLES = ["admin", "technician", "employee"];
const emailOk = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 150;

// Technicians (and admins) available for assignment: any staff member may read this list.
router.get("/technicians", async (req, res, next) => {
  try {
    if (!isStaff(req.user)) return res.status(403).json({ error: "You do not have permission to do that" });
    const [rows] = await pool.query(
      "SELECT id, name, email, tech_level FROM users WHERE role IN ('technician','admin') AND is_active = 1 ORDER BY name");
    res.json(rows);
  } catch (err) { next(err); }
});

// Name list for staff pickers (log a ticket for someone, assign a device). No emails or roles exposed.
router.get("/directory", async (req, res, next) => {
  try {
    if (!isStaff(req.user)) return res.status(403).json({ error: "You do not have permission to do that" });
    const [rows] = await pool.query("SELECT id, name, department FROM users WHERE is_active = 1 ORDER BY name");
    res.json(rows);
  } catch (err) { next(err); }
});

router.get("/", requireRole("admin"), async (_req, res, next) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, name, email, role, tech_level, department, is_active, last_login_at, created_at FROM users ORDER BY role, name");
    res.json(rows);
  } catch (err) { next(err); }
});

router.post("/", requireRole("admin"), async (req, res, next) => {
  try {
    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const role = req.body.role;
    if (!name || name.length > 100) return res.status(400).json({ error: "Enter a name" });
    if (!emailOk(email)) return res.status(400).json({ error: "Enter a valid email" });
    if (!ROLES.includes(role)) return res.status(400).json({ error: "Invalid role" });
    const problem = passwordProblem(req.body.password);
    if (problem) return res.status(400).json({ error: problem });
    const [dupe] = await pool.query("SELECT id FROM users WHERE email = ?", [email]);
    if (dupe.length) return res.status(409).json({ error: "That email is already in use" });
    const level = Number(req.body.tech_level) === 2 ? 2 : 1;
    const [r] = await pool.query(
      "INSERT INTO users (name, email, password_hash, role, tech_level, department) VALUES (?, ?, ?, ?, ?, ?)",
      [name, email, await hashPassword(req.body.password), role, level, String(req.body.department || "").trim().slice(0, 100) || null]);
    await audit({ userId: req.user.id, entity: "user", entityId: r.insertId, action: "user_created", details: `${email} as ${role}` });
    res.status(201).json({ id: r.insertId });
  } catch (err) { next(err); }
});

router.patch("/:id", requireRole("admin"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const [rows] = await pool.query("SELECT * FROM users WHERE id = ?", [id]);
    if (!rows.length) return res.status(404).json({ error: "User not found" });
    const b = req.body, sets = [], vals = [], changes = [];
    if (b.name !== undefined) { const n = String(b.name).trim(); if (!n || n.length > 100) return res.status(400).json({ error: "Invalid name" }); sets.push("name = ?"); vals.push(n); }
    if (b.department !== undefined) { sets.push("department = ?"); vals.push(String(b.department).trim().slice(0, 100) || null); }
    if (b.role !== undefined) {
      if (!ROLES.includes(b.role)) return res.status(400).json({ error: "Invalid role" });
      if (id === req.user.id && b.role !== "admin") return res.status(400).json({ error: "You cannot remove your own admin role" });
      sets.push("role = ?"); vals.push(b.role); changes.push(`role=${b.role}`);
    }
    if (b.tech_level !== undefined) { sets.push("tech_level = ?"); vals.push(Number(b.tech_level) === 2 ? 2 : 1); changes.push(`level=${b.tech_level}`); }
    if (b.is_active !== undefined) {
      if (id === req.user.id && !b.is_active) return res.status(400).json({ error: "You cannot deactivate your own account" });
      sets.push("is_active = ?"); vals.push(b.is_active ? 1 : 0); changes.push(`active=${b.is_active ? 1 : 0}`);
    }
    if (b.password) {
      const problem = passwordProblem(b.password);
      if (problem) return res.status(400).json({ error: problem });
      sets.push("password_hash = ?"); vals.push(await hashPassword(b.password)); changes.push("password reset");
    }
    if (!sets.length) return res.status(400).json({ error: "Nothing to update" });
    await pool.query(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`, [...vals, id]);
    await audit({ userId: req.user.id, entity: "user", entityId: id, action: "user_updated", details: changes.join(", ") });
    res.json({ message: "User updated" });
  } catch (err) { next(err); }
});

module.exports = router;
