const express = require("express");
const pool = require("../db");
const { requireRole, isStaff } = require("../auth");
const { audit } = require("../audit");
const httpError = require("../httpError");
const { categories } = require("../tickets-common");
const { feedbackStats, imageUpload, imageUrl } = require("../kb-media");

const router = express.Router();
const staff = requireRole("admin", "technician");

router.get("/", async (req, res, next) => {
  try {
    const { search = "", category = "" } = req.query;
    const where = [], params = [];
    if (!isStaff(req.user)) where.push("k.is_published = 1");
    if (categories.includes(category)) { where.push("k.category = ?"); params.push(category); }
    if (String(search).trim()) {
      const term = `%${String(search).trim()}%`;
      where.push("(k.title LIKE ? OR k.summary LIKE ? OR k.content LIKE ?)");
      params.push(term, term, term);
    }
    const [rows] = await pool.query(`
      SELECT k.id, k.title, k.category, k.summary, k.is_published, k.views, k.updated_at,
        (SELECT ROUND(AVG(f.rating), 1) FROM kb_feedback f WHERE f.article_id = k.id) AS rating_avg,
        (SELECT COUNT(f.rating) FROM kb_feedback f WHERE f.article_id = k.id) AS rating_count
      FROM kb_articles k ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY k.views DESC, k.title LIMIT 200`, params);
    res.json(rows);
  } catch (err) { next(err); }
});

router.get("/:id", async (req, res, next) => {
  try {
    const id = Number(req.params.id) || 0;
    const [rows] = await pool.query(
      "SELECT k.*, u.name AS author FROM kb_articles k LEFT JOIN users u ON u.id = k.author_id WHERE k.id = ?", [id]);
    const a = rows[0];
    if (!a || (!a.is_published && !isStaff(req.user))) throw httpError(404, "Article not found");
    pool.query("UPDATE kb_articles SET views = views + 1 WHERE id = ?", [id]).catch(() => {});
    res.json({ ...a, ...(await feedbackStats(id)) });
  } catch (err) { next(err); }
});

// Staff upload an image to embed in an article. Returns a URL to paste into the article as ![alt](url).
router.post("/images", staff, (req, res, next) => {
  imageUpload.single("image")(req, res, err => {
    if (err) return res.status(400).json({ error: err.code === "LIMIT_FILE_SIZE" ? "Image must be 5 MB or smaller" : err.status ? err.message : "Upload failed" });
    if (!req.file) return res.status(400).json({ error: "Choose an image" });
    audit({ userId: req.user.id, entity: "kb", action: "kb_image_uploaded", details: req.file.originalname.slice(0, 120) }).catch(() => {});
    res.status(201).json({ url: imageUrl(req.file.filename) });
  });
});

function validate(b) {
  const title = String(b.title || "").trim(), content = String(b.content || "").trim();
  if (!title || title.length > 200) throw httpError(400, "Title is required (max 200 characters)");
  if (!content || content.length > 20000) throw httpError(400, "Content is required");
  if (b.category !== undefined && !categories.includes(b.category)) throw httpError(400, "Invalid category");
  return { title, content, category: b.category || "Other", summary: String(b.summary || "").trim().slice(0, 300) || null, is_published: b.is_published === false || b.is_published === 0 ? 0 : 1 };
}

router.post("/", staff, async (req, res, next) => {
  try {
    const v = validate(req.body);
    const [r] = await pool.query(
      "INSERT INTO kb_articles (title, category, summary, content, author_id, is_published) VALUES (?, ?, ?, ?, ?, ?)",
      [v.title, v.category, v.summary, v.content, req.user.id, v.is_published]);
    await audit({ userId: req.user.id, entity: "kb", entityId: r.insertId, action: "kb_created", details: v.title });
    res.status(201).json({ id: r.insertId });
  } catch (err) { next(err); }
});

router.put("/:id", staff, async (req, res, next) => {
  try {
    const id = Number(req.params.id) || 0, v = validate(req.body);
    const [r] = await pool.query(
      "UPDATE kb_articles SET title = ?, category = ?, summary = ?, content = ?, is_published = ? WHERE id = ?",
      [v.title, v.category, v.summary, v.content, v.is_published, id]);
    if (!r.affectedRows) throw httpError(404, "Article not found");
    await audit({ userId: req.user.id, entity: "kb", entityId: id, action: "kb_updated", details: v.title });
    res.json({ message: "Article saved" });
  } catch (err) { next(err); }
});

router.delete("/:id", requireRole("admin"), async (req, res, next) => {
  try {
    const [r] = await pool.query("DELETE FROM kb_articles WHERE id = ?", [Number(req.params.id) || 0]);
    if (!r.affectedRows) throw httpError(404, "Article not found");
    await audit({ userId: req.user.id, entity: "kb", entityId: Number(req.params.id), action: "kb_deleted" });
    res.json({ message: "Article deleted" });
  } catch (err) { next(err); }
});

module.exports = router;
