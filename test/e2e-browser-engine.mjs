// Browser-engine e2e: a mock MuseScore-like site (SSR blob + signed link + 302 to "S3")
// proves the whole browser path works: open page -> read type_download_list -> fetch bytes.
import http from "node:http";
import { browserFetch } from "../server/browser-engine.mjs";

const PORT = 8797;
const BASE = `http://127.0.0.1:${PORT}`;
const MSCZ = Buffer.from("504b0304" + "00".repeat(4096), "hex"); // PK header + filler
const PDF = Buffer.from("%PDF-1.7\n" + "0".repeat(2048) + "\n%%EOF\n");

const store = {
  page: {
    data: {
      score: { id: 123, title: "Browser Engine Test" },
      type_download_list: [
        { type: "mscz", url: `${BASE}/score/download/index?score_id=123&type=mscz&h=abc` },
        { type: "pdf", url: `${BASE}/score/download/index?score_id=123&type=pdf&h=def` },
      ],
    },
  },
};
const escaped = JSON.stringify(store)
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

const html = `<!doctype html><html><head><meta charset="utf-8">
<meta property="musescore:author" content="Tester">
<title>Browser Engine Test | MuseScore</title></head>
<body><div id="jmuse-scroller-component"><div></div></div>
<script type="application/json" id="store">${escaped}</script></body></html>`;

const srv = http.createServer((req, res) => {
  const u = new URL(req.url, BASE);
  if (u.pathname.startsWith("/score/download/index")) {
    const type = u.searchParams.get("type");
    // mimic the real flow: signed link 302s to a storage host
    res.writeHead(302, { location: `${BASE}/storage/123.${type}?sig=ok` });
    return res.end();
  }
  if (u.pathname.startsWith("/storage/")) {
    const isPdf = u.pathname.endsWith(".pdf");
    res.writeHead(200, { "content-type": isPdf ? "application/pdf" : "application/octet-stream" });
    return res.end(isPdf ? PDF : MSCZ);
  }
  if (u.pathname === "/score/123") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(html);
  }
  res.writeHead(404);
  res.end("nope");
});
await new Promise((r) => srv.listen(PORT, "127.0.0.1", r));

const logs = [];
const r = await browserFetch({
  scoreUrl: `${BASE}/score/123`,
  want: ["mscz", "pdf"],
  headful: false,
  timeoutMs: 30000,
  onLog: (m) => {
    logs.push(m);
    console.log("  [log]", m);
  },
});

console.log("\nresult ok:", r.ok, "| title:", r.title, "| list:", r.list?.map((x) => x.type));
for (const f of r.files ?? []) console.log(`  file ${f.type}: ${f.bytes.length} bytes, magic ${f.bytes.subarray(0, 4).toString("hex")}`);
if (!r.ok) console.log("message:", r.message);

srv.close();
const good = r.ok && r.files.length === 2 && r.files[0].bytes.subarray(0, 2).toString() === "PK";
console.log(good ? "\nbrowser path OK" : "\nbrowser path FAILED");
process.exit(good ? 0 : 1);
