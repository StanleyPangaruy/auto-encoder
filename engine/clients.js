// Keeps the database's client list in step with the settings files.
import { clientNames, loadSettings } from "./settings.js";

/** Adds or updates one client in the database from its settings. */
export function registerClient(db, settings) {
  const { id, buyerName, buyerTin = "", ...rest } = settings;
  db.saveClient({ id, name: buyerName ?? id, tin: buyerTin, settings: rest });
}

/** Adds or updates every client that has a settings file. */
export function registerAllClients(db) {
  for (const client of clientNames()) registerClient(db, loadSettings({ client }));
}
