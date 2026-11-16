// Runs encoding jobs one at a time in the background and streams their progress to the screens.
// A job runs its first reading with the client's model. If some documents could not be read cleanly, the
// job finishes with an offer of a second reading by a stronger model, which runs only when the user asks.
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { loadSettings, resolve, ROOT } from "../engine/settings.js";
import { listInputFiles, readPurchases, buildPurchaseRows, folderSheetName, savePurchaseWorkbooks, READING_DOUBT as PURCHASE_DOUBT } from "../engine/purchases.js";
import { encodeCertificates, READING_DOUBT as CERTIFICATE_DOUBT } from "../engine/certificates.js";
import { write2307Workbook } from "../engine/workbook2307.js";
import { saveSuppliers } from "../engine/suppliers.js";
import { syncPurchaseWorkbook, sync2307Workbook, rowBrief } from "../engine/record.js";

export const SECOND_MODEL = "claude-sonnet-5-5";
// Rough cost of one second reading on Sonnet, from earlier runs: a whole document, or one page of a bundle.
const SECOND_READING_COST = { file: 0.013, page: 0.02 };

const events = new EventEmitter();
events.setMaxListeners(0);
const latest = new Map(); // job id -> last progress event, for screens that connect mid-run
const queue = [];
let running = false;

const emit = (jobId, event) => {
  const message = { jobId, at: Date.now(), ...event };
  latest.set(jobId, message);
  events.emit(String(jobId), message);
};

/** Subscribes to a job's progress. Returns a function that unsubscribes. */
export function watch(jobId, listener) {
  const key = String(jobId);
  if (latest.has(Number(jobId))) listener(latest.get(Number(jobId)));
  events.on(key, listener);
  return () => events.off(key, listener);
}

/** Adds a job to the queue. `phase` is "first" or "second". */
export function enqueue(db, jobId, phase = "first") {
  queue.push({ jobId, phase });
  db.updateJob(jobId, { status: "queued" });
  emit(jobId, { type: "status", status: "queued", position: queue.length });
  if (!running) void pump(db);
}

async function pump(db) {
  running = true;
  while (queue.length) {
    const { jobId, phase } = queue.shift();
    try {
      await runJob(db, jobId, phase);
    } catch (err) {
      db.updateJob(jobId, { status: "failed", error: err.message });
      emit(jobId, { type: "status", status: "failed", error: err.message });
    }
  }
  running = false;
}

const withYear = (file) => Number(/(\d{4})/.exec(path.basename(file))?.[1]);

async function runJob(db, jobId, phase) {
  const job = db.getJob(jobId);
  const settings = loadSettings({ client: job.client_id });
  const secondModel = phase === "second" ? SECOND_MODEL : undefined;
  db.updateJob(jobId, { status: "running", error: null });
  emit(jobId, { type: "status", status: "running", phase });

  let phaseCost = 0;
  const onUsage = (u) => {
    phaseCost += u.cost;
    db.recordUsage({ jobId, clientId: settings.id, ...u });
  };
  const previous = job.summary ?? {};
  const cost = () => (previous.cost ?? 0) + phaseCost;

  if (job.kind === "purchases") {
    const input = listInputFiles(job.source);
    const read = await readPurchases({
      settings,
      dir: input.dir,
      files: input.files,
      byPage: job.options.byPage,
      secondModel,
      onUsage,
      onProgress: ({ done, total, name }) => emit(jobId, { type: "progress", phase, done, total, item: name, cost: cost() }),
    });
    const built = buildPurchaseRows({ settings, readings: read.readings, sheetName: folderSheetName(input, job.options.sheet) });
    // A second reading replaces what the first one put in the workbook for these files.
    const saved = await savePurchaseWorkbooks({ settings, rows: built.rows, replaceFiles: phase === "second" ? input.files : [] });
    if (built.suppliersChanged) saveSuppliers(settings, built.suppliers);
    for (const file of saved.workbooks) await syncPurchaseWorkbook(db, settings, file, withYear(file));

    const doubtful = new Set(built.rows.filter((r) => PURCHASE_DOUBT.test(r.remarks)).map((r) => (job.options.byPage ? r.source : r.source.replace(/ \(page \d+\)$/, ""))));
    for (const f of built.failed) doubtful.add(f.file);
    finish(db, jobId, phase, {
      files: input.files.length,
      encoded: saved.added.length,
      manualChecking: saved.manualChecking,
      duplicates: saved.duplicates.map((r) => ({ file: r.source, reason: `${r.company} ${r.number} is already encoded` })),
      skipped: [...built.skipped, ...saved.droppedReceipts.map((r) => ({ file: r.source, reason: "delivery receipt with a matching invoice" }))],
      failed: [...built.failed.map((f) => ({ file: f.file, reason: f.reason })), ...read.pageFailures],
      workbooks: saved.workbooks.map((w) => path.relative(ROOT, w).split(path.sep).join("/")),
      added: saved.added.map(rowBrief),
      reread: read.secondPass,
      doubtful: doubtful.size,
      unit: job.options.byPage ? "page" : "file",
      cost: cost(),
    }, previous, settings.model);
    return;
  }

  // 2307: one PDF of certificates, rewritten in full each time.
  const result = await encodeCertificates({
    settings,
    file: job.source,
    secondModel,
    onUsage,
    onProgress: ({ stage, done, total, page }) => emit(jobId, { type: "progress", phase: stage, done, total, item: `page ${page}`, cost: cost() }),
  });
  // Never overwrite a 2307 workbook from the app: it may hold the user's checking. A first run writes
  // "<pdf name>.xlsx"; a later one gets a number, and the second reading of a job rewrites that job's own file.
  const dir = resolve(path.join(settings.output, "2307"));
  let out = phase === "second" && previous.workbooks?.[0] ? resolve(previous.workbooks[0]) : path.join(dir, `${result.name}.xlsx`);
  for (let n = 2; phase === "first" && fs.existsSync(out); n++) out = path.join(dir, `${result.name} (${n}).xlsx`);
  await write2307Workbook(out, result.rows);
  await sync2307Workbook(db, settings, out);
  const doubtful = new Set(result.rows.filter((r) => CERTIFICATE_DOUBT.test(r.remarks)).map((r) => r.page));
  finish(db, jobId, phase, {
    pages: result.pages,
    encoded: result.rows.length,
    manualChecking: result.rows.filter((r) => r.remarks).length,
    skipped: result.skipped.map((s) => ({ file: `page ${s.page}`, reason: s.reason })),
    failed: result.failed.map((f) => ({ file: `page ${f.page}`, reason: f.reason })),
    workbooks: [path.relative(ROOT, out).split(path.sep).join("/")],
    added: result.rows.map(rowBrief),
    reread: result.reread,
    doubtful: doubtful.size,
    unit: "page",
    clientTin: result.clientTin,
    cost: cost(),
  }, previous, settings.model);
}

function finish(db, jobId, phase, summary, previous, model) {
  // After the first reading, offer a second one for whatever was left in doubt; after the second, offer nothing.
  // A client that already reads with the second model gets no offer: it would pay twice for the same reading.
  const offer =
    phase === "first" && summary.doubtful > 0 && model !== SECOND_MODEL
      ? { count: summary.doubtful, unit: summary.unit, model: SECOND_MODEL, estimate: Math.round(summary.doubtful * SECOND_READING_COST[summary.unit] * 100) / 100 }
      : null;
  const full = { ...summary, phase, secondPassOffer: offer, firstPass: phase === "second" ? { encoded: previous.encoded, manualChecking: previous.manualChecking, cost: previous.cost } : undefined };
  db.updateJob(jobId, { status: "done", summary: full });
  emit(jobId, { type: "status", status: "done", summary: full });
}
