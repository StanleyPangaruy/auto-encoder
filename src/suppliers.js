import fs from "node:fs";
import path from "node:path";
import { config, resolve } from "./config.js";

const FILE = resolve(config.suppliersFile ?? "suppliers.csv");
const COLUMNS = ["tin", "company", "address", "city", "nature", "particulars"];

function parseLine(line) {
  const out = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') (cur += '"'), i++;
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") out.push(cur), (cur = "");
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const quote = (s) => (/[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** The supplier master list, keyed by 9-digit TIN. Values here override what is read from a document. */
export function loadSuppliers() {
  const map = new Map();
  if (!fs.existsSync(FILE)) return map;
  const lines = fs.readFileSync(FILE, "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  for (const line of lines.slice(1)) {
    const values = parseLine(line);
    const entry = Object.fromEntries(COLUMNS.map((c, i) => [c, values[i] ?? ""]));
    if (entry.tin) map.set(entry.tin, entry);
  }
  return map;
}

export function saveSuppliers(map) {
  const entries = [...map.values()].sort((a, b) => a.company.localeCompare(b.company));
  const lines = [COLUMNS.join(","), ...entries.map((e) => COLUMNS.map((c) => quote(e[c] ?? "")).join(","))];
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, lines.join("\r\n") + "\r\n");
}
