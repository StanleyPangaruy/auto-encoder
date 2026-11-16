// The connection to Claude, shared by both readers, and the API key behind it. The key lives in the .env
// file next to package.json (ANTHROPIC_API_KEY=...) and never leaves this PC except to Anthropic.
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { ROOT } from "./settings.js";

const ENV_FILE = path.join(ROOT, ".env");

let client;
let clientKey;

/** The Claude client, made again whenever the key has changed (for example from the Settings page). */
export function getAnthropic() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!client || clientKey !== key) {
    client = new Anthropic();
    clientKey = key;
  }
  return client;
}

/** Whether a key is set, and its last four characters for recognising it; never the key itself. */
export function keyStatus() {
  const key = process.env.ANTHROPIC_API_KEY ?? "";
  return { set: Boolean(key || process.env.ANTHROPIC_AUTH_TOKEN), ending: key ? key.slice(-4) : null };
}

/**
 * Asks Anthropic whether `key` works, without spending anything (listing models is free).
 * Returns { ok: true } or { ok: false, reason }.
 */
export async function testKey(key = process.env.ANTHROPIC_API_KEY) {
  try {
    await new Anthropic({ apiKey: key, maxRetries: 0, timeout: 15000 }).models.list({ limit: 1 });
    return { ok: true };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return { ok: false, reason: "Anthropic did not accept this key." };
    if (err instanceof Anthropic.PermissionDeniedError) return { ok: false, reason: "This key is not allowed to use the API." };
    if (err instanceof Anthropic.APIConnectionError) return { ok: false, reason: "Could not reach Anthropic. Check the internet connection." };
    if (err instanceof Anthropic.APIError) return { ok: false, reason: `Anthropic answered: ${err.message}` };
    return { ok: false, reason: err.message };
  }
}

/** Stores the key in .env (keeping the file's other lines) and starts using it at once. */
export function saveKey(key) {
  const lines = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/) : [];
  const kept = lines.filter((l) => l.trim() && !/^\s*ANTHROPIC_API_KEY\s*=/.test(l));
  fs.writeFileSync(ENV_FILE, [...kept, `ANTHROPIC_API_KEY=${key}`, ""].join("\r\n"));
  process.env.ANTHROPIC_API_KEY = key;
}
