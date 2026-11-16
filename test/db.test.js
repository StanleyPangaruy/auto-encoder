import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../engine/db.js";

const row = (over) => ({ year: 2026, sheet: "OCT", month: "OCT", day: "06", number: "381205", tin: "000320426", company: "ANGLINCO", amount: 714.88, vat: "auto", remarks: "", source: "a.png", page: null, ...over });

test("a job keeps its rows in order, with the page each came from", () => {
  const db = openDb(":memory:");
  db.saveClient({ id: "cya", name: "CYA", tin: "010786993" });
  const jobId = db.saveJob({
    clientId: "cya",
    kind: "purchases",
    source: "raw/CYA/2026-10",
    rows: [row({ number: "2" }), row({ number: "1", source: "bundle.pdf (page 3)", page: 3 })],
  });
  const rows = db.listRows("cya", { jobId });
  assert.deepEqual(rows.map((r) => r.number), ["2", "1"]);
  assert.equal(rows[1].page, 3);
  assert.equal(rows[1].source, "bundle.pdf (page 3)");
  assert.equal(db.listJobs("cya")[0].row_count, 2);
  db.close();
});

test("corrections and the checked mark are saved on the row", () => {
  const db = openDb(":memory:");
  db.saveClient({ id: "cya", name: "CYA" });
  db.saveJob({ clientId: "cya", kind: "purchases", source: "x", rows: [row({ remarks: "FOR MANUAL CHECKING: UNREADABLE TOTAL AMOUNT", amount: null })] });
  const [before] = db.listRows("cya");
  db.updateRow(before.id, { amount: 6395.87, remarks: "", checked: true });
  const [after] = db.listRows("cya");
  assert.deepEqual([after.amount, after.remarks, after.checked, after.company], [6395.87, "", true, "ANGLINCO"]);
  db.close();
});

test("re-encoding a 2307 PDF replaces its earlier rows; cost is totalled per client and month", () => {
  const db = openDb(":memory:");
  db.saveClient({ id: "tayan", name: "Tayan" });
  const first = db.saveJob({ clientId: "tayan", kind: "2307", source: "raw/Tayan/oct.pdf", rows: [row({ sheet: "2307" })] });
  db.recordUsage({ jobId: first, clientId: "tayan", model: "claude-haiku-5-5", inputTokens: 1000, outputTokens: 100, cost: 0.25 });
  db.replaceJobsFor({ clientId: "tayan", kind: "2307", source: "raw/Tayan/oct.pdf" });
  db.saveJob({ clientId: "tayan", kind: "2307", source: "raw/Tayan/oct.pdf", rows: [row({ sheet: "2307" }), row({ sheet: "2307" })] });
  assert.equal(db.listRows("tayan").length, 2);
  // The cost of the replaced run is still counted: it was spent.
  assert.equal(db.costByMonth()[0].cost, 0.25);
  db.close();
});

test("app settings are stored and replaced", () => {
  const db = openDb(":memory:");
  assert.equal(db.getSetting("theme"), null);
  db.setSetting("theme", "light");
  db.setSetting("theme", "dark");
  assert.equal(db.getSetting("theme"), "dark");
  db.close();
});

test("a row id is never given to another row after a workbook is re-read", () => {
  const db = openDb(":memory:");
  db.saveClient({ id: "cya", name: "CYA" });
  const first = db.saveJob({ clientId: "cya", kind: "purchases", origin: "import", source: "w.xlsx", rows: [row({ number: "1" }), row({ number: "2" })] });
  const oldIds = db.listRows("cya").map((r) => r.id);
  db.raw.prepare("DELETE FROM jobs WHERE id = ?").run(first);
  db.saveJob({ clientId: "cya", kind: "purchases", origin: "import", source: "w.xlsx", rows: [row({ number: "1" }), row({ number: "2" })] });
  for (const id of oldIds) assert.equal(db.getRow(id), null);
  db.close();
});
