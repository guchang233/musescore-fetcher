// End-to-end offline test: boot the local service, upload a real .mscz, convert to every format.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;
const srv = spawn(process.execPath, ["server/index.mjs"], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
srv.stdout.on("data", (d) => process.stdout.write("[srv] " + d));
srv.stderr.on("data", (d) => process.stderr.write("[srv:err] " + d));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitHealth() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(BASE + "/api/health");
      if (r.ok) return await r.json();
    } catch {}
    await wait(300);
  }
  throw new Error("server did not start");
}

try {
  const health = await waitHealth();
  console.log(`health ok · formats: ${health.formats.map((f) => f.ext).join(",")}`);

  const mscz = fs.readFileSync(path.join("test", "out", "sample.mscz"));
  const up = await fetch(BASE + "/api/upload", {
    method: "POST",
    headers: { "x-filename": encodeURIComponent("E2E Test Score.mscz"), "content-type": "application/octet-stream" },
    body: mscz,
  });
  const upJson = await up.json();
  console.log("upload:", up.status, JSON.stringify(upJson).slice(0, 300));
  if (!upJson.ref) throw new Error("upload failed");

  const formats = health.formats.map((f) => f.ext);
  const t0 = Date.now();
  const conv = await fetch(BASE + "/api/convert", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ref: upJson.ref, formats }),
  });
  if (!conv.ok) {
    console.error("convert failed", conv.status, await conv.text());
    process.exitCode = 1;
  } else {
    const buf = Buffer.from(await conv.arrayBuffer());
    const out = path.join("test", "out", "e2e-all-formats.zip");
    fs.writeFileSync(out, buf);
    console.log(`zip: ${(buf.length / 1024).toFixed(1)} KiB in ${Date.now() - t0} ms -> ${out}`);
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(buf);
    const names = Object.keys(zip.files);
    console.log(`entries (${names.length}):`);
    for (const n of names) console.log(`  ${n}  ${((await zip.files[n].async("uint8array")).length / 1024).toFixed(1)} KiB`);
  }
} catch (e) {
  console.error("E2E ERROR:", e);
  process.exitCode = 1;
} finally {
  srv.kill();
  await wait(300);
  process.exit(process.exitCode ?? 0);
}
