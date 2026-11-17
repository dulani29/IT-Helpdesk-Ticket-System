// Safe CSV writer: quotes fields and neutralises spreadsheet formula injection (=, +, -, @).
function cell(value) {
  if (value === null || value === undefined) return "";
  let s = value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(headers, rows) {
  return [headers.join(","), ...rows.map(r => headers.map(h => cell(r[h])).join(","))].join("\r\n");
}
function sendCsv(res, filename, headers, rows) {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send("\uFEFF" + toCsv(headers, rows));
}
module.exports = { toCsv, sendCsv };
