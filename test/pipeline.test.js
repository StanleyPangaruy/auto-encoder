import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { toRow, mergeRows, cleanNumber, cleanTin, MANUAL } from "../engine/rows.js";
import { readWorkbook, writeWorkbook } from "../engine/workbook.js";

const TODAY = new Date(2026, 9, 10);
// CYA's settings, which these cases were written against.
const OPTS = { buyerTin: "010786993", addressStyle: undefined, today: TODAY };
const doc = (over) => ({
  doc_type: "sales_invoice", is_purchase_document: true, date: "2026-09-01", number: "0009001",
  supplier_name: "KC Electrical Innovation Inc.", supplier_tin: "008-470-463-00001",
  last_name: null, first_name: null, middle_name: null, address: "Santa Cruz", city: "Manila",
  total_amount: 846.03, vat_status: "vat", printed_vat_amount: 90.65, particulars: "INVENTORY",
  illegible_fields: [], confidence: "high", notes: "", ...over,
});

test("a clean VAT invoice becomes an automatic row", () => {
  const row = toRow(doc(), "kcei.png", undefined, OPTS);
  assert.deepEqual(
    [row.sheet, row.day, row.number, row.tin, row.company, row.nature, row.amount, row.vat, row.remarks],
    ["SEP", "01", "9001", "008470463", "KC ELECTRICAL INNOVATION INC.", "GOODS", 846.03, "auto", ""],
  );
});

test("unreadable, non-VAT and mismatched documents are marked for manual checking", () => {
  const unreadable = toRow(doc({ total_amount: null, illegible_fields: ["total_amount"] }), "a", undefined, OPTS);
  assert.match(unreadable.remarks, /^FOR MANUAL CHECKING: UNREADABLE TOTAL AMOUNT$/);

  const nonVat = toRow(doc({ vat_status: "non_vat", printed_vat_amount: null }), "b", undefined, OPTS);
  assert.equal(nonVat.vat, "manual");
  assert.match(nonVat.remarks, /NON-VAT SUPPLIER/);

  const mismatch = toRow(doc({ printed_vat_amount: 50 }), "c", undefined, OPTS);
  assert.match(mismatch.remarks, /PRINTED VAT 50.00 IS NOT 12% OF AMOUNT/);

  const buyerTin = toRow(doc({ supplier_tin: "010-786-993-00001" }), "d", undefined, OPTS);
  assert.equal(buyerTin.tin, "");
});

test("the supplier list overrides what was read", () => {
  const row = toRow(doc({ particulars: null }), "a", { company: "KCEI", address: "", city: "MANILA", nature: "GOODS", particulars: "INVENTORY" }, OPTS);
  assert.deepEqual([row.company, row.particulars, row.remarks], ["KCEI", "INVENTORY", ""]);
});

test("number and TIN clean-up", () => {
  assert.equal(cleanNumber("SI-0009001"), "9001");
  assert.equal(cleanNumber("No. 379241"), "379241");
  assert.equal(cleanTin("000-320-426-00000"), "000320426");
});

test("merging skips duplicates, drops matched delivery receipts and sorts", () => {
  const a = toRow(doc({ date: "2026-09-16", number: "9292", total_amount: 1009.8, printed_vat_amount: null }), "a", undefined, OPTS);
  const b = toRow(doc(), "b", undefined, OPTS);
  const dup = toRow(doc(), "b-again", undefined, OPTS);
  const dr = toRow(doc({ doc_type: "delivery_receipt", number: "DR-55", printed_vat_amount: null }), "dr", undefined, OPTS);
  const lone = toRow(doc({ doc_type: "delivery_receipt", number: "DR-56", total_amount: 5, printed_vat_amount: null }), "dr2", undefined, OPTS);
  const bill = toRow(doc({ number: null, supplier_name: "MERALCO", supplier_tin: null, date: "2026-09-02", total_amount: 8997, printed_vat_amount: null, particulars: "UTILITIES EXPENSE" }), "bill", undefined, OPTS);

  const merged = mergeRows([], [bill, a, b, dup, dr, lone]);
  assert.deepEqual(merged.rows.map((r) => r.source), ["b", "dr2", "a", "bill"]);
  assert.deepEqual(merged.duplicates.map((r) => r.source), ["b-again"]);
  assert.deepEqual(merged.droppedReceipts.map((r) => r.source), ["dr"]);
});

test("the workbook round-trips, keeps Excel edits and matches the sheet layout", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "encoder-"));
  const file = path.join(dir, "PURCHASES 2026.xlsx");
  const rows = [
    toRow(doc(), "kcei.png", undefined, OPTS),
    toRow(doc({ number: "7555", supplier_name: "Puregold", supplier_tin: "201-277-095-00338", vat_status: "non_vat", printed_vat_amount: null, total_amount: 263 }), "p.png", undefined, OPTS),
  ];
  await writeWorkbook(file, { SEP: mergeRows([], rows).rows });

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.getWorksheet("SEP");
  assert.equal(ws.getCell("M1").value, "TOTAL");
  assert.equal(ws.getCell("N1").formula, "SUM(N3:N4)");
  assert.deepEqual([ws.getCell("A2").value, ws.getCell("R2").value], ["SN", "CHECKING"]);
  assert.equal(ws.getCell("O4").formula, "ROUND(N4/1.12,2)");
  assert.equal(ws.getCell("P4").formula, "N4-O4");
  assert.equal(ws.getCell("R4").formula, "N4-O4-P4-Q4");
  assert.equal(ws.getCell("E4").value, "008470463");
  assert.equal(ws.getCell("O3").value, null, "non-VAT row leaves the VAT cells empty");
  assert.ok(String(ws.getCell("S3").value).startsWith(MANUAL));

  // The user resolves the non-VAT row by hand in Excel.
  ws.getCell("Q3").value = 263;
  ws.getCell("S3").value = null;
  await wb.xlsx.writeFile(file);

  const sheets = await readWorkbook(file, 2026);
  const again = mergeRows(sheets.SEP, [toRow(doc(), "kcei-rescan.png", undefined, OPTS)]);
  assert.equal(again.duplicates.length, 1);
  await writeWorkbook(file, { SEP: again.rows });

  const after = (await readWorkbook(file, 2026)).SEP;
  assert.equal(after.length, 2);
  assert.deepEqual([after[0].nonVat, after[0].vat, after[0].remarks], [263, "manual", ""]);
  assert.equal(after[1].vat, "auto");
  assert.equal(fs.readdirSync(path.join(dir, "backup")).length, 1);
  fs.rmSync(dir, { recursive: true });
});

test("an unreadable row with only remarks survives being read back", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "encoder-"));
  const file = path.join(dir, "PURCHASES 2026.xlsx");
  const blank = toRow(doc({ number: null, supplier_name: null, supplier_tin: null, total_amount: null, date: null, illegible_fields: ["supplier_name", "total_amount"] }), "receipts.pdf (page 30)", undefined, OPTS);
  await writeWorkbook(file, { RECEIPTS: [toRow(doc(), "a.pdf", undefined, OPTS), blank] });
  const back = await readWorkbook(file, 2026);
  assert.equal(back.RECEIPTS.length, 2);
  fs.rmSync(dir, { recursive: true });
});
