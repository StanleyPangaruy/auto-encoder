// Prints what was read from each page of a 2307 run, for spot-checking against the scans.
//   node scripts/show-2307.js "output/2307/<name>.xlsx"
import ExcelJS from "exceljs";

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(process.argv[2]);
const ws = wb.worksheets[0];
let flagged = 0;
for (let r = 3; r <= ws.rowCount; r++) {
  const v = (c) => ws.getCell(r, c).value ?? "";
  const remarks = String(v(15));
  if (remarks) flagged++;
  if (process.argv[3] === "--flagged" && !remarks) continue;
  console.log([`p${v(16)}`, v(2), v(4), String(v(5)).slice(0, 30), v(10), v(11), v(12), v(13), v(14), remarks.slice(0, 160)].join(" | "));
}
console.log(`\n${ws.rowCount - 2} rows, ${flagged} for manual checking`);
