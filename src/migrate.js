const pool = require("./db");

// Runs at start-up so existing databases pick up new tables without a manual step. Safe to run every time.
async function migrate() {
  // Add the extra knowledge base / ticket categories to databases created before they existed.
  const ENUM = "ENUM('Hardware','Software','Network','Account','Email','Printing','Security','Training','Other') NOT NULL DEFAULT 'Other'";
  for (const table of ["tickets", "kb_articles"]) {
    const [col] = await pool.query("SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'category'", [table]);
    if (col.length && !String(col[0].t).includes("'Training'")) await pool.query(`ALTER TABLE ${table} MODIFY category ${ENUM}`);
  }
  await pool.query(`CREATE TABLE IF NOT EXISTS company_settings (
    id TINYINT PRIMARY KEY DEFAULT 1,
    company_name VARCHAR(150) NOT NULL DEFAULT 'IT Service Desk',
    tagline VARCHAR(200) NULL, address VARCHAR(300) NULL, phone VARCHAR(50) NULL, email VARCHAR(150) NULL,
    website VARCHAR(200) NULL, support_hours VARCHAR(200) NULL, registration_no VARCHAR(80) NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);
  await pool.query("INSERT IGNORE INTO company_settings (id, company_name) VALUES (1, 'IT Service Desk')");
  const [existing] = await pool.query("SHOW TABLES LIKE 'ticket_reads'");
  await pool.query(`CREATE TABLE IF NOT EXISTS ticket_reads (
    ticket_id INT NOT NULL,
    user_id INT NOT NULL,
    last_viewed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (ticket_id, user_id),
    CONSTRAINT fk_read_ticket FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
    CONSTRAINT fk_read_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  // First run on an existing database: treat every current reply as already seen so customers
  // are not greeted by a wall of "New reply" badges for old conversations.
  if (!existing.length) await pool.query("INSERT IGNORE INTO ticket_reads (ticket_id, user_id, last_viewed_at) SELECT id, requester_id, NOW() FROM tickets");
}

module.exports = { migrate };
