// Draws the app's icon (assets/app.ico) for the desktop shortcut. Run again only to change the icon.
//   node scripts/make-icon.js
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { ROOT } from "../engine/settings.js";

// A teal page with a check mark: documents, read and checked.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <rect x="16" y="16" width="224" height="224" rx="48" fill="#0ca678"/>
  <path d="M84 52h64l40 40v104a12 12 0 0 1-12 12H84a12 12 0 0 1-12-12V64a12 12 0 0 1 12-12z" fill="#ffffff"/>
  <path d="M148 52v28a12 12 0 0 0 12 12h28" fill="#c3fae8"/>
  <path d="M98 150l22 22 40-46" fill="none" stroke="#0ca678" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

// An .ico file can hold PNG images (Windows Vista and later), one per size.
const sizes = [256, 48, 32, 16];
const images = await Promise.all(sizes.map((s) => sharp(Buffer.from(svg)).resize(s, s).png().toBuffer()));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);
let offset = 6 + 16 * images.length;
const entries = images.map((img, i) => {
  const e = Buffer.alloc(16);
  e.writeUInt8(sizes[i] === 256 ? 0 : sizes[i], 0);
  e.writeUInt8(sizes[i] === 256 ? 0 : sizes[i], 1);
  e.writeUInt16LE(1, 4);
  e.writeUInt16LE(32, 6);
  e.writeUInt32LE(img.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += img.length;
  return e;
});
const out = path.join(ROOT, "assets", "app.ico");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.concat([header, ...entries, ...images]));
// The same picture for the browser tab.
fs.writeFileSync(path.join(ROOT, "web", "public", "favicon.png"), await sharp(Buffer.from(svg)).resize(64, 64).png().toBuffer());
console.log(`Wrote ${out}`);
