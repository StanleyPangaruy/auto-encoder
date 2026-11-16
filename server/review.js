// The review screen's routes: workbooks and their rows, saving a corrected row, and the scan behind a row.
// Every save rewrites the workbook from the database, after checking it was not changed in Excel meanwhile.
import fs from "node:fs";
import path from "node:path";
import { MONTHS, PARTICULARS, UNDATED, loadSettings, resolve } from "../engine/settings.js";
import { MANUAL, sortRows } from "../engine/rows.js";
import { listSnapshots, changedSinceSync, resync, writeFromSnapshot } from "../engine/record.js";
import { findRawFile, rawPdfs, renderPage } from "../engine/scans.js";
import { getClient } from "./clients.js";

const fail = (status, message) => Object.assign(new Error(message), { statusCode: status });
const posix = (p) => p.split(path.sep).join("/");
const needsChecking = (r) => r.remarks?.startsWith(MANUAL);

// The fields the review screen may change, per kind of workbook.
const TEXT = {
  purchases: ["month", "day", "number", "tin", "company", "last", "first", "middle", "address", "city", "nature", "particulars", "vat", "remarks"],
  2307: ["month", "tin", "company", "last", "first", "middle", "address", "city", "atc", "remarks"],
};
const NUMBERS = { purchases: ["amount", "net", "inputVat", "nonVat"], 2307: ["amount", "rate", "wtax"] };
const UPPER = new Set(["month", "company", "last", "first", "middle", "address", "city", "nature", "particulars", "atc"]);

function cleanChanges(kind, input) {
  const out = {};
  for (const key of TEXT[kind]) {
    if (!(key in input)) continue;
    let value = String(input[key] ?? "").trim().replace(/\s+/g, " ");
    if (UPPER.has(key)) value = value.toUpperCase();
    if (key === "tin") value = value.replace(/\D/g, "").slice(0, 9);
    if (key === "day" && value) value = value.replace(/\D/g, "").padStart(2, "0").slice(-2);
    out[key] = value;
  }
  for (const key of NUMBERS[kind]) {
    if (!(key in input)) continue;
    const raw = input[key];
    if (raw === "" || raw == null) out[key] = null;
    else {
      const n = Number(String(raw).replace(/,/g, ""));
      if (!Number.isFinite(n)) throw fail(400, `${key} must be a number`);
      out[key] = Math.round(n * 100) / 100;
    }
  }
  if (kind === "purchases") {
    if (out.month && !MONTHS.includes(out.month)) throw fail(400, `Month must be one of ${MONTHS.join(", ")}`);
    if (out.vat && !["auto", "manual"].includes(out.vat)) throw fail(400, "VAT must be automatic or manual");
    if (out.particulars && !(out.particulars in PARTICULARS)) throw fail(400, `Particulars must be one of ${Object.keys(PARTICULARS).join(", ")}`);
    // NATURE follows PARTICULARS, as in the encoder.
    if (out.particulars) out.nature = PARTICULARS[out.particulars];
    // A row switched to the automatic 12% split has no typed VAT figures.
    if (out.vat === "auto") Object.assign(out, { net: null, inputVat: null });
  }
  if (out.tin && out.tin.length !== 9) throw fail(400, "A TIN has 9 digits");
  return out;
}

/** The database copy of a workbook, re-read first if it was changed in Excel. */
async function snapshotFor(db, file) {
  let snap = listSnapshots(db).find((s) => s.file === file);
  if (!snap) throw fail(404, "That workbook is not in the app yet");
  if (changedSinceSync(db, snap.jobId)) {
    await resync(db, loadSettings({ client: snap.clientId }), snap.jobId);
    snap = listSnapshots(db).find((s) => s.file === file);
  }
  return snap;
}

function sheetsOf(rows, order) {
  const names = [...new Set([...(order ?? []), ...rows.map((r) => r.sheet)])];
  return names
    .map((name) => {
      const inSheet = rows.filter((r) => r.sheet === name);
      return { name, rows: inSheet.length, toCheck: inSheet.filter(needsChecking).length };
    })
    .filter((s) => s.rows > 0);
}

const pageOf = (row) => row.page ?? Number(/ \(page (\d+)\)$/.exec(row.source ?? "")?.[1] ?? 1);

/** Where a row's scan is: { file, page } or null. 2307 rows come from the PDF their workbook was made from. */
function scanOf(db, row) {
  const client = getClient(row.clientId);
  if (!client) return null;
  if (row.kind === "2307") {
    const pdf = pdfForWorkbook(db, db.getJob(row.jobId).source, client.rawDir);
    return pdf ? { file: pdf, page: row.page ?? 1 } : null;
  }
  const name = (row.source ?? "").replace(/ \(page \d+\)$/, "");
  const file = name && findRawFile(client.rawDir, name);
  return file ? { file, page: pageOf(row) } : null;
}

/** The PDF a 2307 workbook was made from: chosen by the user, recorded by a job, or the same name. */
function pdfForWorkbook(db, workbook, rawDir) {
  const chosen = db.getSetting(`pdf-for:${workbook}`);
  if (chosen && fs.existsSync(resolve(chosen))) return resolve(chosen);
  const job = db.listJobs().find((j) => j.origin === "run" && j.kind === "2307" && (j.summary.workbooks ?? []).includes(workbook));
  if (job && fs.existsSync(resolve(job.source))) return resolve(job.source);
  // Same name first ("X (1).xlsx" from "X (1).pdf"); then without a number the app added ("X (2).xlsx" from "X.pdf").
  const stem = path.basename(workbook, ".xlsx");
  const pdfs = rawPdfs(rawDir);
  const named = (s) => pdfs.find((f) => path.basename(f, path.extname(f)) === s);
  return named(stem) ?? named(stem.replace(/ \(\d+\)$/, "")) ?? null;
}

export function registerReviewRoutes(app, db) {
  // Workbooks a client has, with each sheet's row and checking counts.
  app.get("/api/workbooks", async (req) => {
    const out = [];
    for (const snap of listSnapshots(db, req.query.client)) {
      const rows = db.listRows(snap.clientId, { jobId: snap.jobId });
      out.push({ file: snap.file, clientId: snap.clientId, kind: snap.kind, name: path.basename(snap.file), sheets: sheetsOf(rows, snap.summary.sheets), toCheck: rows.filter(needsChecking).length, rows: rows.length });
    }
    return out;
  });

  // One sheet's rows, in order. Re-reads the workbook first if Excel changed it.
  app.get("/api/workbooks/rows", async (req) => {
    const { file, sheet } = req.query;
    const snap = await snapshotFor(db, file);
    const rows = db.listRows(snap.clientId, { jobId: snap.jobId });
    return {
      file,
      kind: snap.kind,
      sheets: sheetsOf(rows, snap.summary.sheets),
      rows: rows.filter((r) => !sheet || r.sheet === sheet).map((r) => ({ ...r, page: snap.kind === "2307" ? r.page : pageOf(r) })),
    };
  });

  // Saves corrections to one row and rewrites its workbook.
  app.put("/api/rows/:id", async (req) => {
    const id = Number(req.params.id);
    const row = db.getRow(id);
    if (!row) throw fail(404, "That row no longer exists. Reload the list.");
    if (changedSinceSync(db, row.jobId)) {
      await resync(db, loadSettings({ client: row.clientId }), row.jobId);
      throw fail(409, "The workbook was changed in Excel. The list has been reloaded from it; make your change again.");
    }
    const { checked, ...fields } = req.body ?? {};
    const changes = cleanChanges(row.kind, fields);
    // Marking a row checked clears its manual-checking remark, which also clears its shading.
    if (checked === true && needsChecking({ remarks: changes.remarks ?? row.remarks })) changes.remarks = "";
    db.updateRow(id, { ...changes, ...(checked === undefined ? {} : { checked: Boolean(checked) }) });

    // In a month-sheet workbook, a row whose month changed moves to that month's sheet (or UNDATED).
    const settings = loadSettings({ client: row.clientId });
    const job = db.getJob(row.jobId);
    if (row.kind === "purchases" && settings.layout !== "file-order" && "month" in changes) {
      const target = changes.month || UNDATED;
      if (target !== row.sheet) {
        const all = db.listRows(row.clientId, { jobId: row.jobId });
        const moved = all.find((r) => r.id === id);
        moved.sheet = target;
        const placements = [];
        for (const name of new Set([row.sheet, target])) {
          const inSheet = all.filter((r) => r.sheet === name);
          if (MONTHS.includes(name)) sortRows(inSheet);
          inSheet.forEach((r, position) => placements.push({ id: r.id, sheet: name, position }));
        }
        db.placeRows(placements);
        if (!(job.summary.sheets ?? []).includes(target)) {
          const order = [...MONTHS, UNDATED].filter((m) => m === target || (job.summary.sheets ?? []).includes(m));
          db.updateJob(job.id, { summary: { ...job.summary, sheets: [...order, ...(job.summary.sheets ?? []).filter((s) => !order.includes(s))] } });
        }
      }
    }
    await writeFromSnapshot(db, row.jobId);
    const saved = db.getRow(id);
    return { ...saved, page: row.kind === "2307" ? saved.page : pageOf(saved) };
  });

  // Where a row's scan is, and how to show it.
  app.get("/api/rows/:id/scan-info", async (req) => {
    const row = db.getRow(Number(req.params.id));
    if (!row) throw fail(404, "No such row");
    const scan = scanOf(db, row);
    if (!scan) {
      const client = getClient(row.clientId);
      return {
        found: false,
        kind: row.kind,
        // A 2307 workbook whose PDF cannot be matched can be pointed at one of the client's PDFs.
        choices: row.kind === "2307" && client ? rawPdfs(client.rawDir).map((f) => posix(path.relative(resolve("."), f))) : [],
      };
    }
    return { found: true, file: path.basename(scan.file), page: scan.page, url: `/api/rows/${row.id}/scan` };
  });

  app.get("/api/rows/:id/scan", async (req, reply) => {
    const row = db.getRow(Number(req.params.id));
    const scan = row && scanOf(db, row);
    if (!scan) throw fail(404, "The scan for this row was not found");
    const page = await renderPage(scan.file, scan.page);
    reply.header("cache-control", "private, max-age=3600");
    return reply.type(page.type === "image" ? "image/jpeg" : "application/pdf").send(page.data);
  });

  // Tells the app which PDF a 2307 workbook was made from, when it cannot tell by the name.
  app.put("/api/workbooks/pdf", async (req) => {
    const { file, pdf } = req.body ?? {};
    if (!file || !pdf || !fs.existsSync(resolve(pdf)) || !/\.pdf$/i.test(pdf)) throw fail(400, "Choose one of the client's PDFs");
    db.setSetting(`pdf-for:${file}`, pdf);
    return { ok: true };
  });
}
