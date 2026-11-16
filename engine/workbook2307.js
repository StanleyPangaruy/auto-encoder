import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { MANUAL } from "./rows.js";

const HEADERS = ["NO.", "MONTH", "YR", "TIN", "COMPANY", "LN", "FN", "MN", "ADDRESS", "CITY", "AMOUNT", "ATC", "RATE", "WTAX", "REMARKS", "PAGE"];
const WIDTHS = [6, 9, 6, 12, 46, 12, 12, 12, 70, 18, 14, 9, 7, 12, 60, 7];
const COL = Object.fromEntries(HEADERS.map((h, i) => [h, i + 1]));
const FIRST_DATA_ROW = 3;
const MONEY = "#,##0.00";
const fill = (argb) => ({ type: "pattern", pattern: "solid", fgColor: { argb } });

/** Writes the 2307 list in the order given. Columns A to N match the user's sheet; REMARKS and PAGE are extras. */
export async function write2307Workbook(file, rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("2307", { views: [{ state: "frozen", ySplit: 2 }] });
  ws.columns = WIDTHS.map((width) => ({ width }));
  const last = Math.max(FIRST_DATA_ROW, FIRST_DATA_ROW + rows.length - 1);

  ws.getCell(1, COL.CITY).value = "TOTAL";
  for (const h of ["AMOUNT", "ATC", "RATE", "WTAX"]) ws.getCell(1, COL[h]).fill = fill("FFFFFF00");
  for (const h of ["AMOUNT", "WTAX"]) {
    const letter = ws.getColumn(COL[h]).letter;
    ws.getCell(1, COL[h]).value = { formula: `SUM(${letter}${FIRST_DATA_ROW}:${letter}${last})` };
    ws.getCell(1, COL[h]).numFmt = MONEY;
  }

  HEADERS.forEach((h, i) => {
    const cell = ws.getCell(2, i + 1);
    cell.value = h;
    cell.font = { bold: true };
    cell.alignment = { horizontal: "center" };
    cell.fill = fill("FF9BC2E6");
  });
  ws.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: HEADERS.length } };

  rows.forEach((row, i) => {
    const r = FIRST_DATA_ROW + i;
    const set = (h, value) => {
      const cell = ws.getCell(r, COL[h]);
      if (value !== "" && value != null) cell.value = value;
      return cell;
    };
    set("NO.", i + 1);
    set("MONTH", row.month);
    // Text, so TINs like "000313401" keep their leading zeros. YR stays empty by the user's choice.
    set("TIN", row.tin).numFmt = "@";
    set("COMPANY", row.company);
    set("LN", row.last);
    set("FN", row.first);
    set("MN", row.middle);
    set("ADDRESS", row.address);
    set("CITY", row.city);
    set("AMOUNT", row.amount).numFmt = MONEY;
    set("ATC", row.atc);
    set("RATE", row.rate).numFmt = "0%";
    set("WTAX", row.wtax).numFmt = MONEY;
    set("REMARKS", row.remarks);
    set("PAGE", row.page);
    if (row.remarks.startsWith(MANUAL)) {
      for (let c = 1; c <= HEADERS.length; c++) ws.getCell(r, c).fill = fill("FFFCE4D6");
    }
  });

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await wb.xlsx.writeFile(tmp);
  try {
    if (fs.existsSync(file)) {
      const backupDir = path.join(path.dirname(file), "backup");
      fs.mkdirSync(backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      fs.copyFileSync(file, path.join(backupDir, `${path.basename(file, ".xlsx")} ${stamp}.xlsx`));
    }
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    if (["EBUSY", "EPERM", "EACCES"].includes(err.code)) {
      throw new Error(`${path.basename(file)} is open in Excel. Close it and run again; nothing was lost.`);
    }
    throw err;
  }
}

/** Reads a 2307 list back, including any corrections typed into it in Excel. */
export async function read2307Workbook(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.worksheets[0];
  const value = (r, h) => {
    const v = ws.getCell(r, COL[h]).value;
    return v && typeof v === "object" ? (v.result ?? v.text ?? null) : v;
  };
  const text = (r, h) => String(value(r, h) ?? "").trim();
  const number = (r, h) => {
    const v = value(r, h);
    return v === null || v === "" || isNaN(Number(v)) ? null : Number(v);
  };
  const rows = [];
  for (let r = FIRST_DATA_ROW; r <= ws.rowCount; r++) {
    if (!text(r, "COMPANY") && !text(r, "TIN") && number(r, "AMOUNT") == null && !text(r, "REMARKS")) continue;
    rows.push({
      page: number(r, "PAGE"),
      month: text(r, "MONTH"),
      tin: text(r, "TIN"),
      company: text(r, "COMPANY"),
      last: text(r, "LN"),
      first: text(r, "FN"),
      middle: text(r, "MN"),
      address: text(r, "ADDRESS"),
      city: text(r, "CITY"),
      amount: number(r, "AMOUNT"),
      atc: text(r, "ATC"),
      rate: number(r, "RATE"),
      wtax: number(r, "WTAX"),
      remarks: text(r, "REMARKS"),
    });
  }
  return rows;
}
