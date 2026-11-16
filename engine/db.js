// The app's database: clients, the jobs run for them, the rows each job produced, and what each job cost.
// One SQLite file (data/app.db by default), so copying that file is a complete backup.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ROOT } from "./settings.js";

export const DEFAULT_DB = path.join(ROOT, "data", "app.db");

// Each entry upgrades the schema by one version. Append new entries; never edit old ones.
const MIGRATIONS = [
  `CREATE TABLE clients (
     id          TEXT PRIMARY KEY,
     name        TEXT NOT NULL,
     tin         TEXT NOT NULL DEFAULT '',
     settings    TEXT NOT NULL DEFAULT '{}',
     created_at  TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE TABLE jobs (
     id           INTEGER PRIMARY KEY,
     client_id    TEXT NOT NULL REFERENCES clients(id),
     kind         TEXT NOT NULL CHECK (kind IN ('purchases', '2307')),
     origin       TEXT NOT NULL DEFAULT 'run' CHECK (origin IN ('run', 'import')),
     source       TEXT NOT NULL,
     options      TEXT NOT NULL DEFAULT '{}',
     summary      TEXT NOT NULL DEFAULT '{}',
     created_at   TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE TABLE rows (
     id           INTEGER PRIMARY KEY,
     job_id       INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
     client_id    TEXT NOT NULL REFERENCES clients(id),
     kind         TEXT NOT NULL,
     year         INTEGER,
     sheet        TEXT NOT NULL,
     position     INTEGER NOT NULL,
     data         TEXT NOT NULL,
     remarks      TEXT NOT NULL DEFAULT '',
     source_file  TEXT NOT NULL DEFAULT '',
     source_page  INTEGER,
     checked      INTEGER NOT NULL DEFAULT 0,
     updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX rows_by_sheet ON rows (client_id, kind, year, sheet, position);
   CREATE TABLE usage (
     id             INTEGER PRIMARY KEY,
     job_id         INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
     client_id      TEXT REFERENCES clients(id),
     model          TEXT NOT NULL,
     input_tokens   INTEGER NOT NULL,
     output_tokens  INTEGER NOT NULL,
     cost           REAL NOT NULL,
     created_at     TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE TABLE app_settings (
     key    TEXT PRIMARY KEY,
     value  TEXT NOT NULL
   );`,
];

const json = (value) => JSON.stringify(value ?? {});
const parse = (text) => (text ? JSON.parse(text) : {});

/** Opens (creating and upgrading if needed) the database at `file`. Pass ":memory:" for a throwaway one. */
export function openDb(file = DEFAULT_DB) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  const version = db.prepare("PRAGMA user_version").get().user_version;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return wrap(db);
}

function transaction(db, fn) {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// Row columns kept as real columns; everything else about a row lives in its JSON `data`.
function rowRecord(row) {
  const { year, sheet, remarks, source, page, ...data } = row;
  const sourceFile = (source ?? "").replace(/ \(page \d+\)$/, "");
  return { year: year ?? null, sheet, remarks: remarks ?? "", sourceFile, page: page ?? null, data: { ...data, source } };
}

function wrap(db) {
  const api = {
    raw: db,
    close: () => db.close(),

    saveClient({ id, name, tin = "", settings = {} }) {
      db.prepare(
        `INSERT INTO clients (id, name, tin, settings) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, tin = excluded.tin, settings = excluded.settings`,
      ).run(id, name, tin, json(settings));
    },

    listClients() {
      return db.prepare("SELECT * FROM clients ORDER BY name").all().map((c) => ({ ...c, settings: parse(c.settings) }));
    },

    getClient(id) {
      const c = db.prepare("SELECT * FROM clients WHERE id = ?").get(id);
      return c ? { ...c, settings: parse(c.settings) } : null;
    },

    /** Records a job and the rows it produced, in order, in one transaction. Returns the job id. */
    saveJob({ clientId, kind, origin = "run", source, options = {}, summary = {}, rows = [] }) {
      return transaction(db, () => {
        const { lastInsertRowid } = db
          .prepare("INSERT INTO jobs (client_id, kind, origin, source, options, summary) VALUES (?, ?, ?, ?, ?, ?)")
          .run(clientId, kind, origin, source, json(options), json(summary));
        const jobId = Number(lastInsertRowid);
        const insert = db.prepare(
          `INSERT INTO rows (job_id, client_id, kind, year, sheet, position, data, remarks, source_file, source_page)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        rows.forEach((row, position) => {
          const r = rowRecord(row);
          insert.run(jobId, clientId, kind, r.year, r.sheet, position, json(r.data), r.remarks, r.sourceFile, r.page);
        });
        return jobId;
      });
    },

    /** Removes earlier jobs of the same client, kind and source (a 2307 PDF re-encoded replaces its rows). */
    replaceJobsFor({ clientId, kind, source }) {
      db.prepare("DELETE FROM jobs WHERE client_id = ? AND kind = ? AND source = ?").run(clientId, kind, source);
    },

    listJobs(clientId) {
      return db
        .prepare(
          `SELECT j.*, (SELECT COUNT(*) FROM rows r WHERE r.job_id = j.id) AS row_count
           FROM jobs j WHERE client_id = ? ORDER BY j.id`,
        )
        .all(clientId)
        .map((j) => ({ ...j, options: parse(j.options), summary: parse(j.summary) }));
    },

    /** A client's rows, optionally narrowed to one kind, year and sheet, in sheet order. */
    listRows(clientId, { kind, year, sheet, jobId } = {}) {
      const where = ["client_id = ?"];
      const params = [clientId];
      for (const [column, value] of [["kind", kind], ["year", year], ["sheet", sheet], ["job_id", jobId]]) {
        if (value !== undefined) {
          where.push(`${column} = ?`);
          params.push(value);
        }
      }
      return db
        .prepare(`SELECT * FROM rows WHERE ${where.join(" AND ")} ORDER BY kind, year, sheet, job_id, position`)
        .all(...params)
        .map((r) => ({ ...parse(r.data), id: r.id, jobId: r.job_id, year: r.year, sheet: r.sheet, remarks: r.remarks, page: r.source_page, checked: Boolean(r.checked) }));
    },

    /** Applies the user's corrections to one row. `changes` may include `remarks` and `checked`. */
    updateRow(id, changes) {
      const current = db.prepare("SELECT data, remarks, checked FROM rows WHERE id = ?").get(id);
      if (!current) throw new Error(`No row ${id}`);
      const { remarks = current.remarks, checked = Boolean(current.checked), ...fields } = changes;
      const data = { ...parse(current.data), ...fields };
      db.prepare("UPDATE rows SET data = ?, remarks = ?, checked = ?, updated_at = datetime('now') WHERE id = ?").run(json(data), remarks, checked ? 1 : 0, id);
    },

    recordUsage({ jobId = null, clientId = null, model, inputTokens, outputTokens, cost }) {
      db.prepare("INSERT INTO usage (job_id, client_id, model, input_tokens, output_tokens, cost) VALUES (?, ?, ?, ?, ?, ?)").run(
        jobId, clientId, model, inputTokens, outputTokens, cost,
      );
    },

    /** Spending per client per month, newest first. */
    costByMonth() {
      return db
        .prepare(
          `SELECT client_id, substr(created_at, 1, 7) AS month, ROUND(SUM(cost), 4) AS cost, COUNT(*) AS calls
           FROM usage GROUP BY client_id, month ORDER BY month DESC, client_id`,
        )
        .all();
    },

    getSetting(key) {
      return db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key)?.value ?? null;
    },

    setSetting(key, value) {
      db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
    },
  };
  return api;
}
