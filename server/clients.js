// Reading and saving client settings for the app. The settings files stay the record: config.json for the
// default client (CYA), clients/<id>.json for every other one. The database's client list follows them.
import fs from "node:fs";
import path from "node:path";
import { ROOT, DEFAULT_CLIENT, clientNames, loadSettings, resolve } from "../engine/settings.js";
import { registerClient } from "../engine/clients.js";

// The fields the Clients screen edits. Everything else in a settings file is left as it is.
export const EDITABLE = ["buyerName", "buyerTin", "model", "layout", "addressStyle", "inventoryHint"];

const fileFor = (id) => (id === DEFAULT_CLIENT ? path.join(ROOT, "config.json") : path.join(ROOT, "clients", `${id}.json`));

/** The folder name used for a client under raw/ and output/ (for example "JJEL Sukimart"). */
export const folderName = (settings) => path.basename(settings.output);

/** What the screens show about a client. */
export function describe(settings) {
  return {
    id: settings.id,
    buyerName: settings.buyerName ?? settings.id,
    buyerTin: settings.buyerTin ?? "",
    model: settings.model,
    layout: settings.layout === "file-order" ? "file-order" : "month",
    addressStyle: settings.addressStyle === "full" ? "full" : "district",
    inventoryHint: settings.inventoryHint ?? "",
    folder: folderName(settings),
    rawDir: `raw/${folderName(settings)}`,
    outputDir: settings.output,
  };
}

export const listClients = () => clientNames().map((client) => describe(loadSettings({ client })));

export const getClient = (id) => (clientNames().includes(id) ? describe(loadSettings({ client: id })) : null);

const slug = (name) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);

const cleanFields = (input) => {
  const out = {};
  for (const key of EDITABLE) if (input[key] !== undefined) out[key] = typeof input[key] === "string" ? input[key].trim() : input[key];
  if (out.buyerName) out.buyerName = out.buyerName.toUpperCase();
  if (out.buyerTin !== undefined) out.buyerTin = String(out.buyerTin).replace(/\D/g, "").slice(0, 9);
  // "month" is the default layout and "district" the default address style, so neither is written out.
  if (out.layout === "month") out.layout = undefined;
  if (out.addressStyle === "district") out.addressStyle = undefined;
  if (out.inventoryHint === "") out.inventoryHint = undefined;
  return out;
};

/** Creates a client from the Clients screen's form. Returns it as the screens see it. */
export function createClient(db, input) {
  if (!input.buyerName?.trim()) throw Object.assign(new Error("The client needs a name"), { statusCode: 400 });
  const id = slug(input.id || input.buyerName);
  if (!id) throw Object.assign(new Error("The client needs a name made of letters or numbers"), { statusCode: 400 });
  if (clientNames().includes(id)) throw Object.assign(new Error(`A client called "${id}" already exists`), { statusCode: 409 });
  const folder = (input.folder?.trim() || input.buyerName.trim()).replace(/[\\/:*?"<>|]/g, " ").trim();
  const fields = cleanFields(input);
  const settings = {
    ...fields,
    output: `output/${folder}`,
    suppliersFile: `clients/${id}.suppliers.csv`,
  };
  fs.mkdirSync(path.join(ROOT, "clients"), { recursive: true });
  fs.writeFileSync(fileFor(id), JSON.stringify(settings, null, 2) + "\n");
  fs.mkdirSync(resolve(path.join("raw", folder)), { recursive: true });
  registerClient(db, loadSettings({ client: id }));
  return getClient(id);
}

/** Saves the Clients screen's changes to one client's settings file. */
export function updateClient(db, id, input) {
  if (!clientNames().includes(id)) throw Object.assign(new Error(`No client "${id}"`), { statusCode: 404 });
  const file = fileFor(id);
  const current = JSON.parse(fs.readFileSync(file, "utf8"));
  const fields = cleanFields(input);
  for (const key of EDITABLE) {
    if (!(key in input)) continue;
    if (fields[key] === undefined) delete current[key];
    else current[key] = fields[key];
  }
  fs.writeFileSync(file, JSON.stringify(current, null, 2) + "\n");
  registerClient(db, loadSettings({ client: id }));
  return getClient(id);
}

/**
 * What can be encoded for a client without uploading: the folders and PDFs already in raw/<client>.
 * Folders hold purchase documents; PDFs directly in the client folder are usually 2307 bundles.
 */
export function listSources(id) {
  const client = getClient(id);
  if (!client) return [];
  const dir = resolve(client.rawDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() || /\.pdf$/i.test(e.name))
    .map((e) => {
      const full = path.join(dir, e.name);
      const files = e.isDirectory() ? fs.readdirSync(full, { withFileTypes: true }).filter((f) => f.isFile()).length : 1;
      return { name: e.name, path: `${client.rawDir}/${e.name}`, type: e.isDirectory() ? "folder" : "pdf", files, size: e.isDirectory() ? null : fs.statSync(full).size };
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}
