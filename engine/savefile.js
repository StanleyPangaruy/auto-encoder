// Saving a workbook safely: write to a temporary file, keep a backup of the previous version, then swap.
import fs from "node:fs";
import path from "node:path";

function newestBackup(backupDir, stem) {
  if (!fs.existsSync(backupDir)) return 0;
  let newest = 0;
  for (const name of fs.readdirSync(backupDir)) {
    if (name.startsWith(`${stem} `) && name.endsWith(".xlsx")) newest = Math.max(newest, fs.statSync(path.join(backupDir, name)).mtimeMs);
  }
  return newest;
}

/**
 * Writes an ExcelJS workbook to `file`. The previous version is copied to backup/ first, unless one was
 * taken less than `backupEvery` milliseconds ago (the review screen saves often and needs only a few).
 */
export async function saveWorkbookFile(wb, file, { backupEvery = 0 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await wb.xlsx.writeFile(tmp);
  try {
    if (fs.existsSync(file)) {
      const backupDir = path.join(path.dirname(file), "backup");
      const stem = path.basename(file, ".xlsx");
      if (Date.now() - newestBackup(backupDir, stem) >= backupEvery) {
        fs.mkdirSync(backupDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        fs.copyFileSync(file, path.join(backupDir, `${stem} ${stamp}.xlsx`));
      }
    }
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    if (["EBUSY", "EPERM", "EACCES"].includes(err.code)) {
      throw Object.assign(new Error(`${path.basename(file)} is open in Excel. Close it and try again; nothing was lost.`), { statusCode: 423 });
    }
    throw err;
  }
}
