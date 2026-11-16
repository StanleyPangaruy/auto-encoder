// Loads the existing workbooks into the app database, so rows already encoded and checked in Excel carry over.
//   node scripts/import-to-db.js [--db <file>]
// Safe to run again: each workbook's earlier copy in the database is replaced.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadSettings, clientNames, resolve } from "../engine/settings.js";
import { openDb, DEFAULT_DB } from "../engine/db.js";
import { registerAllClients } from "../engine/clients.js";
import { syncPurchaseWorkbook, sync2307Workbook } from "../engine/record.js";

const { values: args } = parseArgs({ options: { db: { type: "string" } } });
const db = openDb(args.db ?? DEFAULT_DB);
registerAllClients(db);

for (const client of clientNames()) {
  const settings = loadSettings({ client });
  const dir = resolve(settings.output);
  if (!fs.existsSync(dir)) continue;

  // Purchases: one yearly workbook per file name pattern, one sheet per month or folder.
  const [prefix, suffix] = settings.workbookName.split("{year}");
  for (const name of fs.readdirSync(dir)) {
    const middle = name.startsWith(prefix) && name.endsWith(suffix) ? name.slice(prefix.length, name.length - suffix.length) : "";
    if (!/^\d{4}$/.test(middle)) continue;
    const file = path.join(dir, name);
    const year = Number(middle);
    const sheets = await syncPurchaseWorkbook(db, settings, file, year);
    const count = Object.values(sheets).flat().length;
    console.log(`${settings.id}: ${name} — ${count} rows (${Object.entries(sheets).map(([s, r]) => `${s} ${r.length}`).join(", ")})`);
  }

  // 2307 lists: one workbook per PDF, in the client's 2307 folder.
  const certificates = path.join(dir, "2307");
  if (!fs.existsSync(certificates)) continue;
  for (const name of fs.readdirSync(certificates).filter((f) => f.endsWith(".xlsx"))) {
    const file = path.join(certificates, name);
    const rows = await sync2307Workbook(db, settings, file);
    console.log(`${settings.id}: 2307/${name} — ${rows.length} rows`);
  }
}
db.close();
