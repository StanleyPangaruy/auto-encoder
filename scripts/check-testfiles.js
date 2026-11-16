// Compares what the model read against the answers written in the test file names,
// e.g. "Kcei 2026-09-01 SI-9001 846.03" -> date 2026-09-01, number 9001, amount 846.03.
//   node scripts/check-testfiles.js [folder]   (default: raw/CYA/2026-09)
import fs from "node:fs";
import path from "node:path";
import { config, resolve } from "../src/config.js";
import { extractFile } from "../src/extract.js";
import { cleanNumber } from "../src/rows.js";

const dir = resolve(process.argv[2] ?? "raw/CYA/2026-09");
const NAME = /^(.+?) (\d{4}-\d{2}-\d{2}) (?:[A-Z]{2}-)?(\d+) ([\d,]+(?:\.\d+)?)[_ ]*(?:\.?(?:png|jpe?g))?$/i;

const files = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile()).sort();
const totals = { date: [0, 0, 0], number: [0, 0, 0], amount: [0, 0, 0] };
const problems = [];
let queue = [...files];

async function check(name) {
  const expected = NAME.exec(name);
  let docs;
  try {
    docs = await extractFile(path.join(dir, name));
  } catch (err) {
    problems.push(`${name}\n    FAILED: ${err.message}`);
    return;
  }
  if (!expected) {
    const what = docs.map((d) => (d.is_purchase_document ? `${d.doc_type} ${d.supplier_name}` : `not a purchase: ${d.notes}`));
    problems.push(`${name}\n    no answer in the file name; model saw: ${what.join(" | ") || "nothing"}`);
    return;
  }
  const doc = docs.find((d) => d.is_purchase_document) ?? {};
  const want = { date: expected[2], number: cleanNumber(expected[3]), amount: Number(expected[4].replace(/,/g, "")) };
  const got = { date: doc.date, number: cleanNumber(doc.number), amount: doc.total_amount };
  const diffs = [];
  for (const field of Object.keys(want)) {
    totals[field][1]++;
    if (got[field] === want[field]) totals[field][0]++;
    else {
      if (got[field] != null && got[field] !== "") totals[field][2]++;
      diffs.push(`${field}: read ${got[field] ?? "(blank)"}, file name says ${want[field]}`);
    }
  }
  if (diffs.length) problems.push(`${name}\n    ${diffs.join("\n    ")}${doc.illegible_fields?.length ? `\n    marked unreadable: ${doc.illegible_fields.join(", ")}` : ""}`);
}

await Promise.all(Array.from({ length: config.concurrency }, async () => {
  while (queue.length) await check(queue.shift());
}));

console.log(`Checked ${files.length} files in ${dir}\n`);
console.log(`Model: ${config.model}
`);
for (const [field, [ok, n, wrong]] of Object.entries(totals)) {
  console.log(`  ${field.padEnd(7)} ${ok}/${n} correct, ${n - ok - wrong} left blank, ${wrong} wrong`);
}
if (problems.length) console.log(`\nDifferences:\n\n${problems.sort().join("\n\n")}`);
