// Loads demo accounts and sample data. Safe to run once on an empty database.
// Run:  npm run seed
require("dotenv").config();
const pool = require("../src/db");
const { hashPassword } = require("../src/password");
const { computeDeadlines } = require("../src/sla");

const ago = minutes => new Date(Date.now() - minutes * 60000);

(async () => {
  const [[{ c }]] = await pool.query("SELECT COUNT(*) AS c FROM users");
  if (c > 0) { console.log("Database already has users, so nothing was seeded."); return pool.end(); }

  const pw = { admin: await hashPassword("Admin@12345"), tech: await hashPassword("Tech@12345"), emp: await hashPassword("Employee@12345") };
  const users = [
    ["Dulani Nawodya", "admin@example.com", pw.admin, "admin", 2, "IT"],
    ["Alex Perera", "alex@example.com", pw.tech, "technician", 2, "IT Support"],
    ["Nimali Silva", "nimali@example.com", pw.tech, "technician", 1, "IT Support"],
    ["Kasun Fernando", "kasun@example.com", pw.emp, "employee", 1, "Finance"],
    ["Ishara Jayasuriya", "ishara@example.com", pw.emp, "employee", 1, "HR"],
    ["Tharindu Wickrama", "tharindu@example.com", pw.emp, "employee", 1, "Sales"]
  ];
  for (const u of users) await pool.query("INSERT INTO users (name, email, password_hash, role, tech_level, department) VALUES (?,?,?,?,?,?)", u);
  const ID = { admin: 1, alex: 2, nimali: 3, kasun: 4, ishara: 5, tharindu: 6 };

  const assets = [
    ["LAP-0001", "Dell Latitude 5440", "Laptop", "Dell", "Latitude 5440", "DL5440-A1", "Assigned", ID.kasun, "Finance floor", "2024-03-10", "2027-03-10"],
    ["LAP-0002", "Lenovo ThinkPad T14", "Laptop", "Lenovo", "T14 Gen 3", "LT14-B7", "Assigned", ID.ishara, "HR office", "2023-06-01", "2026-12-20"],
    ["LAP-0003", "HP EliteBook 840", "Laptop", "HP", "840 G9", "HP840-C3", "Assigned", ID.tharindu, "Sales floor", "2024-08-15", "2027-08-15"],
    ["LAP-0004", "Dell Latitude 5440 (spare)", "Laptop", "Dell", "Latitude 5440", "DL5440-D9", "Available", null, "IT store room", "2024-03-10", "2027-03-10"],
    ["PRN-0001", "HP LaserJet Pro M404", "Printer", "HP", "M404dn", "PRN-M404-01", "Assigned", null, "Finance floor", "2022-11-02", "2025-11-02"],
    ["MON-0001", "Dell 24in Monitor", "Monitor", "Dell", "P2422H", "MON-P2422-17", "Available", null, "IT store room", "2024-01-20", "2027-01-20"],
    ["NET-0001", "Cisco Catalyst 2960 Switch", "Network Device", "Cisco", "2960-X", "NET-2960-05", "Assigned", null, "Server room", "2021-05-18", "2026-05-18"],
    ["LAP-0005", "Old ThinkPad T450", "Laptop", "Lenovo", "T450", "LT450-Z1", "Retired", null, "Disposal", "2016-02-02", null]
  ];
  for (const a of assets) {
    // Shared devices (printer, switch) belong to a location, not a person, so they stay 'Available' in the register.
    const status = a[6] === "Assigned" && !a[7] ? "Available" : a[6];
    const [r] = await pool.query(
      "INSERT INTO assets (asset_tag, name, type, brand, model, serial_number, status, assigned_to, location, purchase_date, warranty_expiry) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      [a[0], a[1], a[2], a[3], a[4], a[5], status, a[7], a[8], a[9], a[10]]);
    if (a[7]) await pool.query("INSERT INTO asset_assignments (asset_id, user_id, assigned_at) VALUES (?,?,?)", [r.insertId, a[7], ago(60 * 24 * 90)]);
  }
  const assetId = async tag => (await pool.query("SELECT id FROM assets WHERE asset_tag = ?", [tag]))[0][0].id;

  // [title, description, requester, category, priority, status, tech, assetTag, createdMinAgo, firstRespMinAfter, resolvedMinAfter, escalation]
  const tickets = [
    ["Entire finance floor has no internet", "Nobody on the finance floor can reach the internet or shared drives since this morning. Wi-Fi shows connected but no access.", ID.kasun, "Network", "Critical", "In Progress", ID.alex, "NET-0001", 360, 10, null, 0],
    ["Laptop will not power on", "My laptop does not turn on at all. The charger light is on but the screen stays black.", ID.ishara, "Hardware", "High", "Open", null, "LAP-0002", 120, null, null, 0],
    ["Outlook keeps asking for my password", "Outlook prompts for my password every few minutes since the weekend.", ID.tharindu, "Software", "Medium", "In Progress", ID.nimali, "LAP-0003", 1200, 90, null, 0],
    ["Need access to the shared HR drive", "Please grant me read access to the HR shared drive for the audit.", ID.ishara, "Account", "Low", "Pending", ID.nimali, null, 1440, 200, null, 0],
    ["Wi-Fi drops in meeting room 2", "Wi-Fi disconnects every 10 minutes during video calls in meeting room 2.", ID.kasun, "Network", "Medium", "Resolved", ID.alex, null, 4320, 30, 1500, 0],
    ["VPN fails to connect from home", "VPN client shows error 809 when connecting from home.", ID.tharindu, "Software", "High", "Closed", ID.nimali, "LAP-0003", 7200, 25, 400, 0],
    ["Printer out of toner", "The finance printer shows a toner low warning and prints faded pages.", ID.kasun, "Hardware", "Low", "Resolved", ID.nimali, "PRN-0001", 5760, 120, 180, 0],
    ["Admin account locked out", "I am locked out of my account after a password reset attempt.", ID.ishara, "Account", "Critical", "Open", ID.alex, null, 30, null, null, 0]
  ];
  const ticketIds = [];
  for (const t of tickets) {
    const created = ago(t[8]);
    const due = await computeDeadlines(t[4], created);
    const aid = t[7] ? await assetId(t[7]) : null;
    const first = t[9] != null ? new Date(created.getTime() + t[9] * 60000) : null;
    const resolved = t[10] != null ? new Date(created.getTime() + t[10] * 60000) : null;
    const closed = t[5] === "Closed" ? resolved : null;
    const [r] = await pool.query(
      `INSERT INTO tickets (title, description, requester_id, category, priority, status, technician_id, asset_id, response_due, resolution_due,
        first_response_at, resolved_at, closed_at, escalation_level, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [t[0], t[1], t[2], t[3], t[4], t[5], t[6], aid, due.response_due, due.resolution_due, first, resolved, closed, t[11], created]);
    ticketIds.push(r.insertId);
    await pool.query("INSERT INTO audit_logs (user_id, entity, entity_id, ticket_id, action, details, created_at) VALUES (?,?,?,?,?,?,?)",
      [t[2], "ticket", r.insertId, r.insertId, "created", `${t[4]} ${t[3]}: ${t[0]}`, created]);
  }

  const note = (i, user, text, internal, minAgo) => pool.query(
    "INSERT INTO ticket_notes (ticket_id, user_id, note, is_internal, created_at) VALUES (?,?,?,?,?)", [ticketIds[i], user, text, internal, ago(minAgo)]);
  await note(0, ID.alex, "Checked the core switch: uplink port flapping. Replacing the patch cable and re-seating the SFP.", 0, 340);
  await note(0, ID.alex, "Internal: if the SFP is faulty we have a spare in the store room (cabinet 3).", 1, 330);
  await note(2, ID.nimali, "Cleared cached credentials in Credential Manager and recreated the Outlook profile. Monitoring.", 0, 1100);
  await note(4, ID.alex, "Firmware on the access point was outdated. Updated to latest and moved channel to reduce interference.", 0, 3000);
  await pool.query("INSERT INTO feedback (ticket_id, user_id, rating, comment) VALUES (?,?,?,?)", [ticketIds[4], ID.kasun, 5, "Fixed quickly, thank you!"]);
  await pool.query("INSERT INTO feedback (ticket_id, user_id, rating, comment) VALUES (?,?,?,?)", [ticketIds[5], ID.tharindu, 4, "Worked after the client update."]);

  const kb = [
    ["No internet connection: step-by-step checks", "Network", "Work through these checks before escalating a connectivity ticket.",
`1. Confirm the scope: is it one device, one area or everyone? Ask a colleague nearby.
2. Check the physical layer: cable seated, link light on, Wi-Fi switch enabled.
3. Check IP settings: run ipconfig /all (Windows) or ifconfig (macOS). An address starting 169.254 means no DHCP.
4. Test the gateway: ping the default gateway, then ping 8.8.8.8, then ping a hostname such as google.com.
   - Gateway fails: local network or cable issue.
   - 8.8.8.8 works but the hostname fails: DNS problem.
5. Renew the lease: ipconfig /release then ipconfig /renew, then ipconfig /flushdns.
6. Try another cable, port or Wi-Fi network to isolate the fault.
7. If several users are affected, check the switch and uplink, then escalate to a senior technician.
8. Record every check performed in the ticket notes before resolving.`],
    ["Reset a forgotten or locked account password", "Account", "Verify identity, unlock, reset and force a password change at next sign-in.",
`1. Verify the person's identity using a second channel (manager confirmation or employee ID).
2. Unlock the account in the directory console.
3. Set a temporary password and require a change at next sign-in.
4. Ask the user to sign in and confirm access.
5. Note in the ticket that identity was verified. Never send passwords by email.`],
    ["Printer prints blank or faded pages", "Hardware", "Common causes and fixes for poor print quality.",
`1. Check toner level and replace the cartridge if it is low.
2. Remove the cartridge, gently rock it to redistribute toner, and reinstall.
3. Print a configuration/test page from the printer panel to separate printer faults from driver issues.
4. Clean the printer according to the manual and check for paper jams.
5. If the test page is fine but documents fail, reinstall the driver and clear the print queue.`],
    ["Outlook keeps asking for a password", "Software", "Clear stale credentials and rebuild the Outlook profile.",
`1. Close Outlook.
2. Open Credential Manager and remove saved credentials for Outlook / Office.
3. Control Panel > Mail > Show Profiles: create a new profile and set it as default.
4. Reopen Outlook, sign in and confirm MFA completes.
5. If it persists, check whether the password was recently changed and whether the account is locked.`],
    ["VPN error 809 on home networks", "Network", "Typically caused by a home router blocking VPN traffic.",
`1. Confirm the user has internet access without the VPN.
2. Ensure UDP ports 500 and 4500 are allowed; enable IPsec/VPN passthrough on the home router.
3. Try a mobile hotspot to confirm the router is the cause.
4. Update the VPN client and reboot.`]
  ];
  for (const k of kb) await pool.query("INSERT INTO kb_articles (title, category, summary, content, author_id, views) VALUES (?,?,?,?,?,?)", [k[0], k[1], k[2], k[3], ID.alex, 0]);

  console.log("Seed complete. Demo logins (change these passwords before any real use):");
  console.log("  admin@example.com    / Admin@12345");
  console.log("  alex@example.com     / Tech@12345     (senior technician)");
  console.log("  nimali@example.com   / Tech@12345");
  console.log("  kasun@example.com    / Employee@12345");
  await pool.end();
})().catch(err => { console.error("Seed failed:", err.message); process.exit(1); });
