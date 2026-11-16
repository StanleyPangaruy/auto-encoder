// Encodes every document in the inbox folder into the purchases workbook.
//   node src/run.js [--client <name>] [--in <folder or file>] [--out <folder>] [--keep] [--json]
//                   [--by-page] [--second-pass <model>] [--sheet <name>]
// --by-page reads each PDF page on its own (for bundles of small receipts scanned several to a page).
// --second-pass re-reads, with a stronger model, whatever the first model could not read cleanly.
// --sheet names the sheet for file-order clients (default: the input folder or file name).
// --keep leaves the source files where they are instead of moving them to <folder>/processed.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { config, resolve, PARTICULARS } from "./config.js";
import { extractFile, extractPage, pageCount, isPdf } from "./extract.js";
import { toRow, mergeRows, cleanTin, MANUAL } from "./rows.js";
import { readWorkbook, writeWorkbook } from "./workbook.js";
import { loadSuppliers, saveSuppliers } from "./suppliers.js";

const { values: args } = parseArgs({
  options: { client: { type: "string" }, "by-page": { type: "boolean" }, "second-pass": { type: "string" }, sheet: { type: "string" }, in: { type: "string" }, out: { type: "string" }, keep: { type: "boolean" }, json: { type: "boolean" } },
});
const input = resolve(args.in ?? config.inbox);
// --in may name one file; then only that file is read.
const singleFile = fs.existsSync(input) && fs.statSync(input).isFile() ? path.basename(input) : null;
const inbox = singleFile ? path.dirname(input) : input;
// Remarks that mean the reading itself is in doubt, as opposed to a decision left to the user.
const READING_DOUBT = /UNREADABLE|COMPARE WITH PAPER|NO DATE|NO AMOUNT|DATE READ AS|TIN INCOMPLETE|PRINTED VAT|VAT STATUS UNCLEAR|BUYER'S/;
const log = (...a) => args.json || console.log(...a);

async function pool(items, size, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return results;
}

async function main() {
  fs.mkdirSync(inbox, { recursive: true });
  const files = fs
    .readdirSync(inbox, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith(".") && !e.name.startsWith("~$") && (!singleFile || e.name === singleFile))
    .map((e) => e.name)
    // The order File Explorer shows: numbers by value (9-2 before 9-10), upper and lower case together.
    .sort(new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }).compare);

  const summary = { inbox, files: files.length, secondPass: 0, encoded: 0, manualChecking: 0, duplicates: [], skipped: [], failed: [], workbooks: [] };
  if (!files.length) return summary;

  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new Error("No Anthropic API key. Put ANTHROPIC_API_KEY=... in the .env file next to package.json.");
  }

  let done = 0;
  const extracted = await pool(files, config.concurrency, async (name) => {
    const file = path.join(inbox, name);
    const secondModel = args["second-pass"];
    const doubtful = (found) => found.some((d) => d.is_purchase_document && READING_DOUBT.test(toRow(d, name).remarks));
    let docs;
    if (args["by-page"] && isPdf(file)) {
      const numbers = Array.from({ length: await pageCount(file) }, (_, i) => i + 1);
      const perPage = await pool(numbers, config.concurrency, async (n) => {
        // A page the first model cannot answer properly goes straight to the second one.
        let found = await extractPage(file, n).catch((err) => {
          if (!secondModel) throw err;
          return null;
        });
        if (secondModel && (!found || doubtful(found))) {
          found = await extractPage(file, n, secondModel);
          summary.secondPass++;
        }
        return found;
      });
      docs = [];
      perPage.forEach(({ value, error }, i) => {
        // One unreadable page must not lose the rest of the bundle.
        if (error) summary.failed.push({ file: `${name} (page ${numbers[i]})`, reason: error.message.split("\n")[0] });
        else docs.push(...value);
      });
    } else {
      docs = await extractFile(file);
      if (secondModel && doubtful(docs)) {
        docs = await extractFile(file, secondModel);
        summary.secondPass++;
      }
    }
    log(`  read ${++done}/${files.length}  ${name}`);
    return docs;
  });

  const suppliers = loadSuppliers();
  const nameKey = (s) => (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const byName = new Map([...suppliers.values()].map((s) => [nameKey(s.company), s]));
  let suppliersChanged = false;
  const byYear = new Map();
  // File-order clients get one sheet per input folder, rows in the order the files were read, nothing regrouped.
  const fileOrder = config.layout === "file-order";
  const folderSheet = (args.sheet ?? (singleFile ? path.basename(singleFile, path.extname(singleFile)) : path.basename(inbox))).toUpperCase().replace(/[\\/?*[\]:]/g, " ").slice(0, 31);
  const succeeded = [];

  files.forEach((name, i) => {
    const { value: docs, error } = extracted[i];
    if (error) {
      summary.failed.push({ file: name, reason: error.message });
      return;
    }
    succeeded.push(name);
    if (!docs.length) summary.skipped.push({ file: name, reason: "no document found" });
    for (const doc of docs) {
      if (!doc.is_purchase_document) {
        summary.skipped.push({ file: name, reason: doc.notes || "not a purchase document" });
        continue;
      }
      // A supplier already on the list under the same name keeps its listed TIN, so one misread digit
      // on a handwritten or faint scan does not create a second entry for the same company.
      const supplier = suppliers.get(cleanTin(doc.supplier_tin)) ?? byName.get(nameKey(doc.supplier_name));
      const row = toRow(doc, name, supplier);
      if (fileOrder) Object.assign(row, { sheet: folderSheet, year: null });
      if (row.tin.length === 9 && !suppliers.has(row.tin) && row.company) {
        suppliers.set(row.tin, {
          tin: row.tin, company: row.company, address: row.address, city: row.city,
          nature: row.nature, particulars: row.particulars in PARTICULARS ? row.particulars : "",
        });
        byName.set(nameKey(row.company), suppliers.get(row.tin));
        suppliersChanged = true;
      }
      if (!byYear.has(row.year)) byYear.set(row.year, []);
      byYear.get(row.year).push(row);
    }
  });

  if (fileOrder && byYear.has(null)) {
    // One workbook for the folder, named for the year most of its documents fall in.
    const rows = byYear.get(null);
    const years = rows.map((r) => /^\d{4}/.exec(r.isoDate ?? "")?.[0]).filter(Boolean);
    const year = years.sort((a, b) => years.filter((y) => y === b).length - years.filter((y) => y === a).length)[0] ?? new Date().getFullYear();
    byYear.delete(null);
    byYear.set(Number(year), rows.map((r) => ({ ...r, year: Number(year) })));
  }
  for (const [year, rows] of [...byYear].sort()) {
    const file = path.join(resolve(args.out ?? config.output), config.workbookName.replace("{year}", year));
    const sheets = await readWorkbook(file, year);
    let changed = false;
    for (const sheet of new Set(rows.map((r) => r.sheet))) {
      const incoming = rows.filter((r) => r.sheet === sheet);
      const merged = mergeRows(sheets[sheet] ?? [], incoming, { sort: !fileOrder });
      sheets[sheet] = merged.rows;
      const added = incoming.filter((r) => merged.rows.includes(r));
      if (fileOrder) {
        // A file read on a later run (after a failure, or added late) still belongs at its place in the folder order.
        const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }).compare;
        const fileOf = (row) => row.source.replace(/ (page d+)$/, "");
        const pageOf = (row) => Number(/ (page (d+))$/.exec(row.source)?.[1] ?? 1);
        merged.rows.sort((x, y) => byName(fileOf(x), fileOf(y)) || pageOf(x) - pageOf(y));
        sheets[sheet] = merged.rows;
      }
      summary.encoded += added.length;
      if (added.length || merged.droppedReceipts.length) changed = true;
      summary.manualChecking += added.filter((r) => r.remarks.startsWith(MANUAL)).length;
      for (const r of merged.duplicates) summary.duplicates.push({ file: r.source, reason: `${r.company} ${r.number} is already encoded` });
      for (const r of merged.droppedReceipts) summary.skipped.push({ file: r.source, reason: "delivery receipt with a matching invoice" });
    }
    // A run that adds nothing leaves the workbook, and its backups, alone.
    if (changed) await writeWorkbook(file, sheets);
    summary.workbooks.push(file);
  }

  if (suppliersChanged) saveSuppliers(suppliers);

  if (!args.keep) {
    const processed = path.join(inbox, "processed");
    fs.mkdirSync(processed, { recursive: true });
    for (const name of succeeded) fs.renameSync(path.join(inbox, name), path.join(processed, name));
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
  }
  if (s.failed.length && !args.json) process.exitCode = 2;
} catch (err) {
  if (args.json) console.log(JSON.stringify({ error: err.message }));
  else console.error(`\nERROR: ${err.message}`);
  // In --json mode the caller (n8n) reads the error from the output instead of the exit code.
  if (!args.json) process.exitCode = 1;
}
