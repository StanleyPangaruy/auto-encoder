import { config, MONTHS, PARTICULARS, UNDATED } from "./config.js";

export const MANUAL = "FOR MANUAL CHECKING";
const DR_NOTE = "DELIVERY RECEIPT, NO INVOICE";
const VAT_TOLERANCE = 0.5;

const upper = (s) => (s ?? "").toString().trim().replace(/\s+/g, " ").toUpperCase();
const round2 = (n) => Math.round(n * 100) / 100;
// Full addresses are written without punctuation, as in the user's sheets.
const addressText = (s) => (config.addressStyle === "full" ? upper((s ?? "").replace(/[.,]/g, " ")) : upper(s));

export function cleanTin(tin) {
  const digits = (tin ?? "").replace(/\D/g, "");
  return digits.length >= 9 ? digits.slice(0, 9) : digits;
}

// The user's sheets drop leading zeros and prefixes: invoice "No. 0009001" is encoded as 9001.
export function cleanNumber(number) {
  const s = upper(number).replace(/^(SI|OR|NO|#)[\s.\-:#]*/, "");
  return /^\d+$/.test(s) ? s.replace(/^0+(?=\d)/, "") : s;
}

function parseDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? "");
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return { year, month, day };
}

/**
 * Turns one extracted document into a sheet row.
 * A row's `vat` is "auto" (NET and INPUT VAT are formulas) or "manual" (the three VAT cells are left for the user).
 */
export function toRow(doc, source, supplier, today = new Date()) {
  const issues = [];
  const illegible = new Set(doc.illegible_fields);
  const currentYear = today.getFullYear();
  let date = parseDate(doc.date);
  const yearMisread = Boolean(date) && Math.abs(date.year - currentYear) > 1;
  // A year far from the present is a misread, not an old document; filing it under that year would
  // start a stray workbook, so the row goes to UNDATED with what was read.
  if (yearMisread) {
    issues.push(`DATE READ AS ${doc.date}, CHECK YEAR`);
    date = null;
  }

  let tin = supplier?.tin || cleanTin(doc.supplier_tin);
  if (tin && tin === config.buyerTin) {
    tin = "";
    issues.push("TIN READ WAS THE BUYER'S");
  } else if (tin && tin.length < 9) {
    issues.push("TIN INCOMPLETE");
  }

  const particulars = supplier?.particulars || doc.particulars || "";
  const amount = doc.total_amount == null ? null : round2(doc.total_amount);

  if (illegible.size) issues.push(`UNREADABLE ${[...illegible].map((f) => f.replace(/_/g, " ").toUpperCase()).join(", ")}`);
  if (!date && !illegible.has("date") && !yearMisread) issues.push("NO DATE");
  if (amount == null && !illegible.has("total_amount")) issues.push("NO AMOUNT");
  if (!particulars) issues.push("PARTICULARS NOT SET");
  if (!supplier?.company && !doc.supplier_name && !illegible.has("supplier_name")) issues.push("NO SUPPLIER NAME");
  // "Walk-in" or "Cash" on the customer line is the shop's placeholder, not another buyer.
  if (doc.made_out_to && !/^(walk[- ]?in|cash|customer)$/i.test(doc.made_out_to.trim())) issues.push(`MADE OUT TO ${upper(doc.made_out_to)}, NOT THE CLIENT`);
  if (doc.confidence === "low") issues.push(`COMPARE WITH PAPER${doc.notes ? ` (${doc.notes})` : ""}`);

  let vat = "auto";
  if (doc.vat_status !== "vat") {
    vat = "manual";
    issues.push({ non_vat: "NON-VAT SUPPLIER", exempt_or_mixed: "HAS VAT-EXEMPT OR ZERO-RATED AMOUNT", unclear: "VAT STATUS UNCLEAR" }[doc.vat_status]);
  } else if (amount != null && doc.printed_vat_amount != null) {
    const expected = round2(amount - amount / 1.12);
    if (Math.abs(expected - doc.printed_vat_amount) > VAT_TOLERANCE) {
      issues.push(`PRINTED VAT ${doc.printed_vat_amount.toFixed(2)} IS NOT 12% OF AMOUNT`);
    }
  }
  if (doc.doc_type === "delivery_receipt") issues.push(DR_NOTE);

  return {
    year: date?.year ?? currentYear,
    isoDate: date ? doc.date : null,
    sheet: date ? MONTHS[date.month - 1] : UNDATED,
    month: date ? MONTHS[date.month - 1] : "",
    day: date ? String(date.day).padStart(2, "0") : "",
    number: cleanNumber(doc.number),
    tin,
    company: upper(supplier?.company || doc.supplier_name),
    last: upper(doc.last_name),
    first: upper(doc.first_name),
    middle: upper(doc.middle_name),
    address: addressText(supplier?.address || doc.address),
    city: addressText(supplier?.city || doc.city),
    nature: supplier?.nature || PARTICULARS[particulars] || "",
    particulars,
    amount,
    vat,
    net: null,
    inputVat: null,
    nonVat: null,
    remarks: issues.length ? `${MANUAL}: ${issues.join("; ")}` : "",
    source: doc.first_page > 1 ? `${source} (page ${doc.first_page})` : source,
  };
}

const supplierKey = (r) => r.tin || r.company;

/** Identity of a document, used to skip ones that are already encoded. */
export function rowKeys(r) {
  // Both the TIN and the name identify the supplier, so a row whose TIN was blank the first time still matches.
  if (r.number) return [r.tin, r.company].filter(Boolean).map((who) => `${who}|${r.number}`);
  if (r.company && r.amount != null) return [`${r.company}|${r.sheet}|${r.day}|${r.amount}`];
  return [];
}

const isDeliveryReceipt = (r) => r.remarks.includes(DR_NOTE);

/**
 * Adds new rows to a sheet's existing rows.
 * Skips documents already encoded, and keeps a delivery receipt only while no invoice matches it.
 */
export function mergeRows(existing, incoming, { sort = true } = {}) {
  const rows = [...existing];
  const seen = new Set(rows.flatMap(rowKeys));
  const duplicates = [];

  for (const row of incoming) {
    const keys = rowKeys(row);
    if (keys.some((k) => seen.has(k))) {
      duplicates.push(row);
      continue;
    }
    for (const k of keys) seen.add(k);
    rows.push(row);
  }

  const invoices = rows.filter((r) => !isDeliveryReceipt(r));
  const matchesInvoice = (dr) =>
    dr.amount != null && invoices.some((inv) => supplierKey(inv) === supplierKey(dr) && inv.amount === dr.amount);
  const kept = rows.filter((r) => !isDeliveryReceipt(r) || !matchesInvoice(r));
  const droppedReceipts = rows.filter((r) => !kept.includes(r));

  // Some clients want rows left in the order the files were read.
  if (sort) kept.sort((a, b) => {
    // Documents without a number (utility bills) go last, as in the user's sheets.
    if (!a.number !== !b.number) return a.number ? -1 : 1;
    return a.day.localeCompare(b.day) || a.number.localeCompare(b.number, undefined, { numeric: true });
  });
  return { rows: kept, duplicates, droppedReceipts };
}
