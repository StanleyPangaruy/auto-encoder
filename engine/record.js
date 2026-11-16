// Keeps the database's rows in step with the workbooks. The database holds one copy of each workbook's
// rows (a "snapshot" job), never one per encoding run. Encoding writes the workbook and then copies it
// here; the review screen edits the copy and then rewrites the workbook from it. Each copy remembers the
// workbook's modified time, so a change made in Excel since then is noticed before anything overwrites it.
import fs from "node:fs";
import path from "node:path";
import { ROOT, resolve } from "./settings.js";
import { readWorkbook, writeWorkbook } from "./workbook.js";
import { read2307Workbook, write2307Workbook } from "./workbook2307.js";
import { registerClient } from "./clients.js";

const relative = (file) => path.relative(ROOT, path.resolve(file)).split(path.sep).join("/");
const modified = (file) => fs.statSync(file).mtimeMs;

function replaceSnapshot(db, { clientId, kind, file, rows, extra = {} }) {
  const source = relative(file);
  // Earlier copies may have been saved with Windows backslashes in the path; they are the same workbook.
  db.raw
    .prepare("DELETE FROM jobs WHERE client_id = ? AND kind = ? AND origin = 'import' AND replace(source, char(92), '/') = ?")
    .run(clientId, kind, source);
  return db.saveJob({ clientId, kind, origin: "import", source, summary: { rows: rows.length, mtime: modified(file), ...extra }, rows });
}

/** Copies a purchases workbook's rows (all sheets) into the database, replacing the previous copy. */
export async function syncPurchaseWorkbook(db, settings, file, year) {
  registerClient(db, settings);
  const sheets = await readWorkbook(file, year);
  const rows = Object.values(sheets).flat();
  replaceSnapshot(db, { clientId: settings.id, kind: "purchases", file, rows, extra: { year, sheets: Object.keys(sheets) } });
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

/** The database copies of a client's workbooks (or every client's), as { jobId, kind, file, summary }. */
export function listSnapshots(db, clientId) {
  return db
    .listJobs(clientId)
    .filter((j) => j.origin === "import")
    .map((j) => ({ jobId: j.id, clientId: j.client_id, kind: j.kind, file: j.source, summary: j.summary }));
}

/** True when the workbook was changed (in Excel) after its rows were copied into the database. */
export function changedSinceSync(db, jobId) {
  const job = db.getJob(jobId);
  const file = resolve(job.source);
  return fs.existsSync(file) && Math.abs(modified(file) - (job.summary.mtime ?? 0)) > 1;
}

/** Copies a workbook into the database again, for example after it was changed in Excel. */
export async function resync(db, settings, jobId) {
  const job = db.getJob(jobId);
  const file = resolve(job.source);
  if (job.kind === "2307") await sync2307Workbook(db, settings, file);
  else await syncPurchaseWorkbook(db, settings, file, job.summary.year);
  return listSnapshots(db, settings.id).find((s) => s.file === job.source)?.jobId;
}

/**
 * Rewrites a workbook from its database copy, after the review screen changed a row. Backups are taken
 * at most once an hour during review. Returns nothing; the copy's remembered modified time is updated.
 */
export async function writeFromSnapshot(db, jobId) {
  const job = db.getJob(jobId);
  const file = resolve(job.source);
  const rows = db.listRows(job.client_id, { jobId });
  if (job.kind === "2307") {
    await write2307Workbook(file, rows, { backupEvery: 60 * 60 * 1000 });
  } else {
    const sheets = {};
    // Keep the workbook's sheet order; listRows returns each sheet's rows in their order.
    for (const name of job.summary.sheets ?? [...new Set(rows.map((r) => r.sheet))]) sheets[name] = [];
    for (const row of rows) (sheets[row.sheet] ??= []).push(row);
    await writeWorkbook(file, sheets, { backupEvery: 60 * 60 * 1000 });
  }
  db.updateJob(jobId, { summary: { ...job.summary, mtime: modified(file) } });
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
