// LibreScoreAPP — local service.
// Serves the web UI, resolves MuseScore scores, acquires the native file,
// and converts it to every format with libmscore (WASM).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { resolveScore, parseScoreId } from "./resolve.mjs";
import * as jmuse from "./sources/jmuse.mjs";
import * as official from "./sources/official.mjs";
import { search as mobileSearch } from "./sources/mobile-api.mjs";
import { buildPdfFromImages } from "./pdf.mjs";
import { convertAll, inspect, guessFormat, FORMAT_LIST } from "./convert.mjs";
import { browserFetch } from "./browser-engine.mjs";
import { smartFetch } from "./fetcher.mjs";
import { pageRender } from "./sources/cdn.mjs";
import { startWatcher, defaultWatchDir } from "./watcher.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, "..", "web");
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const MAX_BODY = 400 * 1024 * 1024;

/** in-memory score store: ref -> { bytes, inputFormat, title, id, createdAt } */
const STORE = new Map();
const INBOX = [];
const WATCH_DIR = defaultWatchDir();
const store = (bytes, meta = {}) => {
  const ref = crypto.randomBytes(9).toString("base64url");
  STORE.set(ref, { bytes, inputFormat: meta.inputFormat || "mscz", title: meta.title || null, id: meta.id || null, at: Date.now() });
  // keep the store small
  if (STORE.size > 24) STORE.delete(STORE.keys().next().value);
  return ref;
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".user.js": "text/javascript; charset=utf-8",
};

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-filename, x-input-format, x-score-id",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

function send(res, status, body, headers = {}) {
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    res.writeHead(status, { ...CORS, "content-type": "application/octet-stream", ...headers });
    res.end(Buffer.from(body));
    return;
  }
  const payload = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, { ...CORS, "content-type": "application/json; charset=utf-8", ...headers });
  res.end(payload);
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req, 8 * 1024 * 1024);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    throw new Error("请求体不是合法 JSON");
  }
}

function contentTypeFor(file) {
  if (file.endsWith(".user.js")) return MIME[".user.js"];
  return MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath.replace(/^\/+/, ""));
  const target = path.join(WEB_DIR, rel);
  if (!target.startsWith(WEB_DIR)) return send(res, 403, { error: "forbidden" });
  fs.readFile(target, (err, data) => {
    if (err) {
      // also allow /librescore-all.user.js to be served from /userscript
      const alt = path.join(__dirname, "..", "userscript", path.basename(rel));
      return fs.readFile(alt, (e2, d2) => {
        if (e2) return send(res, 404, { error: "not found", path: rel });
        res.writeHead(200, { ...CORS, "content-type": contentTypeFor(alt) });
        res.end(d2);
      });
    }
    res.writeHead(200, { ...CORS, "content-type": contentTypeFor(target) });
    res.end(data);
  });
}

/* ------------------------------ acquisition ------------------------------ */

/** Build a PDF out of the viewer page images (works without any token). */
async function acquirePdfFromImages(id, { salt, cookie, pageCount } = {}) {
  const attempts = [];
  const urls = [];
  const total = pageCount && pageCount > 0 ? pageCount : 40;
  for (let i = 0; i < total; i++) {
    const r = await jmuse.jmuseResolve(id, "img", i, { salt, cookie });
    attempts.push({ index: i, ok: r.ok, status: r.status, url: r.url });
    if (!r.ok || !r.url) break;
    urls.push(r.url);
    if (pageCount && urls.length >= pageCount) break;
  }
  if (!urls.length) return { ok: false, attempts, reason: "jmuse img 没有返回任何页面地址" };
  const pages = [];
  for (const url of urls) pages.push({ url, bytes: await jmuse.download(url, { cookie }) });
  const pdf = await buildPdfFromImages(pages);
  return { ok: true, bytes: pdf, format: "pdf", attempts, pageCount: pages.length };
}

/** Native (mscz) acquisition: try every strategy we know about, in order. */
async function acquireNative(id, { cookie, token, salt } = {}) {
  const report = [];

  // 1) LibreScore-style official app API
  const off = await official.acquireViaOfficial(id, { token, label: token ? "manual" : "broker" });
  report.push({ strategy: "official-app-api", ok: off.ok, attempts: off.attempts, reason: off.reason });
  if (off.ok) return { ok: true, bytes: off.bytes, format: off.format, source: "official-app-api", report };

  // 2) jmuse with native types (undocumented, may work for some accounts/scores)
  for (const type of ["mscz", "mscx", "mxl", "musicxml", "xml"]) {
    const r = await jmuse.jmuseResolve(id, type, 0, { salt, cookie });
    report.push({ strategy: `jmuse:${type}`, ok: r.ok, status: r.status, message: r.body?.message || r.body?.error || null, url: r.url });
    if (r.ok && r.url) {
      const bytes = await jmuse.download(r.url, { cookie });
      return { ok: true, bytes, format: type, source: `jmuse:${type}`, report };
    }
  }

  return { ok: false, report, reason: "所有原生格式策略都失败（详见 attempts）" };
}

/* -------------------------------- routes -------------------------------- */

const ROUTES = {
  "GET /api/health": async (req, res) => {
    const { findBrowser } = await import("./browser-engine.mjs");
    const { curlCffiAvailable } = await import("./fetcher.mjs");
    send(res, 200, {
      ok: true,
      app: "LibreScoreAPP",
      version: "1.1.0",
      formats: FORMAT_LIST,
      engines: {
        browser: findBrowser() || null,
        curlCffi: await curlCffiAvailable(),
      },
      env: {
        musescoreCookie: !!process.env.MUSESCORE_COOKIE,
        lsToken: !!process.env.LS_TOKEN,
        node: process.version,
      },
    });
  },

  /** 下载文件夹自动导入队列 */
  "GET /api/inbox": async (req, res) =>
    send(res, 200, { watching: WATCH_DIR, items: INBOX.slice(-20).reverse() }),

  "DELETE /api/inbox": async (req, res) => {
    INBOX.length = 0;
    send(res, 200, { ok: true });
  },
  "GET /api/formats": async (req, res) => send(res, 200, { formats: FORMAT_LIST }),

  /** Search MuseScore through the official mobile API (no Cloudflare, no attestation). */
  "GET /api/search": async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const q = (url.searchParams.get("text") || "").trim();
    const limit = Math.min(Number(url.searchParams.get("limit") || 20), 40);
    if (!q) return send(res, 400, { error: "缺少 text 参数" });
    try {
      const r = await mobileSearch(q, { limit });
      send(res, r.ok ? 200 : 502, r);
    } catch (e) {
      send(res, 502, { error: e.message });
    }
  },

  "GET /api/raw": async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const ref = url.searchParams.get("ref");
    const name = url.searchParams.get("name") || "score.bin";
    const item = STORE.get(ref);
    if (!item) return send(res, 404, { error: "ref 不存在" });
    const title = (item.title || "score").replace(/[\s<>:{}"/\\|?*~.]+/g, "_").slice(0, 60);
    const ext = name.includes(".") ? name.split(".").pop() : name;
    send(res, 200, item.bytes, {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${title}.${ext}`)}`,
    });
  },

  "POST /api/resolve": async (req, res) => {
    const { url } = await readJson(req);
    try {
      const info = await resolveScore(url);
      send(res, 200, info);
    } catch (e) {
      send(res, 400, { error: e.message, code: e.code || "RESOLVE_FAILED" });
    }
  },

  "POST /api/acquire": async (req, res) => {
    const { id, url, format = "mscz", cookie, token, pageCount } = await readJson(req);
    const scoreId = id || parseScoreId(url);
    if (!scoreId) return send(res, 400, { error: "缺少乐谱 ID" });
    const useCookie = cookie || process.env.MUSESCORE_COOKIE || "";
    const useToken = token || process.env.LS_TOKEN || "";
    const { salt } = await jmuse.discoverSalt({ cookie: useCookie });

    try {
      if (format === "mscz") {
        const r = await acquireNative(scoreId, { cookie: useCookie, token: useToken, salt });
        if (!r.ok) return send(res, 502, { ok: false, id: scoreId, format, report: r.report, reason: r.reason });
        const ref = store(r.bytes, { inputFormat: r.format, id: scoreId });
        return send(res, 200, { ok: true, id: scoreId, ref, format: r.format, source: r.source, bytes: r.bytes.length, report: r.report });
      }

      if (format === "pdf") {
        const r = await acquirePdfFromImages(scoreId, { salt, cookie: useCookie, pageCount });
        if (!r.ok) return send(res, 502, { ok: false, id: scoreId, format, report: r.attempts, reason: r.reason });
        const ref = store(r.bytes, { inputFormat: "pdf", id: scoreId });
        return send(res, 200, { ok: true, id: scoreId, ref, format: "pdf", source: "jmuse:img", bytes: r.bytes.length, pages: r.pageCount });
      }

      // mp3 / midi: direct from the site endpoint
      const type = format === "mid" || format === "midi" ? "midi" : format;
      const r = await jmuse.jmuseResolve(scoreId, type, 0, { salt, cookie: useCookie });
      if (!r.ok || !r.url) {
        return send(res, 502, { ok: false, id: scoreId, format, status: r.status, reason: r.body?.message || "jmuse 未返回地址" });
      }
      const bytes = await jmuse.download(r.url, { cookie: useCookie });
      const ref = store(bytes, { inputFormat: "mscz", id: scoreId });
      return send(res, 200, { ok: true, id: scoreId, ref, format, source: `jmuse:${type}`, bytes: bytes.length, url: r.url });
    } catch (e) {
      send(res, 500, { error: e.message });
    }
  },

  /** Import a file straight from a signed URL (e.g. the page's type_download_list entry). */
  "POST /api/fetch": async (req, res) => {
    const { url, cookie, filename } = await readJson(req);
    if (!/^https?:\/\//i.test(url || "")) return send(res, 400, { error: "需要一个 http(s) 直链" });
    const cookieHeader = cookie || process.env.MUSESCORE_COOKIE || "";
    try {
      const r = await smartFetch(url, { cookie: cookieHeader, headers: { referer: "https://musescore.com/" }, timeout: 120 });
      const buf = r.buf;
      const ct = r.headers["content-type"] || "";
      if (!r.ok || ct.includes("text/html")) {
        return send(res, 502, {
          error: `直链抓取失败（HTTP ${r.status}，${ct || "未知类型"}）。站点下载链接通常会 302 到 S3，服务器侧可能被 Cloudflare 拦住——改用油猴脚本的「下载」按钮让浏览器自己取。`,
          status: r.status,
          contentType: ct,
          preview: buf.subarray(0, 200).toString("utf8"),
        });
      }
      const guessExt =
        (filename && filename.split(".").pop()) ||
        (ct.includes("zip") ? "mscz" : ct.includes("pdf") ? "pdf" : ct.includes("midi") ? "mid" : "bin");
      const ref = store(buf, { inputFormat: guessFormat(`x.${guessExt}`), title: filename?.replace(/\.[^.]+$/, "") || null });
      send(res, 200, { ok: true, ref, bytes: buf.length, contentType: ct, ext: guessExt, finalUrl: r.url });
    } catch (e) {
      send(res, 502, { error: `直链抓取异常：${e.message}` });
    }
  },

  /** Drive the user's own browser: pass Cloudflare naturally, then read the page's signed links. */
  "POST /api/browser": async (req, res) => {
    const { url, want = ["mscz"], headful = true, timeoutMs } = await readJson(req);
    if (!url) return send(res, 400, { error: "缺少 url" });
    const logs = [];
    try {
      const r = await browserFetch({ scoreUrl: url, want, headful, timeoutMs, onLog: (m) => logs.push(m) });
      if (!r.ok) {
        return send(res, 502, { ok: false, message: r.message, title: r.title, list: r.list, logs });
      }
      const refs = r.files.map((f) => ({
        type: f.type,
        bytes: f.bytes.length,
        ref: store(f.bytes, { inputFormat: guessFormat(`x.${f.type}`), title: r.title }),
      }));
      send(res, 200, { ok: true, title: r.title, list: r.list, refs, logs });
    } catch (e) {
      send(res, 500, { ok: false, error: e.message, logs });
    }
  },

  /** Cloudflare-free CDN: page-1 render of a score (needs the 40-hex render hash). */
  "GET /api/preview": async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const hash = url.searchParams.get("hash") || "";
    const page = Number(url.searchParams.get("page") || 0);
    const format = url.searchParams.get("format") || "png";
    try {
      const r = await pageRender(hash, { page, format });
      if (!r.ok) return send(res, 404, { error: r.message, status: r.status });
      send(res, 200, r.bytes, { "content-type": r.contentType || "image/png" });
    } catch (e) {
      send(res, 500, { error: e.message });
    }
  },
  "POST /api/probe": async (req, res) => {    const { id, url, token } = await readJson(req);
    const scoreId = id || parseScoreId(url);
    if (!scoreId) return send(res, 400, { error: "缺少乐谱 ID" });
    const cookie = process.env.MUSESCORE_COOKIE || "";
    const { salt, cached, error } = await jmuse.discoverSalt({ cookie });
    const rows = [];
    for (const type of jmuse.PROBE_TYPES) {
      rows.push(await jmuse.tryType(scoreId, type, { salt, cookie }));
    }
    const off = await official.acquireViaOfficial(scoreId, { token: token || process.env.LS_TOKEN });
    send(res, 200, {
      id: scoreId,
      salt: { value: salt, cached, error },
      jmuse: rows,
      official: { ok: off.ok, format: off.format, attempts: off.attempts, reason: off.reason },
    });
  },

  /** Raw MSCZ (or any score file) pushed by the companion userscript / browser helper. */
  "POST /api/upload": async (req, res) => {
    const buf = await readBody(req);
    if (!buf.length) return send(res, 400, { error: "空请求体" });
    const filename = decodeURIComponent(req.headers["x-filename"] || "score.mscz");
    const id = req.headers["x-score-id"] ? Number(req.headers["x-score-id"]) : null;
    const inputFormat = guessFormat(filename);
    let title = path.basename(filename).replace(/\.[^.]+$/, "");
    let info = null;
    try {
      info = await inspect(buf, inputFormat);
      if (info?.title) title = info.title;
    } catch (e) {
      // still store it — user may only want to keep the raw bytes
      info = { error: e.message };
    }
    const ref = store(buf, { inputFormat, title, id });
    send(res, 200, { ok: true, ref, id, title, inputFormat, bytes: buf.length, parts: info?.parts ?? [], pages: info?.pages ?? null, meta: info?.meta ?? null, error: info?.error });
  },

  "POST /api/convert": async (req, res) => {
    const { ref, formats = ["mscz"], partIds = null, zip = true } = await readJson(req);
    const item = STORE.get(ref);
    if (!item) return send(res, 404, { error: "找不到这次上传的谱面（服务重启或已过期）" });
    const wanted = formats.filter((f) => FORMAT_LIST.some((x) => x.ext === f));
    if (!wanted.length) return send(res, 400, { error: "没有可导出的格式" });

    const logs = [];
    try {
      const files = await convertAll(item.bytes, {
        inputFormat: item.inputFormat,
        formats: wanted,
        partIds,
        onProgress: (p) => logs.push(p),
      });
      if (!files.length) return send(res, 500, { error: "转换没有产出任何文件", logs });

      const base = (item.title || "score").replace(/[\s<>:{}"/\\|?*~.]+/g, "_").slice(0, 60);
      const { default: JSZip } = await import("jszip");
      const archive = new JSZip();
      for (const f of files) archive.file(f.name, f.data);
      const zipBuf = await archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });

      send(res, 200, zipBuf, {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${base}-${wanted.join("+")}.zip`)}`,
        "x-lscore-files": String(files.length),
      });
    } catch (e) {
      send(res, 500, { error: e.message, logs });
    }
  },

  "POST /api/inspect": async (req, res) => {
    const { ref } = await readJson(req);
    const item = STORE.get(ref);
    if (!item) return send(res, 404, { error: "ref 不存在" });
    try {
      send(res, 200, await inspect(item.bytes, item.inputFormat));
    } catch (e) {
      send(res, 500, { error: e.message });
    }
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }
  const key = `${req.method} ${url.pathname}`;
  const handler = ROUTES[key];
  if (handler) {
    try {
      await handler(req, res);
    } catch (e) {
      console.error("[route error]", key, e);
      if (!res.headersSent) send(res, 500, { error: e.message });
      else res.end();
    }
    return;
  }
  if (req.method === "GET") return serveStatic(req, res, url.pathname);
  send(res, 404, { error: "not found", path: url.pathname });
});

server.listen(PORT, HOST, () => {
  console.log(`\n  LibreScoreAPP  →  http://${HOST}:${PORT}\n`);
  try {
    startWatcher({
      dir: WATCH_DIR,
      log: (m) => console.log(m),
      onFile: async ({ path: filePath, name, bytes }) => {
        const inputFormat = guessFormat(name);
        let title = name.replace(/\.[^.]+$/, "");
        let info = null;
        try {
          info = await inspect(bytes, inputFormat);
          if (info?.title) title = info.title;
        } catch {}
        const ref = store(bytes, { inputFormat, title });
        INBOX.push({ ref, name, title, bytes: bytes.length, inputFormat, pages: info?.pages ?? null, at: Date.now() });
        if (INBOX.length > 40) INBOX.shift();
        console.log(`[watch] 自动导入 ${name}（${(bytes.length / 1024).toFixed(1)} KiB）→ ref=${ref}`);
      },
    });
  } catch (e) {
    console.log("[watch] 启动失败:", e.message);
  }
  console.log(`  格式: ${FORMAT_LIST.map((f) => f.ext).join(", ")}`);
  if (!process.env.LS_TOKEN) console.log("  提示: 未设置 LS_TOKEN，原生 MSCZ 走 broker / 浏览器助手");
});
