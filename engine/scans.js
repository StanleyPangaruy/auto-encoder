// Finding and showing the scan a row was read from, for the review screen.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import { ROOT, resolve } from "./settings.js";
import { pdfPage } from "./pdfpages.js";
import { isPdf } from "./extract.js";

const RENDERED = path.join(ROOT, "data", "scans");
const VIEW_EDGE = 2200;

/** Every file under a folder, up to two levels down (raw/<client>/<batch>/<file>). */
function filesUnder(dir, depth = 2) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isFile()) out.push(full);
    else if (e.isDirectory() && depth > 0 && e.name !== "processed") out.push(...filesUnder(full, depth - 1));
  }
  return out;
}

/** The file named `name` in the client's raw folder, or null. When names repeat, the newest wins. */
export function findRawFile(rawDir, name) {
  const matches = filesUnder(resolve(rawDir)).filter((f) => path.basename(f) === name);
  return matches.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] ?? null;
}

/** The PDFs directly in the client's raw folder (where 2307 bundles live). */
export const rawPdfs = (rawDir) => filesUnder(resolve(rawDir), 0).filter((f) => /\.pdf$/i.test(f));

/**
 * One page of a scan, ready to show: { type: "image", data } (a JPEG) when it can be shown as a picture,
 * or { type: "pdf", data } (that page alone) for PDF pages that are not plain scans. Pictures are saved
 * under data/scans, so a page is prepared once.
 */
export async function renderPage(file, page = 1) {
  const stat = fs.statSync(file);
  const key = crypto.createHash("sha1").update(`${file}|${stat.size}|${stat.mtimeMs}|${page}`).digest("hex");
  const cached = path.join(RENDERED, `${key}.jpg`);
  if (fs.existsSync(cached)) return { type: "image", data: fs.readFileSync(cached) };

  let source;
  if (isPdf(file)) {
    const p = await pdfPage(file, page);
    if (p.pdf) return { type: "pdf", data: p.pdf };
    source = p.image;
  } else {
    source = fs.readFileSync(file);
  }
  const data = await sharp(source)
    .rotate()
    .resize({ width: VIEW_EDGE, height: VIEW_EDGE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
  fs.mkdirSync(RENDERED, { recursive: true });
  fs.writeFileSync(cached, data);
  return { type: "image", data };
}
