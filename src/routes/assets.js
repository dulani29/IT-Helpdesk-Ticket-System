const express = require("express");
const pool = require("../db");
const { requireRole } = require("../auth");
const { audit } = require("../audit");
const httpError = require("../httpError");

const router = express.Router();
const TYPES = ["Laptop", "Desktop", "Printer", "Monitor", "Network Device", "Phone", "Server", "Other"];
const STATUSES = ["Available", "Assigned", "In Repair", "Retired"];
const staff = requireRole("admin", "technician");
const dateOrNull = v => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

// Employees see only the devices assigned to them (used when reporting a problem).
router.get("/mine", async (req, res, next) => {
  try {
    const [rows] = await pool.query("SELECT id, asset_tag, name, type FROM assets WHERE assigned_to = ? ORDER BY name", [req.user.id]);
    res.json(rows);
  } catch (err) { next(err); }
});

router.get("/summary", staff, async (_req, res, next) => {
  try {
    const [byStatus] = await pool.query("SELECT status, COUNT(*) AS count FROM assets GROUP BY status");
    const [byType] = await pool.query("SELECT type, COUNT(*) AS count FROM assets GROUP BY type ORDER BY count DESC");
    const [[w]] = await pool.query(
      "SELECT COUNT(*) AS c FROM assets WHERE status <> 'Retired' AND warranty_expiry IS NOT NULL AND warranty_expiry BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 60 DAY)");
    res.json({ byStatus, byType, warranty_expiring_60d: w.c });
  } catch (err) { next(err); }
});

router.get("/", staff, async (req, res, next) => {
  try {
    const { search = "", status = "", type = "" } = req.query;
    const where = [], params = [];
    if (STATUSES.includes(status)) { where.push("a.status = ?"); params.push(status); }
    if (TYPES.includes(type)) { where.push("a.type = ?"); params.push(type); }
    if (String(search).trim()) {
      const term = `%${String(search).trim()}%`;
      where.push("(a.asset_tag LIKE ? OR a.name LIKE ? OR a.serial_number LIKE ? OR u.name LIKE ?)");
      params.push(term, term, term, term);
    }
    const [rows] = await pool.query(`
      SELECT a.*, u.name AS assigned_name,
        (SELECT COUNT(*) FROM tickets t WHERE t.asset_id = a.id) AS ticket_count
      FROM assets a LEFT JOIN users u ON u.id = a.assigned_to
      ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY a.asset_tag LIMIT 500`, params);
    res.json(rows);
  } catch (err) { next(err); }
});

router.get("/:id", staff, async (req, res, next) => {
  try {
    const [rows] = await pool.query("SELECT a.*, u.name AS assigned_name FROM assets a LEFT JOIN users u ON u.id = a.assigned_to WHERE a.id = ?", [Number(req.params.id) || 0]);
    if (!rows.length) throw httpError(404, "Asset not found");
    const [history] = await pool.query(`
      SELECT aa.assigned_at, aa.returned_at, u.name FROM asset_assignments aa JOIN users u ON u.id = aa.user_id
      WHERE aa.asset_id = ? ORDER BY aa.assigned_at DESC, aa.id DESC`, [rows[0].id]);
    const [tickets] = await pool.query("SELECT id, title, status, created_at FROM tickets WHERE asset_id = ? ORDER BY created_at DESC LIMIT 20", [rows[0].id]);
    res.json({ ...rows[0], history, tickets });
  } catch (err) { next(err); }
});

function validate(b, partial = false) {
  const out = {};
  if (!partial || b.asset_tag !== undefined) { const v = String(b.asset_tag || "").trim(); if (!v || v.length > 40) throw httpError(400, "Asset tag is required (max 40 characters)"); out.asset_tag = v; }
  if (!partial || b.name !== undefined) { const v = String(b.name || "").trim(); if (!v || v.length > 120) throw httpError(400, "Asset name is required"); out.name = v; }
  if (b.type !== undefined) { if (!TYPES.includes(b.type)) throw httpError(400, "Invalid asset type"); out.type = b.type; }
  for (const k of ["brand", "model", "serial_number", "location"]) if (b[k] !== undefined) out[k] = String(b[k]).trim().slice(0, 120) || null;
  if (b.notes !== undefined) out.notes = String(b.notes).trim().slice(0, 2000) || null;
  if (b.purchase_date !== undefined) out.purchase_date = dateOrNull(b.purchase_date);
  if (b.warranty_expiry !== undefined) out.warranty_expiry = dateOrNull(b.warranty_expiry);
  if (b.status !== undefined) { if (!STATUSES.includes(b.status)) throw httpError(400, "Invalid status"); out.status = b.status; }
  return out;
}

router.post("/", staff, async (req, res, next) => {
  try {
    const v = validate(req.body);
    const [dupe] = await pool.query("SELECT id FROM assets WHERE asset_tag = ?", [v.asset_tag]);
    if (dupe.length) throw httpError(409, "That asset tag already exists");
    if (v.status === "Assigned") v.status = "Available"; // assignment goes through the assign action
    const cols = Object.keys(v);
    const [r] = await pool.query(`INSERT INTO assets (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`, cols.map(c => v[c]));
    await audit({ userId: req.user.id, entity: "asset", entityId: r.insertId, action: "asset_created", details: `${v.asset_tag} ${v.name}` });
    res.status(201).json({ id: r.insertId });
  } catch (err) { next(err); }
});

router.patch("/:id", staff, async (req, res, next) => {
  try {
    const id = Number(req.params.id) || 0;
    const [rows] = await pool.query("SELECT * FROM assets WHERE id = ?", [id]);
    if (!rows.length) throw httpError(404, "Asset not found");
    const v = validate(req.body, true);
    if (v.status === "Assigned" && !rows[0].assigned_to) throw httpError(400, "Use Assign to give a device to a person");
    if (v.asset_tag && v.asset_tag !== rows[0].asset_tag) {
      const [dupe] = await pool.query("SELECT id FROM assets WHERE asset_tag = ? AND id <> ?", [v.asset_tag, id]);
      if (dupe.length) throw httpError(409, "That asset tag already exists");
    }
    // Retiring or sending a device for repair while assigned closes the assignment.
    if ((v.status === "Retired" || v.status === "In Repair") && rows[0].assigned_to) {
      await pool.query("UPDATE asset_assignments SET returned_at = NOW() WHERE asset_id = ? AND returned_at IS NULL", [id]);
      v.assigned_to = null;
    }
    if (v.status === "Available" && rows[0].assigned_to) {
      await pool.query("UPDATE asset_assignments SET returned_at = NOW() WHERE asset_id = ? AND returned_at IS NULL", [id]);
      v.assigned_to = null;
    }
    const cols = Object.keys(v);
    if (!cols.length) throw httpError(400, "Nothing to update");
    await pool.query(`UPDATE assets SET ${cols.map(c => `${c} = ?`).join(", ")} WHERE id = ?`, [...cols.map(c => v[c]), id]);
    await audit({ userId: req.user.id, entity: "asset", entityId: id, action: "asset_updated", details: cols.join(", ") });
    res.json({ message: "Asset updated" });
  } catch (err) { next(err); }
});

router.post("/:id/assign", staff, async (req, res, next) => {
  try {
    const id = Number(req.params.id) || 0;
    const [rows] = await pool.query("SELECT * FROM assets WHERE id = ?", [id]);
    if (!rows.length) throw httpError(404, "Asset not found");
    if (rows[0].status === "Retired" || rows[0].status === "In Repair") throw httpError(400, `A device that is ${rows[0].status} cannot be assigned`);
    const [u] = await pool.query("SELECT id, name FROM users WHERE id = ? AND is_active = 1", [Number(req.body.user_id) || 0]);
    if (!u.length) throw httpError(400, "Choose a valid person");
    await pool.query("UPDATE asset_assignments SET returned_at = NOW() WHERE asset_id = ? AND returned_at IS NULL", [id]);
    await pool.query("INSERT INTO asset_assignments (asset_id, user_id) VALUES (?, ?)", [id, u[0].id]);
    await pool.query("UPDATE assets SET assigned_to = ?, status = 'Assigned' WHERE id = ?", [u[0].id, id]);
    await audit({ userId: req.user.id, entity: "asset", entityId: id, action: "asset_assigned", details: `${rows[0].asset_tag} → ${u[0].name}` });
    res.json({ message: `Assigned to ${u[0].name}` });
  } catch (err) { next(err); }
});

router.post("/:id/return", staff, async (req, res, next) => {
  try {
    const id = Number(req.params.id) || 0;
    const [rows] = await pool.query("SELECT * FROM assets WHERE id = ?", [id]);
    if (!rows.length) throw httpError(404, "Asset not found");
    if (!rows[0].assigned_to) throw httpError(400, "This device is not assigned to anyone");
    await pool.query("UPDATE asset_assignments SET returned_at = NOW() WHERE asset_id = ? AND returned_at IS NULL", [id]);
    await pool.query("UPDATE assets SET assigned_to = NULL, status = 'Available' WHERE id = ?", [id]);
    await audit({ userId: req.user.id, entity: "asset", entityId: id, action: "asset_returned", details: rows[0].asset_tag });
    res.json({ message: "Device returned to stock" });
  } catch (err) { next(err); }
});

router.delete("/:id", requireRole("admin"), async (req, res, next) => {
  try {
    const [r] = await pool.query("DELETE FROM assets WHERE id = ?", [Number(req.params.id) || 0]);
    if (!r.affectedRows) throw httpError(404, "Asset not found");
    await audit({ userId: req.user.id, entity: "asset", entityId: Number(req.params.id), action: "asset_deleted" });
    res.json({ message: "Asset deleted" });
  } catch (err) { next(err); }
});

module.exports = router;
