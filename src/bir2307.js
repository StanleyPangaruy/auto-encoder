// Reads scanned BIR Form 2307 certificates (one per PDF page) and turns them into sheet rows.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import sharp from "sharp";
import { config, MONTHS, ROOT } from "./config.js";
import { cleanTin, MANUAL } from "./rows.js";

const cacheDir = (model) => path.join(ROOT, "data", "cache-2307", model);
const TOLERANCE = 0.05;
const TOP_SHARE = 0.45;
const ZOOM_WIDTH = 2400;

const amount = z.number().nullable();
const Line = z.object({
  section: z.enum(["income_payments", "money_payments"]),
  atc: z.string().nullable(),
  printed_rate_percent: z.number().nullable(),
  month1: amount,
  month2: amount,
  month3: amount,
  total: amount,
  tax_withheld: amount,
});

const Certificate = z.object({
  is_form_2307: z.boolean(),
  period_from: z.string().nullable(),
  period_to: z.string().nullable(),
  payee_tin: z.string().nullable(),
  payee_name: z.string().nullable(),
  payor_tin: z.string().nullable(),
  payor_name: z.string().nullable(),
  payor_last_name: z.string().nullable(),
  payor_first_name: z.string().nullable(),
  payor_middle_name: z.string().nullable(),
  payor_address: z.string().nullable(),
  payor_city: z.string().nullable(),
  lines: z.array(Line),
  // Plain strings: the smaller model sometimes names a field outside the suggested list, which is still useful.
  illegible_fields: z.array(z.string()),
  notes: z.string(),
});

const SYSTEM = `You read scanned pages of BIR Form 2307 (Certificate of Creditable Tax Withheld at Source) for a Philippine bookkeeper who encodes them for a tax return. Each page is one certificate. You may get two images: the whole page, then an enlargement of its top part (boxes 1 to 8). Read the period and both TINs from the enlargement, one box at a time, since those digits are small and each box holds one digit.

What each field means:
- is_form_2307: false when the page is not a Form 2307 (a cover page, a blank page, another form). Then say what it is in notes and leave everything else null with no lines.
- period_from, period_to: box 1, as YYYY-MM-DD. The boxes are month, day, year, and the year may be written with two digits.
- payee_tin, payee_name: Part I, boxes 2 and 3, as printed.
- payor_tin: Part II, box 6, as printed, with every digit.
- payor_name: Part II, box 7, as printed.
- payor_last_name, payor_first_name, payor_middle_name: only when the payor is an individual person rather than a company. Otherwise null.
- payor_address: Part II, box 8, without the city or province and without the zip code.
- payor_city: the city for an address in Metro Manila (for example PASAY CITY, MAKATI CITY, MANILA), and the province for an address outside it (for example CAVITE, LAGUNA).
- lines: one entry for each filled row in Part III, in order. Leave out the "Total" rows and empty rows.
  - section: income_payments for rows under "Income Payments Subject to Expanded Withholding Tax", money_payments for rows under "Money Payments Subject to Withholding of Business Tax".
  - atc: the tax code in the ATC column, such as WC158.
  - printed_rate_percent: the rate when one is printed on the row (for "WC158 - 1%" this is 1). Null when no rate is printed.
  - month1, month2, month3: the amounts under 1st, 2nd and 3rd Month of the Quarter. Use 0 for a cell that is empty or shows 0.00.
  - total and tax_withheld: the Total and Tax Withheld for the Quarter cells of that row.

Copy figures exactly as they appear; do not calculate or correct them. These go into a tax return, so when a field is present but you cannot read it reliably, set it to null and add its name to illegible_fields (period, payor_tin, payor_name, payor_address, atc, amounts or tax_withheld) rather than guessing. Use notes for anything the bookkeeper should know, in one short sentence, or an empty string.`;

let client;
const getClient = () => (client ??= new Anthropic());

// A scanned page is normally one JPEG wrapped in a PDF page. Taking that JPEG out keeps its full
// resolution; a page sent as PDF is re-rendered smaller and the boxed TIN digits blur.
function scanImage(doc, page) {
  const xobjects = page.node.Resources()?.lookup(PDFName.of("XObject"));
  if (!xobjects) return null;
  const images = [];
  for (const [, ref] of xobjects.entries()) {
    const stream = doc.context.lookup(ref);
    if (!(stream instanceof PDFRawStream)) continue;
    if (String(stream.dict.get(PDFName.of("Subtype"))) !== "/Image") continue;
    if (!String(stream.dict.get(PDFName.of("Filter"))).includes("DCTDecode")) return null;
    images.push(Buffer.from(stream.contents));
  }
  return images.length === 1 ? images[0] : null;
}

/**
 * Splits a PDF into pages, since scanned bundles are far larger than one request allows.
 * Each page is { jpeg } when it is a plain scan, or { pdf } (a one-page PDF) otherwise.
 */
export async function splitPages(file) {
  const source = await PDFDocument.load(fs.readFileSync(file));
  const pages = [];
  for (let i = 0; i < source.getPageCount(); i++) {
    const jpeg = scanImage(source, source.getPage(i));
    if (jpeg) {
      pages.push({ jpeg });
      continue;
    }
    const single = await PDFDocument.create();
    const [page] = await single.copyPages(source, [i]);
    single.addPage(page);
    pages.push({ pdf: Buffer.from(await single.save()) });
  }
  return pages;
}

const imageBlock = (buf) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: buf.toString("base64") } });

async function pageContent(page) {
  if (page.pdf) {
    return [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: page.pdf.toString("base64") } }];
  }
  const upright = await sharp(page.jpeg).rotate().jpeg({ quality: 92 }).toBuffer();
  const { width, height } = await sharp(upright).metadata();
  // The period and TIN boxes are the smallest print on the form, so the top of the page is sent again, enlarged.
  const top = await sharp(upright)
    .extract({ left: 0, top: 0, width, height: Math.round(height * TOP_SHARE) })
    .resize({ width: ZOOM_WIDTH, kernel: "lanczos3" })
    .jpeg({ quality: 92 })
    .toBuffer();
  return [imageBlock(upright), imageBlock(top)];
}

/** Reads one page. Results are cached by the source file and page number, so re-runs cost nothing. */
export async function readPage(fileHash, pageNumber, page, model = config.model) {
  const cacheFile = path.join(cacheDir(model), `${fileHash}-p${String(pageNumber).padStart(4, "0")}.json`);
  if (fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, "utf8"));

  const response = await getClient().messages.parse({
    model,
    max_tokens: 8000,
    output_config: { effort: config.effort2307 ?? "high", format: zodOutputFormat(Certificate) },
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: [...(await pageContent(page)), { type: "text", text: "Extract this certificate." }],
      },
    ],
  });
  if (response.stop_reason === "refusal") throw new Error("the model declined to read this page");
  if (!response.parsed_output) throw new Error("the model returned an unreadable answer");

  const result = {
    page: pageNumber,
    certificate: response.parsed_output,
    usage: { input: response.usage.input_tokens, output: response.usage.output_tokens },
  };
  fs.mkdirSync(cacheDir(model), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2));
  return result;
}

export const hashFile = (file) => crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex");

export const plain = (s) => (s ?? "").toUpperCase().replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
const round2 = (n) => Math.round(n * 100) / 100;
const near = (a, b) => Math.abs(a - b) <= TOLERANCE;

function quarterStartMonth(cert) {
  const m = /^\d{4}-(\d{2})-\d{2}$/.exec(cert.period_to ?? cert.period_from ?? "");
  if (!m) return null;
  const month = Number(m[1]);
  return month >= 1 && month <= 12 ? Math.floor((month - 1) / 3) * 3 : null;
}

// Rates fixed by the tax code itself, for certificates that print the code without the rate.
const ATC_RATE = { WC158: 1, WI158: 1, WC160: 2, WI160: 2, WC156: 1, WI156: 1, WC157: 2, WI157: 2 };

function rateOf(line, atc) {
  if (line.printed_rate_percent != null) return line.printed_rate_percent / 100;
  if (ATC_RATE[atc]) return ATC_RATE[atc] / 100;
  if (!line.total || line.tax_withheld == null) return null;
  // No rate printed: take it from the figures when they land on a standard rate.
  const percent = (line.tax_withheld / line.total) * 100;
  const standard = [1, 2, 5, 10, 15].find((r) => Math.abs(percent - r) < 0.02);
  return standard ? standard / 100 : null;
}

/**
 * Turns one certificate into sheet rows: one per ATC line per month that has an amount, in the order printed.
 * `expectedPayeeTin` is the client's TIN; a certificate made out to someone else is marked.
 */
export function toRows(cert, page, expectedPayeeTin, clientNames = new Set()) {
  const base = {
    page,
    month: "",
    tin: cleanTin(cert.payor_tin),
    company: plain(cert.payor_name),
    last: plain(cert.payor_last_name),
    first: plain(cert.payor_first_name),
    middle: plain(cert.payor_middle_name),
    address: plain(cert.payor_address),
    city: plain(cert.payor_city),
    amount: null,
    atc: "",
    rate: null,
    wtax: null,
  };
  const flag = (row, issues) => ({ ...row, remarks: issues.length ? `${MANUAL}: ${issues.join("; ")}` : "" });

  if (!cert.is_form_2307) return [];

  const shared = [];
  if (cert.illegible_fields.length) shared.push(`UNREADABLE ${cert.illegible_fields.map((f) => f.replace(/_/g, " ").toUpperCase()).join(", ")}`);
  if (base.tin.length < 9 && !cert.illegible_fields.includes("payor_tin")) shared.push(base.tin ? "TIN INCOMPLETE" : "NO PAYOR TIN");
  const payee = cleanTin(cert.payee_tin);
  // One or two differing digits is a misread of the client's own TIN, not another payee.
  const differing = [...payee].filter((d, i) => d !== expectedPayeeTin?.[i]).length;
  if (expectedPayeeTin && payee.length === 9 && differing > 2 && !clientNames.has(plain(cert.payee_name))) shared.push(`PAYEE IS ${plain(cert.payee_name) || payee}, NOT THIS CLIENT`);
  const start = quarterStartMonth(cert);
  if (start == null && !cert.illegible_fields.includes("period")) shared.push("NO PERIOD");
  const [fromYear, fromMonth] = (cert.period_from ?? "").split("-").map(Number);
  const [toYear, toMonth] = (cert.period_to ?? "").split("-").map(Number);
  // The year is not encoded (YR stays blank), so a misread year alone is not worth the user's attention.
  if (fromYear && toYear && (fromYear !== toYear || Math.floor((fromMonth - 1) / 3) !== Math.floor((toMonth - 1) / 3))) {
    shared.push(`PERIOD ${cert.period_from} TO ${cert.period_to} IS NOT WITHIN ONE QUARTER`);
  }

  // An entry with no figures at all is an empty form row, not a payment.
  const lines = cert.lines.filter((l) => [l.month1, l.month2, l.month3, l.total, l.tax_withheld].some((v) => v));
  if (!lines.length) return [flag(base, [...shared, "NO AMOUNT LINES FOUND"])];

  const rows = [];
  for (const line of lines) {
    const issues = [...shared];
    const months = [line.month1, line.month2, line.month3].map((v) => v ?? 0);
    const filled = months.map((v, i) => [v, i]).filter(([v]) => v !== 0);
    // A one-month certificate carries its amount in that month's column; when it does not, the period was probably misread.
    if (fromMonth && fromMonth === toMonth && filled.length === 1 && filled[0][1] !== (fromMonth - 1) % 3) {
      issues.push("AMOUNT IS NOT IN THE COLUMN FOR THE PERIOD'S MONTH, CHECK MONTH");
    }
    const atc = (line.atc ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const rate = rateOf(line, atc);

    if (line.section === "money_payments") issues.push("BUSINESS TAX LINE, NOT EXPANDED WITHHOLDING");
    if (!atc) issues.push("NO ATC");
    else if (!/^W[A-Z]\d{3}$/.test(atc)) issues.push(`ATC ${atc} NOT RECOGNISED`);
    if (rate == null) issues.push("RATE NOT PRINTED AND NOT A STANDARD RATE");
    if (line.total != null && filled.length && !near(months.reduce((a, b) => a + b, 0), line.total)) issues.push("MONTHS DO NOT ADD UP TO TOTAL");
    if (rate != null && line.total != null && line.tax_withheld != null && !near(round2(line.total * rate), line.tax_withheld)) {
      issues.push(`TAX WITHHELD ${line.tax_withheld.toFixed(2)} IS NOT ${rate * 100}% OF ${line.total.toFixed(2)}`);
    }

    // A row with only a quarter total (no monthly split) still gets encoded, without a month.
    // Some certificates fill in only the Total. When the period is a single month, that month is the row's month.
    const oneMonth = fromMonth && fromMonth === toMonth ? (fromMonth - 1) % 3 : null;
    const parts = filled.length ? filled : [[line.total, oneMonth]];
    if (!filled.length && line.total == null) issues.push("NO AMOUNT");
    else if (!filled.length && oneMonth == null) issues.push("NO MONTHLY BREAKDOWN, MONTH NOT SET");
    let taxLeft = line.tax_withheld;
    parts.forEach(([value, index], n) => {
      // The form gives one tax figure per line for the quarter; a line spread over months shares it by amount.
      let wtax = line.tax_withheld;
      if (parts.length > 1 && line.tax_withheld != null && line.total) {
        wtax = n === parts.length - 1 ? round2(taxLeft) : round2((line.tax_withheld * value) / line.total);
        taxLeft -= wtax;
      }
      rows.push(flag({ ...base, month: index != null && start != null ? MONTHS[start + index] : "", amount: value, atc, rate, wtax }, issues));
    });
  }
  return rows;
}
