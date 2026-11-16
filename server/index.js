// The app's local server: the screens, plus the API they use. Listens on this PC only (127.0.0.1).
//   node server/index.js            then open http://localhost:3000
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import multipart from "@fastify/multipart";
import { ROOT, resolve } from "../engine/settings.js";
import { openDb } from "../engine/db.js";
import { registerAllClients } from "../engine/clients.js";
import { listClients, getClient, createClient, updateClient, listSources } from "./clients.js";
import { enqueue, watch, isBusy, SECOND_MODEL } from "./jobs.js";
import { registerReviewRoutes } from "./review.js";
import { keyStatus, testKey, saveKey } from "../engine/anthropic.js";

const PORT = Number(process.env.PORT ?? 3000);
const WEB = path.join(ROOT, "web", "dist");

const db = openDb();
registerAllClients(db);
// Jobs cut off by a closed server are marked, rather than left looking as if they still run.
db.raw.prepare("UPDATE jobs SET status = 'failed', error = 'The app was closed while this job ran. Start it again; finished documents are not paid for twice.' WHERE status IN ('queued', 'running')").run();

const app = Fastify({ logger: { level: "warn" }, bodyLimit: 10 * 1024 * 1024 });
await app.register(multipart, { limits: { fileSize: 600 * 1024 * 1024, files: 2000 } });

// Paths sent to the screens use forward slashes.
const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");
const fail = (status, message) => Object.assign(new Error(message), { statusCode: status });
const insideOf = (dir, target) => {
  const rel = path.relative(resolve(dir), resolve(target));
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
};
const publicJob = (job) => job && { id: job.id, clientId: job.client_id, kind: job.kind, source: job.source, status: job.status, error: job.error, options: job.options, summary: job.summary, createdAt: job.created_at, finishedAt: job.finished_at };

// ---- status
const thisMonth = () => new Date().toISOString().slice(0, 7);
app.get("/api/status", async () => ({
  apiKey: keyStatus().set,
  secondModel: SECOND_MODEL,
  costThisMonth: db.costByMonth().filter((c) => c.month === thisMonth()).reduce((sum, c) => sum + c.cost, 0),
}));

// ---- settings: the API key (only its last four characters are ever sent to the screens)
app.get("/api/settings", async () => ({ apiKey: keyStatus() }));
app.post("/api/settings/api-key/test", async () => (keyStatus().set ? testKey() : { ok: false, reason: "No key is set up yet." }));
app.put("/api/settings/api-key", async (req) => {
  const key = String(req.body?.key ?? "").trim();
  if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key)) throw fail(400, "That does not look like an Anthropic API key (it starts with sk-ant-).");
  const test = await testKey(key);
  if (!test.ok) throw fail(400, test.reason);
  saveKey(key);
  return { apiKey: keyStatus() };
});

// ---- clients
app.get("/api/clients", async () => listClients());
app.get("/api/clients/:id", async (req) => getClient(req.params.id) ?? Promise.reject(fail(404, "No such client")));
app.post("/api/clients", async (req, reply) => reply.code(201).send(createClient(db, req.body ?? {})));
app.put("/api/clients/:id", async (req) => updateClient(db, req.params.id, req.body ?? {}));
app.get("/api/clients/:id/sources", async (req) => listSources(req.params.id));

// ---- uploads: files go into raw/<client>/<batch>/ (purchases) or raw/<client>/ (a 2307 PDF)
const safeName = (name) => path.basename(name).replace(/[\\/:*?"<>|]/g, " ").trim() || "file";

async function storeUpload(part, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const base = safeName(part.filename);
  let target = path.join(dir, base);
  // Never overwrite: a second file with the same name gets a number.
  for (let n = 2; fs.existsSync(target); n++) {
    const ext = path.extname(base);
    target = path.join(dir, `${path.basename(base, ext)} (${n})${ext}`);
  }
  await pipeline(part.file, fs.createWriteStream(target));
  if (part.file.truncated) {
    fs.rmSync(target, { force: true });
    throw fail(413, `${base} is larger than the 600 MB limit`);
  }
  return target;
}

app.post("/api/uploads", async (req) => {
  const fields = {};
  const stored = [];
  for await (const part of req.parts()) {
    if (part.type === "field") {
      fields[part.fieldname] = part.value;
      continue;
    }
    const client = getClient(fields.clientId);
    if (!client) throw fail(400, "Choose the client before sending files");
    if (fields.kind === "2307") {
      if (!/\.pdf$/i.test(part.filename)) throw fail(400, "A 2307 job takes one PDF");
      stored.push(await storeUpload(part, resolve(client.rawDir)));
    } else {
      const batch = safeName(fields.batch ?? "");
      if (!batch || batch === "file") throw fail(400, "Give the batch a name, such as the month (2026-11)");
      stored.push(await storeUpload(part, resolve(path.join(client.rawDir, batch))));
    }
  }
  if (!stored.length) throw fail(400, "No files were received");
  const source = fields.kind === "2307" ? stored[0] : path.dirname(stored[0]);
  return { source: rel(source), files: stored.length };
});

// ---- jobs
app.get("/api/jobs", async (req) => db.listJobs(req.query.client).filter((j) => j.origin === "run").map(publicJob));
app.get("/api/jobs/:id", async (req) => publicJob(db.getJob(Number(req.params.id))) ?? Promise.reject(fail(404, "No such job")));

app.post("/api/jobs", async (req, reply) => {
  const { clientId, kind, source, byPage = false, sheet } = req.body ?? {};
  const client = getClient(clientId);
  if (!client) throw fail(400, "Choose a client");
  if (!["purchases", "2307"].includes(kind)) throw fail(400, "Choose Purchases or BIR 2307");
  if (!source || !insideOf(client.rawDir, source) || !fs.existsSync(resolve(source))) throw fail(400, `Choose files from ${client.rawDir}`);
  const isFile = fs.statSync(resolve(source)).isFile();
  if (kind === "2307" && (!isFile || !/\.pdf$/i.test(source))) throw fail(400, "A 2307 job takes one PDF");
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) throw fail(400, "No Anthropic API key is set up");
  const jobId = db.createJob({ clientId, kind, source: rel(resolve(source)), options: { byPage: Boolean(byPage), sheet: sheet || undefined, model: client.model } });
  enqueue(db, jobId);
  return reply.code(202).send(publicJob(db.getJob(jobId)));
});

app.post("/api/jobs/:id/second-pass", async (req, reply) => {
  const job = db.getJob(Number(req.params.id));
  if (!job) throw fail(404, "No such job");
  if (!job.summary?.secondPassOffer) throw fail(409, "This job has nothing left for a second reading");
  enqueue(db, job.id, "second");
  return reply.code(202).send(publicJob(db.getJob(job.id)));
});

// Progress as Server-Sent Events: one message per update until the job is done or failed.
app.get("/api/jobs/:id/events", (req, reply) => {
  const jobId = Number(req.params.id);
  if (!db.getJob(jobId)) return reply.code(404).send({ error: "No such job" });
  reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const send = (event) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  const job = db.getJob(jobId);
  send({ type: "status", status: job.status, summary: job.summary, error: job.error });
  const stop = watch(jobId, send);
  const ping = setInterval(() => reply.raw.write(": ping\n\n"), 25000);
  req.raw.on("close", () => {
    stop();
    clearInterval(ping);
  });
});

// ---- review
registerReviewRoutes(app, db);

// ---- costs (recorded since the app and its command lines began keeping them, November 2026)
app.get("/api/costs", async () => db.costByMonth());

// ---- quitting: the app runs without a window, so the screens offer a way to stop it
app.post("/api/quit", async (req, reply) => {
  if (isBusy() && !req.body?.force) throw fail(409, "A job is still running. Quitting now stops it; it can be started again later at no extra cost for what was already read.");
  reply.send({ stopping: true });
  setTimeout(() => process.exit(0), 300);
});

// ---- open a workbook in Excel (only workbooks under output/)
app.post("/api/open", async (req) => {
  const target = req.body?.path;
  if (!target || !insideOf("output", target) || !fs.existsSync(resolve(target))) throw fail(400, "Only workbooks in the output folder can be opened");
  spawn("cmd", ["/c", "start", "", resolve(target)], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  return { opened: true };
});

// ---- the screens (built by Vite into web/dist); any other path is a screen route
if (fs.existsSync(WEB)) {
  await app.register(fastifyStatic, { root: WEB });
  app.setNotFoundHandler((req, reply) => (req.url.startsWith("/api/") ? reply.code(404).send({ error: "Not found" }) : reply.sendFile("index.html")));
}

app.setErrorHandler((err, req, reply) => {
  const status = err.statusCode ?? 500;
  if (status >= 500) req.log.error(err);
  reply.code(status).send({ error: err.message });
});

await app.listen({ host: "127.0.0.1", port: PORT });
console.log(`Auto-Encoder is running at http://localhost:${PORT}`);
