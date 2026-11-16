import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

import { brandMarkPath } from "../src/assets/brand-source";
import { palette } from "../src/design/tokens";

const directory = new URL("../public/assets/brand/", import.meta.url);
await mkdir(directory, { recursive: true });

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36" fill="none"><rect width="36" height="36" rx="8" fill="${palette.page}"/><path d="${brandMarkPath}" transform="translate(4 4)" stroke="${palette.mint}" stroke-width="2" stroke-linecap="round"/></svg>\n`;
await writeFile(new URL("favicon.svg", directory), svg);
await sharp(Buffer.from(svg))
  .resize(180, 180)
  .png()
  .toFile(fileURLToPath(new URL("apple-touch-icon.png", directory)));

// ICO supports PNG frames; keep all conventional browser sizes in one file.
const sizes = [16, 32, 48];
const frames = await Promise.all(
  sizes.map((size) => sharp(Buffer.from(svg)).resize(size, size).png().toBuffer()),
);
const header = Buffer.alloc(6 + sizes.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
for (const [index, frame] of frames.entries()) {
  const size = sizes[index]!;
  const entry = 6 + index * 16;
  header[entry] = size;
  header[entry + 1] = size;
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(frame.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += frame.length;
}
await writeFile(new URL("favicon.ico", directory), Buffer.concat([header, ...frames]));
await writeFile(
  new URL("legacy-logo.svg", directory),
  await readFile(new URL("../src/assets/legacy-logo.svg", import.meta.url)),
);
