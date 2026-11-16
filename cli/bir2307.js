// Encodes a scanned PDF of BIR Form 2307 certificates into one workbook, rows in page order.
//   node cli/bir2307.js --client <name> --in "<file.pdf>" [--pages 1-12] [--out <folder>] [--second-pass <model>]
// --pages reads only part of the PDF (for a trial run). The workbook is named after the PDF.
// --second-pass re-reads, with a stronger model, the pages whose first reading left something in doubt.
// Each full run is also recorded in the app database, replacing an earlier run of the same PDF.
import path from "node:path";
import { parseArgs } from "node:util";
import { loadSettings, resolve } from "../engine/settings.js";
import { encodeCertificates } from "../engine/certificates.js";
import { write2307Workbook } from "../engine/workbook2307.js";
import { openDb } from "../engine/db.js";
import { registerClient } from "../engine/clients.js";

const { values: args } = parseArgs({
  options: {
    client: { type: "string" },
    in: { type: "string" },
    pages: { type: "string" },
    out: { type: "string" },
    "second-pass": { type: "string" },
  },
});

async function main() {
  if (!args.in) throw new Error('Say which PDF to read: node cli/bir2307.js --in "file.pdf"');
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new Error("No Anthropic API key. Put ANTHROPIC_API_KEY=... in the .env file next to package.json.");
  }
  const settings = loadSettings({ client: args.client });
  console.log(`Reading ${path.basename(args.in)}...`);

  const calls = [];
  let lastStage;
  const result = await encodeCertificates({
    settings,
    file: args.in,
    pages: args.pages,
    secondModel: args["second-pass"],
    onUsage: (u) => calls.push(u),
    onProgress: ({ stage, done, total }) => {
      if (stage !== lastStage) console.log(stage === "second" ? `Second reading of ${total} page(s) with ${args["second-pass"]}...` : "");
      lastStage = stage;
      if (done % 10 === 0 || done === total) console.log(`  read ${done}/${total} pages`);
    },
  });

  const out = path.join(resolve(args.out ?? path.join(settings.output, "2307")), `${result.name}.xlsx`);
  await write2307Workbook(out, result.rows);

  // Trial runs (part of the PDF, or written elsewhere) are not part of the client's record.
  if (!args.pages && !args.out) {
    const db = openDb();
    registerClient(db, settings);
    const source = path.relative(process.cwd(), resolve(args.in));
    db.replaceJobsFor({ clientId: settings.id, kind: "2307", source });
    const jobId = db.saveJob({
      clientId: settings.id,
      kind: "2307",
      source,
      options: { model: settings.model, secondModel: args["second-pass"] ?? null },
      summary: { pages: result.pages, rows: result.rows.length, reread: result.reread, cost: result.cost, clientTin: result.clientTin },
      rows: result.rows.map((r) => ({ ...r, sheet: "2307", year: null, source: path.basename(args.in) })),
    });
    for (const call of calls) db.recordUsage({ jobId, clientId: settings.id, ...call });
    db.close();
  }

  console.log(`\n${result.pages} page(s) read, client TIN ${result.clientTin ?? "unknown"}`);
  if (args["second-pass"]) console.log(`  given a second reading: ${result.reread}`);
  console.log(`  rows: ${result.rows.length}   for manual checking: ${result.rows.filter((r) => r.remarks).length}`);
  for (const [label, list] of [["not a Form 2307", result.skipped], ["FAILED", result.failed]]) {
    if (list.length) console.log(`  ${label}: ${list.length}`);
    for (const item of list) console.log(`    - page ${item.page}: ${item.reason}`);
  }
  console.log(`  workbook: ${out}`);
  console.log(`  cost of this run: about $${result.cost.toFixed(2)} (pages already read cost nothing)`);
  if (result.failed.length) process.exitCode = 2;
}

try {
  await main();
} catch (err) {
  console.error(`\nERROR: ${err.message}`);
  process.exitCode = 1;
}
