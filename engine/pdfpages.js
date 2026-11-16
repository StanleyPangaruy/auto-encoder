// Splits a scanned PDF into pages and, where a page is a plain scan, recovers the scan at full resolution.
import fs from "node:fs";
import sharp from "sharp";
import { PDFDocument, PDFName, PDFRawStream } from "pdf-lib";

const name = (s) => PDFName.of(s);

// Black-and-white scans are stored as fax-compressed data. Putting a TIFF header in front of that data
// makes it an ordinary image file, which is far sharper than the page as a PDF viewer would render it.
function faxToTiff(stream) {
  const dict = stream.dict;
  const width = Number(String(dict.get(name("Width"))));
  const height = Number(String(dict.get(name("Height"))));
  let parms = dict.lookup(name("DecodeParms"));
  if (parms?.asArray) parms = parms.asArray()[0];
  const k = parms?.get ? Number(String(parms.get(name("K")) ?? 0)) : 0;
  const blackIs1 = parms?.get ? String(parms.get(name("BlackIs1"))) === "true" : false;
  const data = Buffer.from(stream.contents);

  const tags = [
    [256, 4, width],
    [257, 4, height],
    [258, 3, 1],
    [259, 3, k < 0 ? 4 : 3],
    [262, 3, blackIs1 ? 1 : 0],
    [273, 4, 8 + 2 + 9 * 12 + 4],
    [277, 3, 1],
    [278, 4, height],
    [279, 4, data.length],
  ];
  const header = Buffer.alloc(8 + 2 + tags.length * 12 + 4);
  header.write("II", 0, "latin1");
  header.writeUInt16LE(42, 2);
  header.writeUInt32LE(8, 4);
  header.writeUInt16LE(tags.length, 8);
  tags.forEach(([tag, type, value], i) => {
    const at = 10 + i * 12;
    header.writeUInt16LE(tag, at);
    header.writeUInt16LE(type, at + 2);
    header.writeUInt32LE(1, at + 4);
    if (type === 3) header.writeUInt16LE(value, at + 8);
    else header.writeUInt32LE(value, at + 8);
  });
  return Buffer.concat([header, data]);
}

function scanOf(doc, page) {
  const xobjects = page.node.Resources()?.lookup(name("XObject"));
  if (!xobjects) return null;
  const images = [];
  for (const [, ref] of xobjects.entries()) {
    const stream = doc.context.lookup(ref);
    if (!(stream instanceof PDFRawStream)) continue;
    if (String(stream.dict.get(name("Subtype"))) !== "/Image") continue;
    images.push(stream);
  }
  if (images.length !== 1) return null;
  const filter = String(images[0].dict.get(name("Filter")));
  if (filter.includes("DCTDecode")) return Buffer.from(images[0].contents);
  if (filter.includes("CCITTFaxDecode")) return faxToTiff(images[0]);
  return null;
}

/** One page of a loaded PDF: { image } when it is a single scan sharp can open, otherwise { pdf }. */
async function pageAt(source, i) {
  let image = scanOf(source, source.getPage(i));
  // A scan that will not decode falls back to the PDF page.
  if (image && !(await sharp(image).metadata().catch(() => null))) image = null;
  if (image) return { image };
  const single = await PDFDocument.create();
  const [page] = await single.copyPages(source, [i]);
  single.addPage(page);
  return { pdf: Buffer.from(await single.save()) };
}

/**
 * Returns one entry per page: { image } (a JPEG or TIFF buffer sharp can open) when the page is a single
 * scan, otherwise { pdf } (that page alone as a PDF).
 */
export async function splitPdf(file) {
  const source = await PDFDocument.load(fs.readFileSync(file));
  const pages = [];
  for (let i = 0; i < source.getPageCount(); i++) pages.push(await pageAt(source, i));
  return pages;
}

// The review screen asks for pages of the same PDF one after another; keeping the last few PDFs loaded
// saves re-reading a 200 MB bundle for every page.
const loaded = new Map();
const KEEP = 2;

/** One page (counting from 1) of a PDF, as splitPdf would return it. */
export async function pdfPage(file, pageNumber) {
  const key = `${file}|${fs.statSync(file).mtimeMs}`;
  if (!loaded.has(key)) {
    loaded.set(key, PDFDocument.load(fs.readFileSync(file)));
    while (loaded.size > KEEP) loaded.delete(loaded.keys().next().value);
  }
  const source = await loaded.get(key);
  if (pageNumber < 1 || pageNumber > source.getPageCount()) throw new Error(`The PDF has no page ${pageNumber}`);
  return pageAt(source, pageNumber - 1);
}
