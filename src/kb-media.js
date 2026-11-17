// Shared helpers for knowledge base images and reader feedback.
const multer = require("multer");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const pool = require("./db");
const httpError = require("./httpError");

const IMAGE_DIR = path.join(__dirname, "..", "uploads", "kb-images");
fs.mkdirSync(IMAGE_DIR, { recursive: true });

// Allow-list (no SVG: it can carry script). Served with the type we pick, never the client's.
const IMAGE_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const IMAGE_NAME = /^[a-f0-9]{32}\.(png|jpe?g|gif|webp)$/;

const imageUpload = multer({
  storage: multer.diskStorage({
    destination: IMAGE_DIR,
    filename: (_req, file, cb) => cb(null, crypto.randomBytes(16).toString("hex") + path.extname(file.originalname).toLowerCase())
  }),
  limits: { fileSize: Number(process.env.MAX_UPLOAD_MB || 5) * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => IMAGE_TYPES[path.extname(file.originalname).toLowerCase()]
    ? cb(null, true) : cb(httpError(400, "Use a PNG, JPG, GIF or WebP image"))
});
const imageUrl = name => `/api/public/kb-images/${name}`;

// Aggregate reader feedback for one article. Numbers are returned as real numbers (MySQL gives strings for AVG/SUM).
async function feedbackStats(articleId, voterKey) {
  const [[row]] = await pool.query(
    `SELECT ROUND(AVG(rating), 1) AS rating_avg, COUNT(rating) AS rating_count,
            COALESCE(SUM(helpful = 1), 0) AS helpful_yes, COALESCE(SUM(helpful = 0), 0) AS helpful_no
     FROM kb_feedback WHERE article_id = ?`, [articleId]);
  const out = { rating_avg: row.rating_avg === null ? null : Number(row.rating_avg), rating_count: Number(row.rating_count),
    helpful_yes: Number(row.helpful_yes), helpful_no: Number(row.helpful_no), my_rating: null, my_helpful: null };
  if (voterKey) {
    const [mine] = await pool.query("SELECT rating, helpful FROM kb_feedback WHERE article_id = ? AND voter_key = ?", [articleId, voterKey]);
    if (mine.length) { out.my_rating = mine[0].rating; out.my_helpful = mine[0].helpful === null ? null : !!mine[0].helpful; }
  }
  return out;
}

module.exports = { IMAGE_DIR, IMAGE_NAME, IMAGE_TYPES, imageUpload, imageUrl, feedbackStats };
