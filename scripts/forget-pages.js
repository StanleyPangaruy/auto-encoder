// Forgets the saved readings of some pages of a PDF, for every model, so the next run reads them afresh.
//   node scripts/forget-pages.js --client <name> "<file.pdf>" <from>-<to>
// Use after changing the prompt, or when a page was read wrongly and should be tried again.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { loadSettings, resolve, ROOT } from "../engine/settings.js";

const clientAt = process.argv.indexOf("--client");
const config = loadSettings({ client: clientAt > 0 ? process.argv[clientAt + 1] : undefined });
const rest = process.argv.slice(2).filter((a, i, all) => a !== "--client" && all[i - 1] !== "--client");
const [file, range] = rest;
const [from, to] = range.split("-").map(Number);
const hash = crypto.createHash("sha1").update(fs.readFileSync(resolve(file))).digest("hex");
const base = path.join(ROOT, "data", "cache", ...(config.client ? [config.client] : []));

let removed = 0;
for (const model of fs.readdirSync(base)) {
  const dir = path.join(base, model);
  if (!fs.statSync(dir).isDirectory()) continue;
  for (const name of fs.readdirSync(dir)) {
    const match = /^([0-9a-f]+)-p(\d+)\.json$/.exec(name);
    if (!match || match[1] !== hash) continue;
    const page = Number(match[2]);
    if (page >= from && page <= (to || from)) {
      fs.rmSync(path.join(dir, name));
      removed++;
    }
  }
}
console.log(`Forgot ${removed} saved page reading(s).`);
