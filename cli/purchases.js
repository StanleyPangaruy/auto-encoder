// Encodes purchase documents into a client's purchases workbook.
//   node cli/purchases.js [--client <name>] [--in <folder or file>] [--out <folder>] [--keep] [--json]
//                         [--by-page] [--second-pass <model>] [--sheet <name>]
// --by-page reads each PDF page on its own (for bundles of small receipts scanned several to a page).
// --second-pass re-reads, with a stronger model, whatever the first model could not read cleanly.
// --sheet names the sheet for file-order clients (default: the input folder or file name).
// --keep leaves the source files where they are instead of moving them to <folder>/processed.
// Each run is also recorded in the app database (data/app.db): the job and its cost, and the workbook's rows.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadSettings } from "../engine/settings.js";
import { listInputFiles, readPurchases, buildPurchaseRows, folderSheetName, savePurchaseWorkbooks } from "../engine/purchases.js";
import { saveSuppliers } from "../engine/suppliers.js";
import { openDb } from "../engine/db.js";
import { syncPurchaseWorkbook, rowBrief } from "../engine/record.js";

const { values: args } = parseArgs({
  options: {
    client: { type: "string" },
    in: { type: "string" },
    out: { type: "string" },
    keep: { type: "boolean" },
    json: { type: "boolean" },
    "by-page": { type: "boolean" },
    "second-pass": { type: "string" },
    sheet: { type: "string" },
  },
});
const log = (...a) => args.json || console.log(...a);

async function main() {
  const settings = loadSettings({ client: args.client });
  const input = listInputFiles(args.in ?? settings.inbox);
  const summary = { inbox: input.dir, files: input.files.length, secondPass: 0, encoded: 0, manualChecking: 0, duplicates: [], skipped: [], failed: [], workbooks: [], cost: 0 };
  if (!input.files.length) return summary;
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new Error("No Anthropic API key. Put ANTHROPIC_API_KEY=... in the .env file next to package.json.");
  }

  const calls = [];
  const read = await readPurchases({
    settings,
    dir: input.dir,
    files: input.files,
    byPage: args["by-page"],
    secondModel: args["second-pass"],
    onProgress: ({ done, total, name }) => log(`  read ${done}/${total}  ${name}`),
    onUsage: (u) => calls.push(u),
  });
  const built = buildPurchaseRows({ settings, readings: read.readings, sheetName: folderSheetName(input, args.sheet) });
  const saved = await savePurchaseWorkbooks({ settings, rows: built.rows, outDir: args.out });
  if (built.suppliersChanged) saveSuppliers(settings, built.suppliers);

  Object.assign(summary, {
    secondPass: read.secondPass,
    encoded: saved.added.length,
    manualChecking: saved.manualChecking,
    duplicates: saved.duplicates.map((r) => ({ file: r.source, reason: `${r.company} ${r.number} is already encoded` })),
    skipped: [...built.skipped, ...saved.droppedReceipts.map((r) => ({ file: r.source, reason: "delivery receipt with a matching invoice" }))],
    failed: [...built.failed, ...read.pageFailures],
    workbooks: saved.workbooks,
    cost: calls.reduce((sum, c) => sum + c.cost, 0),
  });

  // Trial runs written elsewhere with --out are not part of the client's record.
  if (!args.out) {
    const db = openDb();
    for (const file of saved.workbooks) await syncPurchaseWorkbook(db, settings, file, Number(/(d{4})/.exec(path.basename(file))?.[1]));
    const jobId = db.saveJob({
      clientId: settings.id,
      kind: "purchases",
      source: path.relative(process.cwd(), path.join(input.dir, input.singleFile ? input.files[0] : "")) || input.dir,
      options: { byPage: Boolean(args["by-page"]), secondModel: args["second-pass"] ?? null, model: settings.model },
      summary: { files: summary.files, encoded: summary.encoded, manualChecking: summary.manualChecking, secondPass: summary.secondPass, cost: summary.cost, added: saved.added.map(rowBrief) },
    });
    for (const call of calls) db.recordUsage({ jobId, clientId: settings.id, ...call });
    db.close();
  }

  if (!args.keep) {
    const failedFiles = new Set(built.failed.map((f) => f.file));
    const processed = path.join(input.dir, "processed");
    fs.mkdirSync(processed, { recursive: true });
    for (const name of input.files) if (!failedFiles.has(name)) fs.renameSync(path.join(input.dir, name), path.join(processed, name));
  }
  return summary;
}

try {
  const s = await main();
  if (args.json) {
    console.log(JSON.stringify(s));
  } else {
    console.log(`\n${s.files} file(s) in ${s.inbox}`);
    console.log(`  encoded: ${s.encoded}   for manual checking: ${s.manualChecking}`);
    if (s.secondPass) console.log(`  given a second reading: ${s.secondPass}`);
    for (const [label, list] of [["already encoded", s.duplicates], ["not encoded", s.skipped], ["FAILED", s.failed]]) {
      if (list.length) console.log(`  ${label}: ${list.length}`);
      for (const item of list) console.log(`    - ${item.file}: ${item.reason}`);
    }
    for (const w of s.workbooks) console.log(`  workbook: ${w}`);
    console.log(`  cost of this run: about $${s.cost.toFixed(2)} (documents already read cost nothing)`);
  }
  if (s.failed.length && !args.json) process.exitCode = 2;
} catch (err) {
  if (args.json) console.log(JSON.stringify({ error: err.message }));
  else console.error(`\nERROR: ${err.message}`);
  // In --json mode the caller (n8n) reads the error from the output instead of the exit code.
  if (!args.json) process.exitCode = 1;
}
