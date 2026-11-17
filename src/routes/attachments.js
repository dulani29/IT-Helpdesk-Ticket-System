const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const pool = require("../db");
const { audit } = require("../audit");
const httpError = require("../httpError");
const { UPLOAD_DIR, getTicket, canAccess } = require("../tickets-common");
const { isStaff } = require("../auth");

const router = express.Router();
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Allow-list: extension -> mime type we will serve it as (never trust the client's mimetype).
const TYPES = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".pdf": "application/pdf", ".txt": "text/plain", ".log": "text/plain", ".csv": "text/csv", ".json": "application/json"
};
const INLINE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const maxBytes = Number(process.env.MAX_UPLOAD_MB || 5) * 1024 * 1024;

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => cb(null, crypto.randomBytes(16).toString("hex") + path.extname(file.originalname).toLowerCase())
  }),
  limits: { fileSize: maxBytes, files: 5 },
  fileFilter: (_req, file, cb) => {
    if (TYPES[path.extname(file.originalname).toLowerCase()]) cb(null, true);
    else cb(httpError(400, "File type not allowed. Use images, PDF, TXT, LOG, CSV or JSON."));
  }
});

router.post("/tickets/:id/attachments", async (req, res, next) => {
  try {
    const t = await getTicket(req.params.id);
    if (!t || !canAccess(req.user, t)) return res.status(404).json({ error: "Ticket not found" });
    upload.array("files", 5)(req, res, async err => {
      try {
        if (err) {
          const msg = err.code === "LIMIT_FILE_SIZE" ? `Each file must be ${process.env.MAX_UPLOAD_MB || 5} MB or smaller` : err.status ? err.message : "Upload failed";
          return res.status(400).json({ error: msg });
        }
        if (!req.files || !req.files.length) return res.status(400).json({ error: "Choose at least one file" });
        for (const f of req.files) {
          const ext = path.extname(f.originalname).toLowerCase();
          await pool.query(
            "INSERT INTO attachments (ticket_id, user_id, original_name, stored_name, mime_type, size_bytes) VALUES (?, ?, ?, ?, ?, ?)",
            [t.id, req.user.id, path.basename(f.originalname).slice(0, 255), f.filename, TYPES[ext], f.size]);
        }
        await audit({ userId: req.user.id, entity: "ticket", entityId: t.id, ticketId: t.id, action: "attachment_added", details: req.files.map(f => f.originalname).join(", ") });
        res.status(201).json({ message: `${req.files.length} file(s) attached` });
      } catch (e) { next(e); }
    });
  } catch (err) { next(err); }
});

router.get("/attachments/:id", async (req, res, next) => {
  try {
    const [rows] = await pool.query("SELECT * FROM attachments WHERE id = ?", [Number(req.params.id) || 0]);
    const a = rows[0];
    const t = a && (await getTicket(a.ticket_id));
    if (!a || !t || !canAccess(req.user, t)) return res.status(404).json({ error: "File not found" });
    const full = path.join(UPLOAD_DIR, a.stored_name);
    if (!full.startsWith(UPLOAD_DIR + path.sep) || !fs.existsSync(full)) return res.status(404).json({ error: "File not found" });
    res.setHeader("Content-Type", a.mime_type);
    const disposition = INLINE.has(a.mime_type) && req.query.download !== "1" ? "inline" : "attachment";
    res.setHeader("Content-Disposition", `${disposition}; filename*=UTF-8''${encodeURIComponent(a.original_name)}`);
    res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    fs.createReadStream(full).pipe(res);
  } catch (err) { next(err); }
});

router.delete("/attachments/:id", async (req, res, next) => {
  try {
    const [rows] = await pool.query("SELECT * FROM attachments WHERE id = ?", [Number(req.params.id) || 0]);
    const a = rows[0];
    const t = a && (await getTicket(a.ticket_id));
    if (!a || !t || !canAccess(req.user, t)) return res.status(404).json({ error: "File not found" });
    if (!isStaff(req.user) && a.user_id !== req.user.id) return res.status(403).json({ error: "You can only remove your own uploads" });
    await pool.query("DELETE FROM attachments WHERE id = ?", [a.id]);
    fs.unlink(path.join(UPLOAD_DIR, a.stored_name), () => {});
    await audit({ userId: req.user.id, entity: "ticket", entityId: t.id, ticketId: t.id, action: "attachment_removed", details: a.original_name });
    res.json({ message: "Attachment removed" });
  } catch (err) { next(err); }
});

module.exports = router;
