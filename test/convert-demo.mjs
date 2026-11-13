// Offline proof that LibreScoreAPP can produce every advertised format
// from a single score source (here: a local MusicXML), using webmscore (libmscore WASM).
import "./../server/node-shim.mjs";
import fs from "node:fs";
import path from "node:path";

const { default: WebMscore } = await import("webmscore");
const fonts = (await import("@librescore/fonts")).default;
const sf3 = (await import("@librescore/sf3")).default;

const OUT = path.join(process.cwd(), "test", "out");
fs.mkdirSync(OUT, { recursive: true });

await WebMscore.ready;
const xml = fs.readFileSync(path.join(process.cwd(), "test", "fixtures", "sample.musicxml"));
const fontData = await Promise.all(Object.values(fonts).map((p) => fs.promises.readFile(p)));

const t0 = Date.now();
const score = await WebMscore.load("musicxml", new Uint8Array(xml), fontData);
await score.generateExcerpts();
console.log("loaded in", Date.now() - t0, "ms");

const ok = [];
async function save(name, fn) {
  const t = Date.now();
  try {
    const data = await fn();
    const buf = Buffer.from(data);
    fs.writeFileSync(path.join(OUT, name), buf);
    console.log(`  ✓ ${name.padEnd(26)} ${(buf.length / 1024).toFixed(1)} KiB  (${Date.now() - t} ms)`);
    ok.push(name);
  } catch (e) {
    console.log(`  ✗ ${name.padEnd(26)} ${e.message}`);
  }
}

console.log("exporting:");
await save("sample.mscz", () => score.saveMsc("mscz"));
await save("sample.mscx", () => score.saveMsc("mscx"));
await save("sample.mxl", () => score.saveMxl());
await save("sample.mid", () => score.saveMidi(true, true));
await save("sample.pdf", () => score.savePdf());
await save("sample-1.svg", () => score.saveSvg(0, false));
await save("sample-1.png", () => score.savePng(0, false, true));

const soundFont = Object.values(sf3)[0];
await score.setSoundFont(await fs.promises.readFile(soundFont));
await save("sample.mp3", () => score.saveAudio("mp3"));
await save("sample.ogg", () => score.saveAudio("ogg"));
await save("sample.flac", () => score.saveAudio("flac"));

console.log(`\n${ok.length} formats written to ${OUT}`);
process.exit(0);
