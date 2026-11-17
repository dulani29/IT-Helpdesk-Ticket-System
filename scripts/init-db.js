// Creates the database and tables from schema.sql using your .env credentials.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    multipleStatements: true
  });
  const sql = fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8");
  await conn.query(sql);
  await conn.end();
  console.log("Database and tables created. Next: npm run seed");
})().catch(err => { console.error("init-db failed:", err.message); process.exit(1); });
