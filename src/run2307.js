// Encodes a scanned PDF of BIR Form 2307 certificates into one workbook, rows in page order.
//   node src/run2307.js --client <name> --in "<file.pdf>" [--pages 1-12] [--out <folder>] [--second-pass <model>]
// --pages reads only part of the PDF (for a trial run). The workbook is named after the PDF.
// --second-pass re-reads, with a stronger model, the pages whose first reading left something in doubt.
import path from "node:path";
import { parseArgs } from "node:util";
import { config, resolve } from "./config.js";
import { splitPages, readPage, hashFile, toRows, plain } from "./bir2307.js";
import { cleanTin, MANUAL } from "./rows.js";
import { write2307Workbook } from "./workbook2307.js";

// List prices per million tokens, used only for the cost estimate printed at the end.
const PRICE = { "claude-sonnet-5-5": [2, 10], "claude-haiku-5-5": [0.1, 0.5], "claude-opus-5-5": [4, 20] };

// Remarks that put the reading itself in doubt, as opposed to how the payor filled in the certificate.
const READING_DOUBT = /UNREADABLE|PAGE COULD NOT BE READ|NO PAYOR TIN|TIN INCOMPLETE|TIN DIFFERS|NO PERIOD|NOT WITHIN ONE QUARTER|MONTH NOT SET|NOT IN THE COLUMN|DO NOT ADD UP|NO AMOUNT|NO ATC|NOT RECOGNISED|IS NOT \d+% OF 0\.00/;

const { values: args } = parseArgs({
  options: {
    client: { type: "string" },
    in: { type: "string" },
    pages: { type: "string" },
    out: { type: "string" },
    "second-pass": { type: "string" },
  },
});

const add = (row, note) => {
  row.remarks = row.remarks ? `${row.remarks}; ${note}` : `${MANUAL}: ${note}`;
};

/** Builds the sheet rows from the readings, in page order, with the checks that compare pages. */
function buildRows(numbers, results) {
  // The client is whoever most certificates are made out to; one made out to someone else gets marked.
  const counts = new Map();
  const nameCounts = new Map();
  for (const { certificate } of results.values()) {
    const tin = cleanTin(certificate.payee_tin);
    if (tin.length === 9) counts.set(tin, (counts.get(tin) ?? 0) + 1);
    const name = plain(certificate.payee_name);
    if (name) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }
  const clientTin = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  // Names the client goes by on these certificates (a sole proprietor appears under the trade name and the owner's name).
  const clientNames = new Set([...nameCounts].filter(([, n]) => n >= 3).map(([name]) => name));

  const rows = [];
  const skipped = [];
  for (const n of numbers) {
    const result = results.get(n);
    if (!result) {
      rows.push({ page: n, month: "", tin: "", company: "", last: "", first: "", middle: "", address: "", city: "", amount: null, atc: "", rate: null, wtax: null, remarks: `${MANUAL}: PAGE COULD NOT BE READ` });
      continue;
    }
    if (!result.certificate.is_form_2307) skipped.push({ page: n, reason: result.certificate.notes || "not a Form 2307" });
    rows.push(...toRows(result.certificate, n, clientTin, clientNames));
  }

  // The same payor usually appears on several pages; a TIN that differs between them means one was misread.
  const tinsByCompany = new Map();
  for (const row of rows) {
    if (!row.company || row.tin.length !== 9) continue;
    if (!tinsByCompany.has(row.company)) tinsByCompany.set(row.company, new Map());
    const tins = tinsByCompany.get(row.company);
    tins.set(row.tin, (tins.get(row.tin) ?? new Set()).add(row.page));
  }
  for (const row of rows) {
    const tins = tinsByCompany.get(row.company);
    if (!tins || tins.size < 2 || !tins.has(row.tin)) continue;
    const others = [...tins].filter(([tin]) => tin !== row.tin).map(([tin, pages]) => `${tin} ON PAGE ${[...pages].join(", ")}`);
    add(row, `TIN DIFFERS FOR THIS COMPANY (${others.join("; ")})`);
  }

  // The same payor, month and amount on two pages is often the same certificate scanned twice.
  const seen = new Map();
  for (const row of rows) {
    if (!row.company || row.amount == null) continue;
    const key = `${row.company}|${row.month}|${row.amount}|${row.wtax}`;
    if (seen.has(key) && seen.get(key) !== row.page) {
      add(row, `SAME PAYOR, MONTH AND AMOUNT AS PAGE ${seen.get(key)}, POSSIBLE DUPLICATE`);
    } else seen.set(key, row.page);
  }
  return { rows, skipped, clientTin };
}

async function readAll(numbers, read) {
  const results = new Map();
  const failed = [];
  let next = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: config.concurrency }, async () => {
      while (next < numbers.length) {
        const n = numbers[next++];
        try {
          results.set(n, await read(n));
        } catch (err) {
          failed.push({ page: n, reason: err.message.split("\n")[0] });
        }
        if (++done % 10 === 0 || done === numbers.length) console.log(`  read ${done}/${numbers.length} pages`);
      }
    }),
  );
  return { results, failed };
}

const costOf = (results, model) => {
  const [pin, pout] = PRICE[model] ?? [0, 0];
  return [...results.values()].reduce((sum, r) => sum + (r.usage.input * pin + r.usage.output * pout) / 1e6, 0);
};

async function main() {
  if (!args.in) throw new Error('Say which PDF to read: node src/run2307.js --in "file.pdf"');
  const file = resolve(args.in);
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new Error("No Anthropic API key. Put ANTHROPIC_API_KEY=... in the .env file next to package.json.");
  }

  console.log(`Splitting ${path.basename(file)} into pages...`);
  const pages = await splitPages(file);
  const [from, to] = (args.pages ?? `1-${pages.length}`).split("-").map(Number);
  const numbers = pages.map((_, i) => i + 1).filter((n) => n >= from && n <= (to || from));
  const fileHash = hashFile(file);

  const first = await readAll(numbers, (n) => readPage(fileHash, n, pages[n - 1]));
  const results = first.results;
  let cost = costOf(results, config.model);
  let built = buildRows(numbers, results);
  let failed = first.failed;

  const secondModel = args["second-pass"];
  let reread = [];
  if (secondModel) {
    reread = [...new Set(built.rows.filter((r) => READING_DOUBT.test(r.remarks)).map((r) => r.page))];
    console.log(`Second reading of ${reread.length} page(s) with ${secondModel}...`);
    const second = await readAll(reread, (n) => readPage(fileHash, n, pages[n - 1], secondModel));
    for (const [n, result] of second.results) results.set(n, result);
    cost += costOf(second.results, secondModel);
    // A page the second model read is no longer a failure of the first.
    failed = [...failed.filter((f) => !second.results.has(f.page)), ...second.failed];
    built = buildRows(numbers, results);
  }

  const out = path.join(resolve(args.out ?? path.join(config.output, "2307")), `${path.basename(file, path.extname(file))}.xlsx`);
  await write2307Workbook(out, built.rows);

  console.log(`\n${numbers.length} page(s) read, client TIN ${built.clientTin ?? "unknown"}`);
  if (secondModel) console.log(`  given a second reading: ${reread.length}`);
  console.log(`  rows: ${built.rows.length}   for manual checking: ${built.rows.filter((r) => r.remarks).length}`);
  for (const [label, list] of [["not a Form 2307", built.skipped], ["FAILED", failed]]) {
    if (list.length) console.log(`  ${label}: ${list.length}`);
    for (const item of list) console.log(`    - page ${item.page}: ${item.reason}`);
  }
  console.log(`  workbook: ${out}`);
  console.log(`  API use for these pages: about $${cost.toFixed(2)} (saved results are not charged again)`);
  if (failed.length) process.exitCode = 2;
}

try {
  await main();
} catch (err) {
  console.error(`\nERROR: ${err.message}`);
  process.exitCode = 1;
}
