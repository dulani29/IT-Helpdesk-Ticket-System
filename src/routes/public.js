// Public (no sign-in) endpoints for the landing page: published knowledge base, reader feedback, guest ticket lookup.
const express = require("express");
const crypto = require("crypto");
const pool = require("../db");
const httpError = require("../httpError");
const { categories } = require("../tickets-common");
const { IMAGE_DIR, IMAGE_NAME, IMAGE_TYPES, feedbackStats } = require("../kb-media");
const path = require("path");
const rateLimit = require("express-rate-limit");

const router = express.Router();

const VOTER_COOKIE = "kb_voter";
const validVoter = v => typeof v === "string" && /^[a-f0-9]{32}$/.test(v);
// Anonymous readers get a random id cookie so they can change (not stack) their rating / helpful vote.
function voterFor(req, res) {
  let v = req.cookies && req.cookies[VOTER_COOKIE];
  if (!validVoter(v)) {
    v = crypto.randomBytes(16).toString("hex");
    res.cookie(VOTER_COOKIE, v, { httpOnly: true, sameSite: "lax", secure: process.env.COOKIE_SECURE === "true", maxAge: 365 * 24 * 3600 * 1000 });
  }
  return v;
}

const RATING_SQL = `
  (SELECT ROUND(AVG(f.rating), 1) FROM kb_feedback f WHERE f.article_id = k.id) AS rating_avg,
  (SELECT COUNT(f.rating) FROM kb_feedback f WHERE f.article_id = k.id) AS rating_count`;

// GET /api/public/kb?sort=top|latest&search=&category=&limit=5
router.get("/kb", async (req, res, next) => {
  try {
    const { sort = "top", search = "", category = "" } = req.query;
    const limit = Math.min(Math.max(Number(req.query.limit) || 5, 1), 100);
    const where = ["k.is_published = 1"], params = [];
    if (categories.includes(category)) { where.push("k.category = ?"); params.push(category); }
    const term = String(search).trim().slice(0, 100);
    if (term) {
      const like = `%${term}%`;
      where.push("(k.title LIKE ? OR k.summary LIKE ? OR k.content LIKE ?)");
      params.push(like, like, like);
    }
    const order = sort === "latest" ? "k.created_at DESC, k.id DESC" : "k.views DESC, k.title";
    const [rows] = await pool.query(
      `SELECT k.id, k.title, k.category, k.summary, k.views, k.created_at, k.updated_at, ${RATING_SQL}
       FROM kb_articles k WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ?`, [...params, limit]);
    res.json(rows.map(r => ({ ...r, rating_avg: r.rating_avg === null ? null : Number(r.rating_avg), rating_count: Number(r.rating_count) })));
  } catch (err) { next(err); }
});

router.get("/kb/:id", async (req, res, next) => {
  try {
    const id = Number(req.params.id) || 0;
    const [rows] = await pool.query(
      "SELECT k.id, k.title, k.category, k.summary, k.content, k.views, k.created_at, k.updated_at, u.name AS author FROM kb_articles k LEFT JOIN users u ON u.id = k.author_id WHERE k.id = ? AND k.is_published = 1", [id]);
    if (!rows.length) throw httpError(404, "Article not found");
    pool.query("UPDATE kb_articles SET views = views + 1 WHERE id = ?", [id]).catch(() => {});
    const voter = req.cookies && validVoter(req.cookies[VOTER_COOKIE]) ? req.cookies[VOTER_COOKIE] : null;
    const [related] = await pool.query(
      "SELECT id, title FROM kb_articles WHERE is_published = 1 AND id <> ? ORDER BY (category = ?) DESC, views DESC, title LIMIT 5", [id, rows[0].category]);
    res.json({ ...rows[0], related, ...(await feedbackStats(id, voter)) });
  } catch (err) { next(err); }
});

// Company details shown in page footers (editable by admins under Settings).
router.get("/company", async (_req, res, next) => {
  try {
    const [rows] = await pool.query("SELECT company_name, tagline, address, phone, email, website, support_hours, registration_no FROM company_settings WHERE id = 1");
    res.json(rows[0] || { company_name: "IT Service Desk" });
  } catch (err) { next(err); }
});

// Reader feedback: 1-5 star rating and a "was this helpful?" vote. Tighter limit than reads.
const voteLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false,
  message: { error: "Too many votes from this address. Try again later." } });

async function vote(req, res, next, column, value) {
  try {
    const id = Number(req.params.id) || 0;
    const [rows] = await pool.query("SELECT id FROM kb_articles WHERE id = ? AND is_published = 1", [id]);
    if (!rows.length) throw httpError(404, "Article not found");
    const voter = voterFor(req, res);
    await pool.query(
      `INSERT INTO kb_feedback (article_id, voter_key, ${column}) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE ${column} = VALUES(${column})`,
      [id, voter, value]);
    res.json(await feedbackStats(id, voter));
  } catch (err) { next(err); }
}
router.post("/kb/:id/rating", voteLimiter, (req, res, next) => {
  const r = Number(req.body.rating);
  if (!Number.isInteger(r) || r < 1 || r > 5) return res.status(400).json({ error: "Choose 1 to 5 stars" });
  vote(req, res, next, "rating", r);
});
router.post("/kb/:id/helpful", voteLimiter, (req, res, next) => {
  if (typeof req.body.helpful !== "boolean") return res.status(400).json({ error: "Answer yes or no" });
  vote(req, res, next, "helpful", req.body.helpful ? 1 : 0);
});

// Images embedded in articles. Random names, allow-listed extensions, served with a fixed image type.
router.get("/kb-images/:name", (req, res) => {
  const name = req.params.name;
  if (!IMAGE_NAME.test(name)) return res.status(404).json({ error: "Not found" });
  res.type(IMAGE_TYPES[path.extname(name)]);
  res.set({ "X-Content-Type-Options": "nosniff", "Cache-Control": "public, max-age=86400", "Cross-Origin-Resource-Policy": "same-origin" });
  res.sendFile(name, { root: IMAGE_DIR }, err => { if (err && !res.headersSent) res.status(404).json({ error: "Not found" }); });
});

// Guest ticket lookup: ticket number + the requester's email. Both must match, and every miss gets the same answer
// so the form cannot be used to discover which ticket numbers or emails exist. Internal notes are never returned.
const trackLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 15, standardHeaders: true, legacyHeaders: false,
  message: { error: "Too many lookups. Please wait 15 minutes and try again." } });
const NOT_FOUND = "We couldn't find a ticket with that number and email address. Check both and try again.";

router.post("/track", trackLimiter, async (req, res, next) => {
  try {
    const m = String(req.body.ticket || "").trim().match(/^#?(?:HD-?)?0*(\d{1,9})$/i);
    const email = String(req.body.email || "").trim().toLowerCase();
    if (!m || !email || email.length > 150) return res.status(404).json({ error: NOT_FOUND });
    const [rows] = await pool.query(
      `SELECT t.id, t.title, t.description, t.category, t.priority, t.status, t.created_at, t.updated_at, t.resolved_at, tech.name AS technician_name
       FROM tickets t JOIN users req ON req.id = t.requester_id LEFT JOIN users tech ON tech.id = t.technician_id
       WHERE t.id = ? AND LOWER(req.email) = ?`, [Number(m[1]), email]);
    if (!rows.length) return res.status(404).json({ error: NOT_FOUND });
    const [notes] = await pool.query(
      `SELECT n.note, n.created_at, COALESCE(u.name, 'System') AS author, (u.role IN ('admin','technician')) AS from_staff
       FROM ticket_notes n LEFT JOIN users u ON u.id = n.user_id
       WHERE n.ticket_id = ? AND n.is_internal = 0 ORDER BY n.created_at ASC, n.id ASC`, [rows[0].id]);
    res.json({ ticket: rows[0], notes: notes.map(n => ({ ...n, from_staff: !!n.from_staff })) });
  } catch (err) { next(err); }
});

module.exports = router;
