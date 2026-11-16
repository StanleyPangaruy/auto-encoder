import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const envFile = path.join(ROOT, ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

export const config = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
// "--client <name>" layers clients/<name>.json over config.json: another buyer, model, layout and supplier list.
const clientArg = process.argv.indexOf("--client");
if (clientArg > 0) {
  const name = process.argv[clientArg + 1];
  const file = path.join(ROOT, "clients", `${name}.json`);
  if (!fs.existsSync(file)) throw new Error(`No settings file for client "${name}" (expected ${file})`);
  Object.assign(config, JSON.parse(fs.readFileSync(file, "utf8")), { client: name });
}
// ENCODER_MODEL lets a test run try another model without editing config.json.
if (process.env.ENCODER_MODEL) config.model = process.env.ENCODER_MODEL;

export const resolve = (p) => (path.isAbsolute(p) ? p : path.join(ROOT, p));

export const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
export const UNDATED = "UNDATED";

export const PARTICULARS = {
  INVENTORY: "GOODS",
  "OFFICE SUPPLIES": "GOODS",
  "FUEL AND OIL": "GOODS",
  "UTILITIES EXPENSE": "SERVICES",
  "REPRESENTATION EXPENSE": "SERVICES",
};
