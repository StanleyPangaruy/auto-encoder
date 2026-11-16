// Prints a purchases sheet for spot-checking.
//   node scripts/show-purchases.js "<workbook>" "<sheet>" [--flagged]
import ExcelJS from "exceljs";

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(process.argv[2]);
const ws = wb.getWorksheet(process.argv[3]);
if (!ws) throw new Error(`No sheet "${process.argv[3]}". Sheets: ${wb.worksheets.map((w) => w.name).join(", ")}`);
let total = 0;
let flagged = 0;
const particulars = {};
for (let r = 3; r <= ws.rowCount; r++) {
  const v = (c) => {
    const x = ws.getCell(r, c).value;
    return x && typeof x === "object" ? "" : (x ?? "");
  };
  const remarks = String(v(19));
  if (typeof v(14) === "number") total += v(14);
  if (remarks) flagged++;
  particulars[v(13) || "(none)"] = (particulars[v(13) || "(none)"] ?? 0) + 1;
  if (process.argv[4] === "--flagged" && !remarks) continue;
  const page = /\(page (\d+)\)$/.exec(String(v(20)))?.[1];
  console.log([v(1), v(2), v(3), v(4), v(5), String(v(6)).slice(0, 30), String(v(11)).slice(0, 14), v(13), v(14), page ? `p${page}` : "", remarks.replace("FOR MANUAL CHECKING: ", "!! ").slice(0, 90)].join(" | "));
}
console.log(`\n${ws.rowCount - 2} rows, ${flagged} for manual checking, AMOUNT total ${total.toFixed(2)}`);
console.log(particulars);
