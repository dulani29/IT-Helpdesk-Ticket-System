-- IT Service Management & Infrastructure Support System
-- Run: mysql -u root -p < schema.sql   (or: npm run db:init)
CREATE DATABASE IF NOT EXISTS helpdesk_db
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE helpdesk_db;

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(150) NOT NULL UNIQUE,
  password_hash VARCHAR(100) NOT NULL,
  role ENUM('admin','technician','employee') NOT NULL DEFAULT 'employee',
  tech_level TINYINT NOT NULL DEFAULT 1 COMMENT '1 = standard technician, 2 = senior technician (escalation target)',
  department VARCHAR(100) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  last_login_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sla_policies (
  priority ENUM('Low','Medium','High','Critical') PRIMARY KEY,
  response_minutes INT NOT NULL,
  resolution_minutes INT NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS company_settings (
  id TINYINT PRIMARY KEY DEFAULT 1,
  company_name VARCHAR(150) NOT NULL DEFAULT 'IT Service Desk',
  tagline VARCHAR(200) NULL,
  address VARCHAR(300) NULL,
  phone VARCHAR(50) NULL,
  email VARCHAR(150) NULL,
  website VARCHAR(200) NULL,
  support_hours VARCHAR(200) NULL,
  registration_no VARCHAR(80) NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
INSERT IGNORE INTO company_settings (id, company_name) VALUES (1, 'IT Service Desk');

CREATE TABLE IF NOT EXISTS assets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  asset_tag VARCHAR(40) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  type ENUM('Laptop','Desktop','Printer','Monitor','Network Device','Phone','Server','Other') NOT NULL DEFAULT 'Other',
  brand VARCHAR(80) NULL,
  model VARCHAR(80) NULL,
  serial_number VARCHAR(100) NULL,
  status ENUM('Available','Assigned','In Repair','Retired') NOT NULL DEFAULT 'Available',
  assigned_to INT NULL,
  location VARCHAR(120) NULL,
  purchase_date DATE NULL,
  warranty_expiry DATE NULL,
  notes TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_asset_user FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS asset_assignments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  asset_id INT NOT NULL,
  user_id INT NOT NULL,
  assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  returned_at TIMESTAMP NULL,
  CONSTRAINT fk_aa_asset FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE,
  CONSTRAINT fk_aa_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tickets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(180) NOT NULL,
  description TEXT NOT NULL,
  requester_id INT NOT NULL,
  category ENUM('Hardware','Software','Network','Account','Email','Printing','Security','Training','Other') NOT NULL DEFAULT 'Other',
  priority ENUM('Low','Medium','High','Critical') NOT NULL DEFAULT 'Medium',
  status ENUM('Open','In Progress','Pending','Resolved','Closed') NOT NULL DEFAULT 'Open',
  technician_id INT NULL,
  asset_id INT NULL,
  response_due DATETIME NOT NULL,
  resolution_due DATETIME NOT NULL,
  first_response_at DATETIME NULL,
  resolved_at DATETIME NULL,
  closed_at DATETIME NULL,
  escalation_level TINYINT NOT NULL DEFAULT 0,
  escalated_at DATETIME NULL,
  sla_warning_sent TINYINT(1) NOT NULL DEFAULT 0,
  sla_breach_sent TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_ticket_status (status),
  INDEX idx_ticket_tech (technician_id),
  INDEX idx_ticket_requester (requester_id),
  INDEX idx_ticket_due (resolution_due),
  CONSTRAINT fk_ticket_requester FOREIGN KEY (requester_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_ticket_technician FOREIGN KEY (technician_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_ticket_asset FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS ticket_notes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  ticket_id INT NOT NULL,
  user_id INT NULL COMMENT 'NULL = system generated note',
  note TEXT NOT NULL,
  is_internal TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'internal notes are hidden from employees',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_note_ticket FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
  CONSTRAINT fk_note_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

-- When each person last opened a ticket. Drives the "New reply" indicator for customers.
CREATE TABLE IF NOT EXISTS ticket_reads (
  ticket_id INT NOT NULL,
  user_id INT NOT NULL,
  last_viewed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (ticket_id, user_id),
  CONSTRAINT fk_read_ticket FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
  CONSTRAINT fk_read_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS attachments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  ticket_id INT NOT NULL,
  user_id INT NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  stored_name VARCHAR(80) NOT NULL UNIQUE,
  mime_type VARCHAR(100) NOT NULL,
  size_bytes INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_att_ticket FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
  CONSTRAINT fk_att_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NULL COMMENT 'NULL = performed automatically by the system',
  entity VARCHAR(30) NOT NULL,
  entity_id INT NULL,
  ticket_id INT NULL,
  action VARCHAR(60) NOT NULL,
  details TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_audit_ticket (ticket_id),
  INDEX idx_audit_entity (entity, entity_id),
  CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS kb_articles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(200) NOT NULL,
  category ENUM('Hardware','Software','Network','Account','Email','Printing','Security','Training','Other') NOT NULL DEFAULT 'Other',
  summary VARCHAR(300) NULL,
  content TEXT NOT NULL,
  author_id INT NULL,
  is_published TINYINT(1) NOT NULL DEFAULT 1,
  views INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_kb_author FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL
);

-- Anonymous reader feedback on knowledge base articles: one row per reader (random cookie id) per article.
CREATE TABLE IF NOT EXISTS kb_feedback (
  article_id INT NOT NULL,
  voter_key CHAR(32) NOT NULL,
  rating TINYINT NULL COMMENT '1-5 stars',
  helpful TINYINT(1) NULL COMMENT '1 = helpful, 0 = not helpful',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (article_id, voter_key),
  CONSTRAINT fk_kbf_article FOREIGN KEY (article_id) REFERENCES kb_articles(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS feedback (
  id INT AUTO_INCREMENT PRIMARY KEY,
  ticket_id INT NOT NULL UNIQUE,
  user_id INT NOT NULL,
  rating TINYINT NOT NULL,
  comment VARCHAR(1000) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_fb_ticket FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
  CONSTRAINT fk_fb_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT chk_rating CHECK (rating BETWEEN 1 AND 5)
);

CREATE TABLE IF NOT EXISTS email_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  to_email VARCHAR(150) NOT NULL,
  subject VARCHAR(255) NOT NULL,
  status ENUM('sent','failed','logged') NOT NULL,
  error VARCHAR(500) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT IGNORE INTO sla_policies (priority, response_minutes, resolution_minutes) VALUES
  ('Critical', 15, 240),
  ('High', 60, 480),
  ('Medium', 240, 1440),
  ('Low', 480, 4320);
