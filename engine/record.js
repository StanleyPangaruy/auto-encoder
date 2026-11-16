// Keeps the database's rows in step with the workbooks. Until the app's review screen exists, the workbook
// is the record (corrections are typed into it), so after anything writes a workbook its rows are synced
// here: the database holds one copy of each workbook's rows, never one per job.
import path from "node:path";
import { ROOT } from "./settings.js";
import { readWorkbook } from "./workbook.js";
import { read2307Workbook } from "./workbook2307.js";
import { registerClient } from "./clients.js";

const relative = (file) => path.relative(ROOT, path.resolve(file));

function replaceSnapshot(db, { clientId, kind, file, rows }) {
  const source = relative(file);
  db.raw.prepare("DELETE FROM jobs WHERE client_id = ? AND kind = ? AND source = ? AND origin = 'import'").run(clientId, kind, source);
  return db.saveJob({ clientId, kind, origin: "import", source, summary: { rows: rows.length }, rows });
}

/** Copies a purchases workbook's rows (all sheets) into the database, replacing the previous copy. */
export async function syncPurchaseWorkbook(db, settings, file, year) {
  registerClient(db, settings);
  const sheets = await readWorkbook(file, year);
  const rows = Object.values(sheets).flat();
  replaceSnapshot(db, { clientId: settings.id, kind: "purchases", file, rows });
  return sheets;
}

/** Copies a 2307 workbook's rows into the database, replacing the previous copy. */
export async function sync2307Workbook(db, settings, file) {
  registerClient(db, settings);
  const name = path.basename(file);
  const rows = (await read2307Workbook(file)).map((r) => ({ ...r, sheet: "2307", year: null, source: name }));
  replaceSnapshot(db, { clientId: settings.id, kind: "2307", file, rows });
  return rows;
}

/** The short form of a row kept in a job's summary, to show what the job added. */
export const rowBrief = (r) => ({
  source: r.source,
  page: r.page ?? null,
  month: r.month ?? "",
  number: r.number ?? "",
  company: r.company ?? "",
  amount: r.amount ?? null,
  remarks: r.remarks ?? "",
});
