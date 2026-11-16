import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { saveWorkbookFile } from "./savefile.js";
import { MONTHS, UNDATED } from "./settings.js";
import { MANUAL } from "./rows.js";

const HEADERS = [
  "SN", "MONTH", "DATE", "SI/OR", "TIN", "COMPANY NAME", "LAST", "FIRST", "MIDDLE", "ADDRESS", "CITY",
  "NATURE", "PARTICULARS", "AMOUNT", "NET OF VAT", "INPUT VAT", "NON VAT", "CHECKING", "REMARKS", "SOURCE FILE",
];
const WIDTHS = [5, 8, 6, 10, 11, 38, 10, 10, 10, 16, 16, 10, 24, 13, 13, 13, 11, 11, 48, 44];
const COL = Object.fromEntries(HEADERS.map((h, i) => [h, i + 1]));
const FIRST_DATA_ROW = 3;
const MONEY = "#,##0.00";
const BLUE = { argb: "FF0070C0" };
const RED = { argb: "FFFF0000" };
const fill = (argb) => ({ type: "pattern", pattern: "solid", fgColor: { argb } });

const SHEET_ORDER = [...MONTHS, UNDATED];

const text = (cell) => {
  const v = cell.value;
  if (v == null) return "";
  if (typeof v === "object") return String(v.result ?? v.text ?? "").trim();
  return String(v).trim();
};
const number = (cell) => {
  const v = cell.value && typeof cell.value === "object" ? cell.value.result : cell.value;
  return typeof v === "number" ? v : v == null || v === "" || isNaN(Number(v)) ? null : Number(v);
};

function readSheet(ws, year) {
  const rows = [];
  for (let r = FIRST_DATA_ROW; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const cell = (h) => row.getCell(COL[h]);
    const amount = number(cell("AMOUNT"));
    // A row is kept if anything identifies it, including a fully unreadable receipt that has only its
    // remarks and source file; only a truly empty line is skipped.
    if (!text(cell("COMPANY NAME")) && !text(cell("SI/OR")) && amount == null && !text(cell("REMARKS")) && !text(cell("SOURCE FILE"))) continue;
    // A formula in NET OF VAT means the row is still on the automatic 12% split.
    const auto = Boolean(cell("NET OF VAT").formula);
    rows.push({
      year,
      sheet: ws.name,
      month: text(cell("MONTH")),
      day: text(cell("DATE")),
      number: text(cell("SI/OR")),
      tin: text(cell("TIN")),
      company: text(cell("COMPANY NAME")),
      last: text(cell("LAST")),
      first: text(cell("FIRST")),
      middle: text(cell("MIDDLE")),
      address: text(cell("ADDRESS")),
      city: text(cell("CITY")),
      nature: text(cell("NATURE")),
      particulars: text(cell("PARTICULARS")),
      amount,
      vat: auto ? "auto" : "manual",
      net: auto ? null : number(cell("NET OF VAT")),
      inputVat: auto ? null : number(cell("INPUT VAT")),
      nonVat: number(cell("NON VAT")),
      remarks: text(cell("REMARKS")),
      source: text(cell("SOURCE FILE")),
    });
  }
  return rows;
}

/** Reads the rows already in a year's workbook, keyed by sheet name. Edits made in Excel are kept. */
export async function readWorkbook(file, year) {
  const sheets = {};
  if (!fs.existsSync(file)) return sheets;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  for (const ws of wb.worksheets) {
    // Any sheet with this layout is ours: month sheets, or a sheet named after a folder for file-order clients.
    if (text(ws.getCell(2, COL.SN)) === "SN") sheets[ws.name] = readSheet(ws, year);
  }
  return sheets;
}

function writeSheet(wb, name, rows) {
  const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 2 }] });
  ws.columns = WIDTHS.map((width) => ({ width }));
  const last = Math.max(FIRST_DATA_ROW, FIRST_DATA_ROW + rows.length - 1);

  ws.getCell(1, COL.PARTICULARS).value = "TOTAL";
  ws.getCell(1, COL.PARTICULARS).font = { color: BLUE };
  for (const h of ["AMOUNT", "NET OF VAT", "INPUT VAT", "NON VAT"]) {
    const letter = ws.getColumn(COL[h]).letter;
    const cell = ws.getCell(1, COL[h]);
    cell.value = { formula: `SUM(${letter}${FIRST_DATA_ROW}:${letter}${last})` };
    cell.numFmt = MONEY;
    cell.fill = fill("FFFFFF00");
  }

  HEADERS.forEach((h, i) => {
    const cell = ws.getCell(2, i + 1);
    cell.value = h;
    cell.font = { bold: true, color: h === "CHECKING" ? RED : h === "NATURE" || h === "PARTICULARS" ? BLUE : undefined };
    cell.alignment = { horizontal: "center" };
  });

  rows.forEach((row, i) => {
    const r = FIRST_DATA_ROW + i;
    const set = (h, value) => {
      const cell = ws.getCell(r, COL[h]);
      if (value !== "" && value != null) cell.value = value;
      return cell;
    };
    set("SN", i + 1);
    set("MONTH", row.month);
    // Stored as text so "07" and TINs like "010388423" keep their leading zeros.
    for (const [h, v] of [["DATE", row.day], ["SI/OR", row.number], ["TIN", row.tin]]) set(h, v).numFmt = "@";
    set("COMPANY NAME", row.company);
    set("LAST", row.last);
    set("FIRST", row.first);
    set("MIDDLE", row.middle);
    set("ADDRESS", row.address);
    set("CITY", row.city);
    set("NATURE", row.nature).font = { color: BLUE };
    set("PARTICULARS", row.particulars).font = { color: BLUE };
    set("AMOUNT", row.amount).numFmt = MONEY;
    if (row.vat === "auto") {
      set("NET OF VAT", { formula: `ROUND(N${r}/1.12,2)` }).numFmt = MONEY;
      set("INPUT VAT", { formula: `N${r}-O${r}` }).numFmt = MONEY;
    } else {
      set("NET OF VAT", row.net).numFmt = MONEY;
      set("INPUT VAT", row.inputVat).numFmt = MONEY;
    }
    set("NON VAT", row.nonVat).numFmt = MONEY;
    const checking = set("CHECKING", { formula: `N${r}-O${r}-P${r}-Q${r}` });
    checking.numFmt = MONEY;
    checking.font = { color: RED };
    set("REMARKS", row.remarks);
    set("SOURCE FILE", row.source);

    if (row.remarks.startsWith(MANUAL)) {
      for (let c = 1; c <= HEADERS.length; c++) ws.getCell(r, c).fill = fill("FFFCE4D6");
    }
  });
}

/** Writes a year's workbook, one sheet per month, keeping a backup of the previous file. */
export async function writeWorkbook(file, sheets, options = {}) {
  const wb = new ExcelJS.Workbook();
  const names = [...SHEET_ORDER.filter((n) => n in sheets), ...Object.keys(sheets).filter((n) => !SHEET_ORDER.includes(n))];
  for (const name of names) {
    if (sheets[name]?.length) writeSheet(wb, name, sheets[name]);
  }
  // Open on the newest sheet (the latest month, or the last folder sheet), not the first tab,
  // so the month just encoded is what the user sees.
  const written = wb.worksheets.map((ws) => ws.name);
  const latest = written.filter((n) => n !== UNDATED).at(-1) ?? written.at(-1);
  if (latest) {
    const active = written.indexOf(latest);
    wb.worksheets.forEach((ws, i) => (ws.views = [{ ...ws.views[0], tabSelected: i === active }]));
    wb.views = [{ x: 0, y: 0, width: 20000, height: 12000, firstSheet: 0, activeTab: active, visibility: "visible" }];
  }
  // options.backupEvery: see saveWorkbookFile.
  await saveWorkbookFile(wb, file, options);
}
