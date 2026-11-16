import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import sharp from "sharp";
import { config, PARTICULARS, ROOT } from "./config.js";
import { splitPdf } from "./pdfpages.js";

// One folder per model, so trying another model never reuses or overwrites these answers.
const cacheDir = (model) => path.join(ROOT, "data", "cache", ...(config.client ? [config.client] : []), model);
const MAX_IMAGE_EDGE = 2400;
const MAX_PDF_BYTES = 30 * 1024 * 1024;
// The most a single non-streamed answer may be; a long bundle that needs more is read page by page instead.
const MAX_TOKENS = 21000;

const FIELDS = ["date", "number", "supplier_name", "supplier_tin", "address", "total_amount"];

const Document = z.object({
  first_page: z.number().nullable(),
  doc_type: z.enum([
    "sales_invoice",
    "official_receipt",
    "billing_invoice",
    "delivery_receipt",
    "bill_statement",
    "ebill",
    "other",
  ]),
  is_purchase_document: z.boolean(),
  made_out_to: z.string().nullable(),
  date: z.string().nullable(),
  number: z.string().nullable(),
  supplier_name: z.string().nullable(),
  supplier_tin: z.string().nullable(),
  last_name: z.string().nullable(),
  first_name: z.string().nullable(),
  middle_name: z.string().nullable(),
  address: z.string().nullable(),
  city: z.string().nullable(),
  total_amount: z.number().nullable(),
  vat_status: z.enum(["vat", "non_vat", "exempt_or_mixed", "unclear"]),
  printed_vat_amount: z.number().nullable(),
  particulars: z.enum(Object.keys(PARTICULARS)).nullable(),
  // Plain strings: a smaller model sometimes names a field outside FIELDS, which should not fail the whole file.
  illegible_fields: z.array(z.string()),
  confidence: z.enum(["high", "medium", "low"]),
  notes: z.string(),
});

const Extraction = z.object({ documents: z.array(Document) });

// Two address styles: the first client keeps only the district; others keep the whole street address.
const ADDRESS_RULES =
  config.addressStyle === "full"
    ? `- address: the supplier's address as printed in the header, without its last part (the city or province) and without the zip code or country. For "Block 13 Lot 5 Mindanao Ave, Gavino Maderan, General Mariano Alvarez, Cavite" this is "BLOCK 13 LOT 5 MINDANAO AVE GAVINO MADERAN GENERAL MARIANO ALVAREZ".
- city: the last part of the supplier's address: the province for an address outside Metro Manila (CAVITE, LAGUNA, BULACAN), or the city for one inside it (QUEZON CITY, MANILA).`
    : `- address: the district or municipality from the supplier's address, such as BINONDO, SANTA CRUZ, MORONG.
- city: the city or province from the supplier's address, such as MANILA, CALOOCAN CITY, RIZAL.`;

const SYSTEM = `You read scanned and photographed Philippine business documents for a bookkeeper who encodes purchases for VAT reporting.

The bookkeeper works for the BUYER: ${config.buyerName}${config.buyerTin ? ` (TIN ${config.buyerTin})` : ""}. The buyer's name, TIN and address appear in the "Sold to" section of most documents. They are never the supplier's details.

The file may contain one document or several (a multi-page PDF, or several receipts in one photo). Return one entry per document, in the order they appear. A long invoice can run over several pages ("Page 1 of 3", with the grand total on the last page); that is one document, not one per page. Two pages with different invoice numbers are two documents.

What each field means:
- first_page: the page of the file the document starts on, counting from 1.
- doc_type: the kind of document, from its printed title.
- is_purchase_document: true when a supplier issued it to the buyer for goods or services (sales invoice, official receipt, billing invoice, delivery receipt, utility bill, e-bill). A till receipt from a restaurant, gas station or shop counts even when its customer name lines are blank. False for anything else, such as the buyer's own sales records, ledger pages, purchase orders, or unrelated pages. For a false entry, describe what the page is in notes and leave the other fields null.
- made_out_to: the customer name written on the document when it is someone other than the buyer. Null when the customer lines are blank or name the buyer. Such a document is still a purchase document here: the bookkeeper decides whether it belongs.
- date: the document date as YYYY-MM-DD. Handwritten dates are month-day-year, so "9-3-26" is 2026-09-03. Use the document date, not the print-run or permit dates in the footer.
- number: the invoice or receipt serial number exactly as printed, digits only, keeping leading zeros (the red or stamped "No."). Null for bills that have none. Ignore handwritten reference notes elsewhere on the page.
- supplier_name: the supplier's registered name as printed in the header.
- On a till receipt the supplier is the business named at the top with its VAT Reg TIN. The POS provider or machine supplier printed in the footer (with its own TIN and accreditation number) is not the supplier.
- supplier_tin: the supplier's TIN from the header ("VAT Reg. TIN" or "Non-VAT Reg. TIN"), as printed. Not the printer's TIN in the footer.
- last_name, first_name, middle_name: fill these only when the supplier is an individual with no business name. Otherwise null.
${ADDRESS_RULES}
- total_amount: the final amount payable (Total Amount Due, VAT inclusive). When the line items add up to more than the written total, the written total is the one to use. When a total has been crossed out and a new figure written beside it, the new figure is the amount; say so in notes.
- vat_status: "vat" when the supplier is VAT registered and the sale is an ordinary VATable sale. "non_vat" when the header says Non-VAT. "exempt_or_mixed" when any VAT-exempt or zero-rated amount is filled in. "unclear" when you cannot tell.
- printed_vat_amount: the VAT amount written on the document, when one is filled in.
- particulars: what the purchase is for the buyer. INVENTORY is merchandise or materials for resale or jobs (for this buyer: ${config.inventoryHint ?? "electrical goods, hardware, appliances"}). OFFICE SUPPLIES is consumables for the office. FUEL AND OIL is gasoline, diesel and lubricants. UTILITIES EXPENSE is electricity, water, telephone, internet. REPRESENTATION EXPENSE is restaurant and other dine-in or take-out food receipts, and nothing else. Null when none of these fits.

Accuracy matters more than completeness, because these figures go into tax filings. Read handwriting when you can make it out with confidence. When a field is present but you cannot read it reliably, set it to null and add its name to illegible_fields (one of: ${FIELDS.join(", ")}); a blank the bookkeeper fills in by hand is far better than a wrong digit. When a field simply is not on the document, set it to null and leave it out of illegible_fields. Set confidence to "low" when the scan is poor enough that the bookkeeper should compare the whole row against the paper. Use notes for anything the bookkeeper should know, in one short sentence, or an empty string.`;

let client;
const getClient = () => (client ??= new Anthropic());

// File extensions are unreliable (some scans have none), so sharp sniffs the real format.
function toJpeg(buf, maxEdge) {
  return sharp(buf)
    .rotate()
    .resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer()
    .catch(() => {
      throw new Error("not a PDF or a readable image");
    });
}

async function toContentBlock(file) {
  const buf = fs.readFileSync(file);
  if (buf.subarray(0, 4).toString("latin1") === "%PDF") {
    if (buf.length > MAX_PDF_BYTES) throw new Error("PDF is larger than 30 MB; split it into smaller files");
    return {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: buf.toString("base64") },
    };
  }
  const jpeg = await toJpeg(buf, MAX_IMAGE_EDGE);
  return { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpeg.toString("base64") } };
}

const imageBlock = (jpeg) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpeg.toString("base64") } });
const pdfBlock = (pdf) => ({ type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf.toString("base64") } });

async function callModel(blocks, instruction, model = config.model) {
  const response = await getClient().messages.parse({
    model,
    max_tokens: MAX_TOKENS,
    output_config: { effort: config.effort, format: zodOutputFormat(Extraction) },
    system: SYSTEM,
    messages: [{ role: "user", content: [...blocks, { type: "text", text: instruction }] }],
  });
  if (response.stop_reason === "refusal") throw new Error("the model declined to read this file");
  if (response.stop_reason === "max_tokens") throw new TooLong();
  if (!response.parsed_output) throw new Error("the model returned an unreadable answer");
  return response.parsed_output.documents;
}

class TooLong extends Error {}

const WHOLE_FILE = "Extract every document in this file.";
const ONE_PAGE = `Extract every document on this page. The first image is the whole page. The two that follow are its left and right halves, enlarged; read digits from those. They show the same receipts as the whole page, so list each receipt once.`;

// A page that is a plain scan is sent as images: the whole page for layout, then each half enlarged,
// since small till receipts are usually scanned two to a page and their print is tiny.
async function pageBlocks(page) {
  if (page.pdf) return [pdfBlock(page.pdf)];
  const { width, height } = await sharp(page.image).metadata();
  const jpeg = (pipeline, edge) => pipeline.resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
  const half = Math.ceil(width / 2);
  // The halves overlap a little so a receipt sitting near the middle is not cut through its figures.
  const overlap = Math.round(width * 0.06);
  return [
    imageBlock(await jpeg(sharp(page.image), 1500)),
    imageBlock(await jpeg(sharp(page.image).extract({ left: 0, top: 0, width: half + overlap, height }), MAX_IMAGE_EDGE)),
    imageBlock(await jpeg(sharp(page.image).extract({ left: half - overlap, top: 0, width: width - half + overlap, height }), MAX_IMAGE_EDGE)),
  ];
}

const hashOf = (file) => crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex");

function cached(file, load) {
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8")).documents;
  return load().then((documents) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ documents }, null, 2));
    return documents;
  });
}

const pagesOf = new Map();
const pages = (file) => pagesOf.get(file) ?? pagesOf.set(file, splitPdf(file)).get(file);

/** How many pages a PDF has. */
export const pageCount = async (file) => (await pages(file)).length;

/**
 * Reads one page of a PDF on its own, with the given model. Used for bundles of small receipts, and to
 * give a page a second reading by a stronger model. Cached per model and page.
 */
export async function extractPage(file, pageNumber, model = config.model) {
  const cacheFile = path.join(cacheDir(model), `${hashOf(file)}-p${String(pageNumber).padStart(4, "0")}.json`);
  const documents = await cached(cacheFile, async () => callModel(await pageBlocks((await pages(file))[pageNumber - 1]), ONE_PAGE, model));
  return documents.map((d) => ({ ...d, first_page: pageNumber }));
}

// A bundle can be too long for one answer. Reading it a page at a time always fits,
// at the cost of treating each page as its own document.
async function readPageByPage(file, model) {
  const documents = [];
  for (let n = 1; n <= (await pageCount(file)); n++) documents.push(...(await extractPage(file, n, model)));
  return documents;
}

/** Returns the documents found in a whole file. Results are cached by file content, so re-runs cost nothing. */
export async function extractFile(file, model = config.model) {
  return cached(path.join(cacheDir(model), `${hashOf(file)}.json`), async () =>
    callModel([await toContentBlock(file)], WHOLE_FILE, model).catch((err) => {
      if (err instanceof TooLong) return readPageByPage(file, model);
      throw err;
    }),
  );
}

export const isPdf = (file) => {
  const fd = fs.openSync(file, "r");
  const head = Buffer.alloc(4);
  fs.readSync(fd, head, 0, 4, 0);
  fs.closeSync(fd);
  return head.toString("latin1") === "%PDF";
};
