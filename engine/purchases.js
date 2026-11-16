// A purchases job: read a client's documents, turn them into rows, and add those rows to the workbooks.
// The command line (cli/purchases.js) and, later, the app both run jobs through these functions.
import fs from "node:fs";
import path from "node:path";
import { PARTICULARS, resolve } from "./settings.js";
import { createReader, pageCount, isPdf } from "./extract.js";
import { toRow, mergeRows, cleanTin, MANUAL } from "./rows.js";
import { readWorkbook, writeWorkbook } from "./workbook.js";
import { loadSuppliers } from "./suppliers.js";

// Remarks that mean the reading itself is in doubt, as opposed to a decision left to the user.
export const READING_DOUBT = /UNREADABLE|COMPARE WITH PAPER|NO DATE|NO AMOUNT|DATE READ AS|TIN INCOMPLETE|PRINTED VAT|VAT STATUS UNCLEAR|BUYER'S/;

// The order File Explorer shows: numbers by value (9-2 before 9-10), upper and lower case together.
export const byFileName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }).compare;

/** Runs `fn` over `items`, at most `size` at a time. Each result is `{ value }` or `{ error }`. */
export async function pool(items, size, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return results;
}

/** The documents to read: every file in a folder, or the one file named, in File Explorer order. */
export function listInputFiles(input) {
  const target = resolve(input);
  if (fs.existsSync(target) && fs.statSync(target).isFile()) return { dir: path.dirname(target), files: [path.basename(target)], singleFile: true };
  fs.mkdirSync(target, { recursive: true });
  const files = fs
    .readdirSync(target, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith(".") && !e.name.startsWith("~$"))
    .map((e) => e.name)
    .sort(byFileName);
  return { dir: target, files, singleFile: false };
}

/**
 * Reads every file with the client's model. With `byPage`, each PDF page is read on its own (receipt
 * bundles). With `secondModel`, a file or page whose reading leaves the reading itself in doubt is read
 * again by that model. Returns one `{ name, docs }` or `{ name, error }` per file, plus counts.
 * `onProgress({ done, total, name })` follows the files; `onUsage` receives each paid model call.
 */
export async function readPurchases({ settings, dir, files, byPage = false, secondModel, onProgress, onUsage }) {
  const reader = createReader(settings, { onUsage });
  const options = { buyerTin: settings.buyerTin, addressStyle: settings.addressStyle };
  const doubtful = (found, name) => found.some((d) => d.is_purchase_document && READING_DOUBT.test(toRow(d, name, undefined, options).remarks));
  let secondPass = 0;
  const pageFailures = [];
  let done = 0;

  const readings = await pool(files, settings.concurrency, async (name) => {
    const file = path.join(dir, name);
    let docs;
    if (byPage && isPdf(file)) {
      const numbers = Array.from({ length: await pageCount(file) }, (_, i) => i + 1);
      const perPage = await pool(numbers, settings.concurrency, async (n) => {
        // A page the first model cannot answer properly goes straight to the second one.
        let found = await reader.extractPage(file, n).catch((err) => {
          if (!secondModel) throw err;
          return null;
        });
        if (secondModel && (!found || doubtful(found, name))) {
          found = await reader.extractPage(file, n, secondModel);
          secondPass++;
        }
        return found;
      });
      docs = [];
      perPage.forEach(({ value, error }, i) => {
        // One unreadable page must not lose the rest of the bundle.
        if (error) pageFailures.push({ file: `${name} (page ${numbers[i]})`, reason: error.message.split("\n")[0] });
        else docs.push(...value);
      });
    } else {
      docs = await reader.extractFile(file);
      if (secondModel && doubtful(docs, name)) {
        docs = await reader.extractFile(file, secondModel);
        secondPass++;
      }
    }
    onProgress?.({ done: ++done, total: files.length, name });
    return docs;
  });

  return {
    readings: files.map((name, i) => (readings[i].error ? { name, error: readings[i].error } : { name, docs: readings[i].value })),
    secondPass,
    pageFailures,
  };
}

const nameKey = (s) => (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * Turns readings into rows. Rows carry `year` and `sheet` (the month, or for file-order clients the
 * `sheetName`). Updates the supplier list in memory; `suppliersChanged` says whether to save it.
 */
export function buildPurchaseRows({ settings, readings, sheetName }) {
  const suppliers = loadSuppliers(settings);
  const byName = new Map([...suppliers.values()].map((s) => [nameKey(s.company), s]));
  const options = { buyerTin: settings.buyerTin, addressStyle: settings.addressStyle };
  const fileOrder = settings.layout === "file-order";
  const rows = [];
  const skipped = [];
  const failed = [];
  let suppliersChanged = false;

  for (const { name, docs, error } of readings) {
    if (error) {
      failed.push({ file: name, reason: error.message });
      continue;
    }
    if (!docs.length) skipped.push({ file: name, reason: "no document found" });
    for (const doc of docs) {
      if (!doc.is_purchase_document) {
        skipped.push({ file: name, reason: doc.notes || "not a purchase document" });
        continue;
      }
      // A supplier already on the list under the same name keeps its listed TIN, so one misread digit
      // on a handwritten or faint scan does not create a second entry for the same company.
      const supplier = suppliers.get(cleanTin(doc.supplier_tin)) ?? byName.get(nameKey(doc.supplier_name));
      const row = toRow(doc, name, supplier, options);
      if (fileOrder) Object.assign(row, { sheet: sheetName, year: null });
      if (row.tin.length === 9 && !suppliers.has(row.tin) && row.company) {
        suppliers.set(row.tin, {
          tin: row.tin, company: row.company, address: row.address, city: row.city,
          nature: row.nature, particulars: row.particulars in PARTICULARS ? row.particulars : "",
        });
        byName.set(nameKey(row.company), suppliers.get(row.tin));
        suppliersChanged = true;
      }
      rows.push(row);
    }
  }

  if (fileOrder) {
    // One workbook for the folder, named for the year most of its documents fall in.
    const years = rows.map((r) => /^\d{4}/.exec(r.isoDate ?? "")?.[0]).filter(Boolean);
    const common = years.sort((a, b) => years.filter((y) => y === b).length - years.filter((y) => y === a).length)[0];
    const year = Number(common ?? new Date().getFullYear());
    for (const row of rows) row.year = year;
  }
  return { rows, skipped, failed, suppliers, suppliersChanged };
}

/** The sheet name a file-order client gets for an input folder or file. */
export function folderSheetName({ dir, files, singleFile }, override) {
  const base = override ?? (singleFile ? path.basename(files[0], path.extname(files[0])) : path.basename(dir));
  return base.toUpperCase().replace(/[\\/?*[\]:]/g, " ").slice(0, 31);
}

const fileOf = (row) => row.source.replace(/ \(page \d+\)$/, "");
const pageOf = (row) => Number(/ \(page (\d+)\)$/.exec(row.source)?.[1] ?? 1);

/**
 * Adds rows to the client's yearly workbooks in `outDir`, skipping documents already there.
 * `replaceFiles` (source file names) are removed from the workbooks first, so a second reading of the
 * same files replaces the first instead of being skipped as duplicates.
 * Returns what was added, what was skipped as a duplicate, and which workbooks were touched.
 */
export async function savePurchaseWorkbooks({ settings, rows, outDir, replaceFiles = [] }) {
  const replacing = new Set(replaceFiles);
  const fileOrder = settings.layout === "file-order";
  const result = { added: [], duplicates: [], droppedReceipts: [], workbooks: [] };
  const byYear = Map.groupBy(rows, (r) => r.year);

  for (const [year, yearRows] of [...byYear].sort((a, b) => a[0] - b[0])) {
    const file = path.join(resolve(outDir ?? settings.output), settings.workbookName.replace("{year}", year));
    const sheets = await readWorkbook(file, year);
    let changed = false;
    if (replacing.size) {
      for (const [sheet, existing] of Object.entries(sheets)) {
        const kept = existing.filter((r) => !replacing.has(fileOf(r)));
        if (kept.length !== existing.length) changed = true;
        sheets[sheet] = kept;
      }
    }
    for (const [sheet, incoming] of Map.groupBy(yearRows, (r) => r.sheet)) {
      const merged = mergeRows(sheets[sheet] ?? [], incoming, { sort: !fileOrder });
      if (fileOrder) {
        // A file read on a later run (after a failure, or added late) still belongs at its place in the folder order.
        merged.rows.sort((x, y) => byFileName(fileOf(x), fileOf(y)) || pageOf(x) - pageOf(y));
        for (const r of merged.rows) r.sheet = sheet;
      }
      sheets[sheet] = merged.rows;
      const added = incoming.filter((r) => merged.rows.includes(r));
      if (added.length || merged.droppedReceipts.length) changed = true;
      result.added.push(...added);
      result.duplicates.push(...merged.duplicates);
      result.droppedReceipts.push(...merged.droppedReceipts);
    }
    // A run that adds nothing leaves the workbook, and its backups, alone.
    if (changed) await writeWorkbook(file, sheets);
    result.workbooks.push(file);
  }
  result.manualChecking = result.added.filter((r) => r.remarks.startsWith(MANUAL)).length;
  return result;
}
