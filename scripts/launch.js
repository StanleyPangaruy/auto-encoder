// What the desktop shortcut runs (through start-app.vbs, so no window appears): starts Auto-Encoder in the
// background unless it is already running, then opens it in the browser. Output goes to data/logs/app.log.
//   node scripts/launch.js [--no-browser]
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const URL = `http://localhost:${process.env.PORT ?? 3000}`;
const LOG_DIR = path.join(ROOT, "data", "logs");
const LOG = path.join(LOG_DIR, "app.log");

const running = async () => {
  try {
    return (await fetch(`${URL}/api/status`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
};
const openInWindows = (target) => spawn("cmd", ["/c", "start", "", target], { detached: true, stdio: "ignore", windowsHide: true }).unref();
const note = (text) => fs.appendFileSync(LOG, `[${new Date().toLocaleString()}] ${text}\n`);

fs.mkdirSync(LOG_DIR, { recursive: true });

if (!(await running())) {
  if (!fs.existsSync(path.join(ROOT, "web", "dist", "index.html"))) {
    note("Building the screens for the first time...");
    const build = spawnSync("npm", ["--prefix", "web", "run", "build"], { cwd: ROOT, shell: true, windowsHide: true, encoding: "utf8" });
    fs.appendFileSync(LOG, `${build.stdout ?? ""}${build.stderr ?? ""}`);
  }
  note("Starting Auto-Encoder.");
  const out = fs.openSync(LOG, "a");
  spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(ROOT, "server", "index.js")], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", out, out],
    windowsHide: true,
  }).unref();

  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await new Promise((r) => setTimeout(r, 500));
    up = await running();
  }
  if (!up) {
    note("Auto-Encoder did not start within 20 seconds. The messages above say why.");
    // Show the log, which says what went wrong, rather than failing silently.
    openInWindows(LOG);
    process.exit(1);
  }
}

// --no-browser starts the app without opening it (for testing the launcher).
if (!process.argv.includes("--no-browser")) openInWindows(URL);
