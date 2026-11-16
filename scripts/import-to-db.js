// Loads the existing workbooks into the app database, so rows already encoded and checked in Excel carry over.
//   node scripts/import-to-db.js [--db <file>]
// Safe to run again: each workbook's earlier import is replaced, and rows from encoding runs are left alone.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadSettings, clientNames, resolve, ROOT } from "../engine/settings.js";
import { openDb, DEFAULT_DB } from "../engine/db.js";
import { registerAllClients } from "../engine/clients.js";
import { readWorkbook } from "../engine/workbook.js";
import { read2307Workbook } from "../engine/workbook2307.js";

const { values: args } = parseArgs({ options: { db: { type: "string" } } });
const db = openDb(args.db ?? DEFAULT_DB);
registerAllClients(db);

const relative = (file) => path.relative(ROOT, file);
const replaceImport = (clientId, kind, source) => {
  db.raw.prepare("DELETE FROM jobs WHERE client_id = ? AND kind = ? AND source = ? AND origin = 'import'").run(clientId, kind, source);
};

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
    const sheets = await readWorkbook(file, year);
    const rows = Object.values(sheets).flat();
    replaceImport(settings.id, "purchases", relative(file));
    db.saveJob({ clientId: settings.id, kind: "purchases", origin: "import", source: relative(file), summary: { rows: rows.length }, rows });
    console.log(`${settings.id}: ${name} — ${rows.length} rows (${Object.entries(sheets).map(([s, r]) => `${s} ${r.length}`).join(", ")})`);
  }

  // 2307 lists: one workbook per PDF, in the client's 2307 folder.
  const certificates = path.join(dir, "2307");
  if (!fs.existsSync(certificates)) continue;
  for (const name of fs.readdirSync(certificates).filter((f) => f.endsWith(".xlsx"))) {
    const file = path.join(certificates, name);
    const rows = (await read2307Workbook(file)).map((r) => ({ ...r, sheet: "2307", year: null, source: name }));
    replaceImport(settings.id, "2307", relative(file));
    db.saveJob({ clientId: settings.id, kind: "2307", origin: "import", source: relative(file), summary: { rows: rows.length }, rows });
    console.log(`${settings.id}: 2307/${name} — ${rows.length} rows`);
  }
}
db.close();
