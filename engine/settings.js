// Client settings and shared constants. config.json holds the defaults (they are CYA's settings);
// clients/<name>.json layers another client's buyer, model, layout and supplier list over them.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const envFile = path.join(ROOT, ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

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

// The client whose settings are config.json itself. Its saved readings live directly under data/cache/<model>.
export const DEFAULT_CLIENT = "cya";

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

/** The names of every client with a settings file, the default client first. */
export function clientNames() {
  const dir = path.join(ROOT, "clients");
  const others = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort()
    : [];
  return [DEFAULT_CLIENT, ...others];
}

/**
 * Settings for one client. `client` is a name from clients/ (omit it, or pass the default, for config.json
 * alone). `model` overrides the client's model for one run; so does ENCODER_MODEL in the environment.
 * The result carries `id` (the client's name) and `client` (set only for clients with their own file,
 * which is what decides where their saved readings are kept).
 */
export function loadSettings({ client, model } = {}) {
  const settings = readJson(path.join(ROOT, "config.json"));
  if (client && client !== DEFAULT_CLIENT) {
    const file = path.join(ROOT, "clients", `${client}.json`);
    if (!fs.existsSync(file)) throw new Error(`No settings file for client "${client}" (expected ${file})`);
    Object.assign(settings, readJson(file), { client });
  }
  settings.id = client ?? DEFAULT_CLIENT;
  const override = model ?? process.env.ENCODER_MODEL;
  if (override) settings.model = override;
  return settings;
}
