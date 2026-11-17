const mysql = require("mysql2/promise");

const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "helpdesk_db",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  timezone: "Z" // JS Dates are read/written as UTC
});

// Keep MySQL's NOW() in UTC too, so SLA maths is consistent everywhere.
pool.pool.on("connection", conn => conn.query("SET time_zone = '+00:00'"));

module.exports = pool;
