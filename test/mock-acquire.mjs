// Offline contract test for the jmuse provider: mock musescore.com's salt + API behaviour
// and prove that auth derivation, URL resolution and download all line up.
import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const SALT = "MOCK-SALT-42";
const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");
const calls = [];

const server = http.createServer((req, res) => {
  const u = new URL(req.url, BASE);
  calls.push(`${u.pathname}${u.search}`);
  if (u.pathname === "/score/12345") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(
      `<html><head><link rel="stylesheet" href="/static/public/build/musescore_abc123/2024-01-01.js"></head><body>score</body></html>`
    );
  }
  if (u.pathname.startsWith("/static/public/build/")) {
    res.writeHead(200, { "content-type": "application/javascript" });
    // the real bundle contains a salted md5 prefix; the userscript/cli scrape this literal
    return res.end(`var x=md5(${JSON.stringify(SALT)}).substr(0,4);console.log(x);`);
  }
  if (u.pathname === "/api/jmuse") {
    const id = u.searchParams.get("id");
    const type = u.searchParams.get("type");
    const index = u.searchParams.get("index");
    const expect = md5(`${id}${type}${index}${SALT}`).slice(0, 4);
    const got = req.headers.authorization;
    if (got !== expect) {
      res.writeHead(403, { "content-type": "application/json" });
      return res.end(JSON.stringify({ message: "invalid auth", expect, got }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ info: { url: `${BASE}/files/${type}-${index}.bin` } }));
  }
  if (u.pathname.startsWith("/files/")) {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    return res.end(Buffer.alloc(2048, 7));
  }
  res.writeHead(404);
  res.end("nope");
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
process.env.MUSESCORE_BASE = BASE;
try {
  fs.rmSync(".cache/salt.json", { force: true });
} catch {}
const jmuse = await import("../server/sources/jmuse.mjs");

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${label}${extra ? "  " + extra : ""}`);
  if (!cond) failures++;
};

const saltInfo = await jmuse.discoverSalt({ scoreUrl: `${BASE}/score/12345` });
check("salt scraped from build bundle", saltInfo.salt === SALT, `got=${saltInfo.salt}`);

const r = await jmuse.jmuseResolve(12345, "mscz", 0, { salt: saltInfo.salt });
check("jmuse resolves native url", r.ok && !!r.url, r.url || JSON.stringify(r.body));
check("auth header matches md5 prefix", r.auth === md5(`12345mscz0${SALT}`).slice(0, 4), r.auth);

const bytes = await jmuse.download(r.url);
check("download returns payload", bytes.length === 2048, `${bytes.length} bytes`);

const bad = await jmuse.tryType(12345, "mp3", { salt: "WRONG" });
check("wrong salt is rejected (negative control)", bad.ok === false && bad.status === 403, JSON.stringify(bad));

console.log("\nserver calls:", calls.length, calls.slice(0, 6).join(" ; "));
server.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
