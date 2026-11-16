// A BIR 2307 job: read every page of a PDF of certificates and turn them into rows in page order.
// The command line (cli/bir2307.js) and, later, the app both run jobs through these functions.
import path from "node:path";
import { resolve } from "./settings.js";
import { splitPages, readPage, hashFile, toRows, plain } from "./bir2307.js";
import { cleanTin, MANUAL } from "./rows.js";
import { pool } from "./purchases.js";

// Remarks that put the reading itself in doubt, as opposed to how the payor filled in the certificate.
export const READING_DOUBT = /UNREADABLE|PAGE COULD NOT BE READ|NO PAYOR TIN|TIN INCOMPLETE|TIN DIFFERS|NO PERIOD|NOT WITHIN ONE QUARTER|MONTH NOT SET|NOT IN THE COLUMN|DO NOT ADD UP|NO AMOUNT|NO ATC|NOT RECOGNISED|IS NOT \d+% OF 0\.00/;

const add = (row, note) => {
  row.remarks = row.remarks ? `${row.remarks}; ${note}` : `${MANUAL}: ${note}`;
};

/** Builds the sheet rows from the readings, in page order, with the checks that compare pages. */
export function buildCertificateRows(numbers, results) {
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

/**
 * Encodes a PDF of certificates. `pages` ("1-8") limits a trial run. With `secondModel`, pages whose first
 * reading left the reading in doubt are read again by that model. Returns the rows in page order, pages
 * that failed, how many pages were re-read, and the cost of this run's paid calls.
 */
export async function encodeCertificates({ settings, file, pages: range, secondModel, onProgress, onUsage }) {
  const source = resolve(file);
  const pages = await splitPages(source);
  const [from, to] = (range ?? `1-${pages.length}`).split("-").map(Number);
  const numbers = pages.map((_, i) => i + 1).filter((n) => n >= from && n <= (to || from));
  const fileHash = hashFile(source);
  let cost = 0;
  const usage = (u) => {
    cost += u.cost;
    onUsage?.(u);
  };

  const readAll = async (list, model, stage) => {
    let done = 0;
    const read = await pool(list, settings.concurrency, async (n) => {
      const result = await readPage(fileHash, n, pages[n - 1], { model, effort: settings.effort2307 ?? "high", onUsage: usage });
      onProgress?.({ stage, done: ++done, total: list.length, page: n });
      return result;
    });
    const results = new Map();
    const failed = [];
    read.forEach(({ value, error }, i) => {
      if (error) failed.push({ page: list[i], reason: error.message.split("\n")[0] });
      else results.set(list[i], value);
    });
    return { results, failed };
  };

  const first = await readAll(numbers, settings.model, "first");
  const results = first.results;
  let failed = first.failed;
  let built = buildCertificateRows(numbers, results);

  let reread = [];
  if (secondModel) {
    reread = [...new Set(built.rows.filter((r) => READING_DOUBT.test(r.remarks)).map((r) => r.page))];
    const second = await readAll(reread, secondModel, "second");
    for (const [n, result] of second.results) results.set(n, result);
    // A page the second model read is no longer a failure of the first.
    failed = [...failed.filter((f) => !second.results.has(f.page)), ...second.failed];
    built = buildCertificateRows(numbers, results);
  }

  return { ...built, failed, pages: numbers.length, reread: reread.length, cost, name: path.basename(source, path.extname(source)) };
}
