// ==UserScript==
// @name         LibreScore · MuseScore 全格式取回
// @name:en      LibreScore — MuseScore all-format fetcher
// @namespace    https://librescore.app/
// @version      2.0.0
// @description  在 musescore.com 乐谱页取回 mscz/mxl/mid/mp3/pdf：读页面自带下载表 + 抓站点自己的下载请求 + jmuse 兜底；可取回到本地或直接下载，并可交给本地 LibreScoreAPP 转成 12 种格式。
// @author       LibreScoreAPP
// @match        https://musescore.com/*
// @match        https://*.musescore.com/*
// @icon         https://musescore.com/favicon.ico
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      musescore.com
// @connect      ustatik.com
// @connect      amazonaws.com
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-start
// @homepage     http://127.0.0.1:8787
// ==/UserScript==

/* ============================================================================
 * LibreScore · 2.0（发行版，单文件）
 * ---------------------------------------------------------------------------
 * 结构：
 *   1. 常量 / 状态
 *   2. 工具函数（转义、ID、URL、md5）
 *   3. 网络钩子（页面真实 window：fetch / XHR / <a>.click / window.open）
 *   4. 直链收集（UGAPP store → HTML → DOM）
 *   5. jmuse 兜底（salt + md5 鉴权）
 *   6. 取字节（页面 fetch → GM → 浏览器下载兜底）
 *   7. 界面（字符串渲染 + 事件委托 + 可折叠 / 可拖动 / 记住状态）
 *   8. 启动
 * ==========================================================================*/

(function () {
  "use strict";

  /* ---------------------------------------------------------------- 1. 常量 */
  const VERSION = "2.0.0";
  const UW = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  const APP = localStorage.getItem("lsapp.server") || "http://127.0.0.1:8787";
  const TYPES = ["mscz", "mscx", "mxl", "musicxml", "xml", "mid", "mp3", "pdf", "pdf-sample", "mp4-sheet"];
  const NATIVE = new Set(["mscz", "mscx", "mxl", "musicxml", "xml"]);
  const LS = {
    collapsed: "ls2.collapsed",
    offset: "ls2.offset",
    lastScore: "ls2.lastScore",
  };

  const state = {
    candidates: [],
    captured: [],
    jmuse: [],
    salt: null,
    appOnline: null,
    busy: false,
    tabs: { capture: true, paste: true, log: false },
  };

  /* ------------------------------------------------------------ 2. 工具函数 */
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  const kb = (n) => (n >= 1048576 ? (n / 1048576).toFixed(2) + " MB" : (n / 1024).toFixed(1) + " KiB");

  const scoreId = () => {
    const m = location.pathname.match(/\/(?:scores|score)\/(\d+)/);
    if (m) return Number(m[1]);
    const q = location.search.match(/[?&](?:score_id|ssid)=(\d+)/);
    return q ? Number(q[1]) : null;
  };

  const scoreTitle = () => {
    const t =
      document.querySelector('meta[property="og:title"]')?.content ||
      (UW.UGAPP && UW.UGAPP.store?.page?.data?.score?.title) ||
      document.title ||
      "score";
    return String(t).replace(/\s*[-|]\s*MuseScore.*$/i, "").trim();
  };

  const fileBase = () =>
    scoreTitle().replace(/[\s<>:{}"/\\|?*~.]+/g, "_").replace(/_+/g, "_").slice(0, 70) || "score";

  const shortUrl = (u) => {
    try {
      const x = new URL(u, location.href);
      return x.host + x.pathname + x.search;
    } catch {
      return String(u);
    }
  };

  const typeOfUrl = (url) => {
    let t = (url.match(/[?&]type=([a-z0-9-]+)/i) || [])[1];
    if (!t) t = (url.match(/\.(mscz|mscx|mxl|musicxml|mid|mp3|pdf)\b/i) || [])[1];
    return t ? String(t).toLowerCase() : "?";
  };

  function recoverJson(s) {
    return s
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&#x27;/gi, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  }

  function matchBalanced(text, start) {
    const opener = text[start];
    if (opener !== "{" && opener !== "[") return -1;
    const stack = [];
    let inString = null;
    let escape = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escape) escape = false;
        else if (ch === "\\") escape = true;
        else if (ch === inString) inString = null;
        continue;
      }
      if (ch === '"' || ch === "'") inString = ch;
      else if (ch === "{" || ch === "[") stack.push(ch);
      else if (ch === "}" || ch === "]") {
        const open = stack.pop();
        if ((ch === "}" && open !== "{") || (ch === "]" && open !== "[")) return -1;
        if (stack.length === 0) return i + 1;
      }
    }
    return -1;
  }

  function findArrayByKey(decoded, key) {
    const needle = `"${key}":`;
    let from = 0;
    for (;;) {
      const at = decoded.indexOf(needle, from);
      if (at < 0) return null;
      from = at + needle.length;
      let p = from;
      while (p < decoded.length && /\s/.test(decoded[p])) p++;
      if (decoded[p] === "[") {
        const end = matchBalanced(decoded, p);
        if (end > 0) {
          try {
            const arr = JSON.parse(decoded.slice(p, end));
            if (Array.isArray(arr)) return arr;
          } catch {}
        }
      }
    }
  }

  /* ------------------------------------------------------------ 3. 网络钩子 */
  const DOWNLOAD_RE = /(score\/download\/index|\.(?:mscz|mscx|mxl|musicxml)(?:\?|$)|[?&]type=(?:mscz|mscx|mxl|musicxml)\b)/i;
  const SELF_RE = /\/api\/jmuse|[?&]type=(?:mp3|midi|mid|img)\b/i;
  let silentFetch = false;

  function recordDownload(raw, source) {
    if (silentFetch || !raw || typeof raw !== "string") return;
    if (raw.startsWith("blob:") || raw.startsWith("data:")) return;
    if (!DOWNLOAD_RE.test(raw) || SELF_RE.test(raw)) return;
    let abs;
    try {
      abs = new URL(raw, location.href).href;
    } catch {
      return;
    }
    if (state.captured.some((c) => c.url === abs)) return;
    const type = typeOfUrl(abs);
    state.captured.push({ type, url: abs, source });
    ui.renderCaptured();
    ui.log(`捕获下载请求（${source}）：${type} · ${shortUrl(abs)}`);
  }

  function setProp(W, key, value) {
    try {
      W[key] = value;
      if (W[key] === value) return true;
    } catch {}
    try {
      Object.defineProperty(W, key, { value, configurable: true, writable: true });
      return W[key] === value;
    } catch {
      return false;
    }
  }

  function installHooks() {
    const W = UW;
    const out = { fetch: false, xhr: false, anchor: false, open: false };
    try {
      const orig = W.fetch;
      if (orig && !orig.__lsHooked) {
        const patched = function (input) {
          try {
            recordDownload(typeof input === "string" ? input : input && input.url, "fetch");
          } catch {}
          return orig.apply(this, arguments);
        };
        patched.__lsHooked = true;
        out.fetch = setProp(W, "fetch", patched);
      } else out.fetch = !!(orig && orig.__lsHooked);
    } catch {}
    try {
      const XP = W.XMLHttpRequest && W.XMLHttpRequest.prototype;
      if (XP && !XP.open.__lsHooked) {
        const orig = XP.open;
        const patched = function (m, url) {
          try {
            recordDownload(url, "xhr");
          } catch {}
          return orig.apply(this, arguments);
        };
        patched.__lsHooked = true;
        XP.open = patched;
        out.xhr = XP.open === patched;
      } else out.xhr = !!(XP && XP.open.__lsHooked);
    } catch {}
    try {
      const AP = W.HTMLAnchorElement && W.HTMLAnchorElement.prototype;
      if (AP && !AP.click.__lsHooked) {
        const orig = AP.click;
        const patched = function () {
          try {
            recordDownload(this.href, "a.click");
          } catch {}
          return orig.apply(this, arguments);
        };
        patched.__lsHooked = true;
        AP.click = patched;
        out.anchor = AP.click === patched;
      } else out.anchor = !!(AP && AP.click.__lsHooked);
    } catch {}
    try {
      const orig = W.open;
      if (orig && !orig.__lsHooked) {
        const patched = function (url) {
          try {
            recordDownload(url, "window.open");
          } catch {}
          return orig.apply(this, arguments);
        };
        patched.__lsHooked = true;
        out.open = setProp(W, "open", patched);
      } else out.open = !!(orig && orig.__lsHooked);
    } catch {}
    W.__lsHooks = { ...out, at: Date.now() };
    return out;
  }

  /* ------------------------------------------------------------ 4. 直链收集 */
  const normItem = (x) => {
    if (!x) return null;
    const type = String(x.type || x.format || x.ext || "").toLowerCase().trim();
    const url = String(x.url || x.href || x.download || x.link || "").trim();
    if (!type || !url || !/^https?:|^\//.test(url)) return null;
    return { type: type === "midi" ? "mid" : type, url: url.startsWith("//") ? location.protocol + url : url };
  };

  function sources() {
    const out = { store: [], html: [], dom: [] };

    const seen = new Set();
    const walk = (o, depth, path) => {
      if (!o || depth > 12 || typeof o !== "object" || seen.has(o)) return;
      seen.add(o);
      if (Array.isArray(o)) {
        for (const v of o) walk(v, depth + 1, path);
        return;
      }
      if (Array.isArray(o.type_download_list)) {
        for (const it of o.type_download_list) {
          const n = normItem(it);
          if (n) out.store.push({ ...n, source: "store" });
        }
      }
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === "string" && /\/score\/download\//.test(v)) {
          const m = v.match(/[?&]type=([a-z0-9]+)/i);
          if (m) out.store.push({ type: m[1].toLowerCase(), url: v, source: "store" });
        } else if (v && typeof v === "object") walk(v, depth + 1, path + "." + k);
      }
    };
    for (const root of [UW.UGAPP, UW.__INITIAL_STATE__, UW.__NUXT__, UW.__APP_STATE__]) {
      try {
        walk(root, 0, "root");
      } catch {}
    }

    const html = document.documentElement.innerHTML || "";
    for (const variant of [recoverJson(html), html]) {
      const arr = findArrayByKey(variant, "type_download_list");
      if (arr) {
        for (const it of arr) {
          const n = normItem(it);
          if (n) out.html.push({ ...n, source: "html" });
        }
      }
      if (out.html.length) break;
    }
    for (const m of html.match(/https?:\/\/[^\s"'\\<>]*\/score\/download\/index\?[^\s"'\\<>]+/g) || []) {
      const t = m.match(/[?&]type=([a-z0-9-]+)/i);
      if (t) out.html.push({ type: t[1].toLowerCase(), url: m.replace(/&amp;/g, "&"), source: "html" });
    }

    for (const a of document.querySelectorAll('a[href*="score/download"]')) {
      const href = a.getAttribute("href") || a.href;
      const t = (href.match(/[?&]type=([a-z0-9-]+)/i) || [])[1];
      if (t) out.dom.push({ type: t.toLowerCase(), url: new URL(href, location.href).href, source: "dom" });
    }
    return out;
  }

  const dedupe = (arr) => {
    const byType = new Map();
    for (const it of arr) if (it && it.type && it.url && !byType.has(it.type)) byType.set(it.type, it);
    return [...byType.values()].sort((a, b) => TYPES.indexOf(a.type) - TYPES.indexOf(b.type));
  };

  function expandTypes(url) {
    let u;
    try {
      u = new URL(url, location.href);
    } catch {
      return [];
    }
    if (!u.searchParams.get("score_id") || !u.searchParams.get("h")) return [];
    return ["mscz", "mscx", "mxl", "musicxml", "mid", "mp3", "pdf"].map((t) => {
      const c = new URL(u.href);
      c.searchParams.set("type", t);
      return { type: t, url: c.href, source: "same-h" };
    });
  }

  /* ------------------------------------------------------------- 5. jmuse */
  let saltPromise = null;
  function getSalt() {
    if (saltPromise) return saltPromise;
    saltPromise = (async () => {
      const links = [
        ...document.head.innerHTML.matchAll(/href=["']([^"']*\/static\/public\/build\/musescore[^"']*?\.js)["']/g),
      ].map((m) => new URL(m[1], location.href).href);
      for (const u of links.slice(0, 6)) {
        try {
          const t = await (await fetch(u)).text();
          const m = t.match(/"([^"]+)"\)\.substr\(0,4\)/);
          if (m) return m[1];
        } catch {}
      }
      return "9654,4e";
    })();
    return saltPromise;
  }

  async function jmuseOne(type, index = 0) {
    const id = scoreId();
    const salt = await getSalt();
    state.salt = salt;
    const auth = md5hex(`${id}${type}${index}${salt}`).slice(0, 4);
    const r = await fetch(`/api/jmuse?id=${id}&type=${type}&index=${index}`, {
      headers: { authorization: auth, accept: "application/json" },
      credentials: "include",
    });
    const txt = await r.text();
    let j = null;
    try {
      j = JSON.parse(txt);
    } catch {}
    return { type, status: r.status, url: j?.info?.url || null, message: j?.message || j?.error || "" };
  }

  async function probeJmuse(onLine) {
    const found = [];
    const report = [];
    for (const t of TYPES) {
      try {
        const r = await jmuseOne(t);
        report.push(r);
        onLine(`${t.padEnd(10)} ${r.url ? "✓" : "·"} HTTP ${r.status}${r.url ? "" : r.message ? " " + r.message : ""}`);
        if (r.url) found.push({ type: t, url: r.url, source: "jmuse" });
      } catch (e) {
        report.push({ type: t, status: 0, message: e.message });
        onLine(`${t.padEnd(10)} ERR ${e.message}`);
      }
    }
    state.jmuse = report;
    return found;
  }

  /* -------------------------------------------------------------- 6. 取字节 */
  const gmRequest =
    typeof GM_xmlhttpRequest === "function"
      ? GM_xmlhttpRequest
      : typeof GM !== "undefined" && GM.xmlHttpRequest
        ? GM.xmlHttpRequest
        : null;

  const looksLikeHtml = (buf) => {
    const head = new TextDecoder().decode(buf.subarray(0, 200)).toLowerCase();
    return head.includes("<!doctype html") || head.includes("<html") || head.includes("just a moment");
  };

  const cleanUrl = (url) => {
    try {
      const u = new URL(url, location.href);
      u.searchParams.delete("__cf_chl_tk");
      u.searchParams.delete("__cf_chl_rt_tk");
      return u.href;
    } catch {
      return url;
    }
  };

  async function pageFetch(u) {
    silentFetch = true;
    try {
      const r = await fetch(u, { credentials: "include", referrer: location.href, redirect: "follow" });
      const ctype = r.headers.get("content-type") || "";
      if (r.type === "opaque") throw new Error("跨域重定向，页面 fetch 读不到内容");
      if (!r.ok) throw new Error(`HTTP ${r.status}${ctype ? " " + ctype : ""}`);
      return { bytes: new Uint8Array(await r.arrayBuffer()), ctype };
    } finally {
      silentFetch = false;
    }
  }

  function gmFetch(u, onProgress) {
    return new Promise((resolve, reject) => {
      if (!gmRequest) return reject(new Error("无 GM_xmlhttpRequest"));
      gmRequest({
        method: "GET",
        url: u,
        responseType: "arraybuffer",
        headers: {
          referer: location.href,
          origin: location.origin,
          accept: "*/*",
          "x-requested-with": "XMLHttpRequest",
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-origin",
        },
        onprogress: (e) => onProgress && e.lengthComputable && onProgress(e.loaded / e.total),
        onload: (r) => {
          if (r.status >= 200 && r.status < 400 && r.response && r.response.byteLength > 0) {
            const ctype = (r.responseHeaders || "").match(/content-type:\s*([^\r\n]+)/i)?.[1] || "";
            resolve({ bytes: new Uint8Array(r.response), ctype });
          } else reject(new Error(`GM HTTP ${r.status}`));
        },
        onerror: () => reject(new Error("GM 网络错误")),
        ontimeout: () => reject(new Error("GM 超时")),
      });
    });
  }

  async function fetchBytes(url, onProgress) {
    const base = cleanUrl(url);
    const variants = [base];
    if (/^http:\/\//i.test(base)) variants.push(base.replace(/^http:/i, "https:"));
    const errors = [];
    for (const u of variants) {
      try {
        const r = await pageFetch(u);
        if (r.bytes.length > 199 && !looksLikeHtml(r.bytes)) return r.bytes;
        errors.push(`页面 fetch：${r.ctype || "?"} ${r.bytes.length}B${looksLikeHtml(r.bytes) ? "（HTML）" : ""}`);
      } catch (e) {
        errors.push(`页面 fetch：${e.message}`);
      }
    }
    for (const u of variants) {
      try {
        const r = await gmFetch(u, onProgress);
        if (r.bytes.length > 199 && !looksLikeHtml(r.bytes)) return r.bytes;
        errors.push(`GM：${r.ctype || "?"} ${r.bytes.length}B${looksLikeHtml(r.bytes) ? "（HTML）" : ""}`);
      } catch (e) {
        errors.push(`GM：${e.message}`);
      }
    }
    throw new Error(errors.join(" ｜ "));
  }

  function postToApp(bytes, ext) {
    const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const headers = {
      "content-type": "application/octet-stream",
      "x-filename": encodeURIComponent(`${fileBase()}.${ext}`),
      "x-score-id": String(scoreId() || ""),
    };
    if (gmRequest) {
      return new Promise((resolve, reject) => {
        gmRequest({
          method: "POST",
          url: `${APP}/api/upload`,
          headers,
          data: body,
          onload: (r) => {
            try {
              resolve(JSON.parse(r.responseText || "{}"));
            } catch {
              resolve({});
            }
          },
          onerror: () => reject(new Error("连不上本地 App（先 npm start）")),
        });
      });
    }
    return fetch(`${APP}/api/upload`, { method: "POST", headers, body }).then((r) => r.json());
  }

  function saveLocal(bytes, ext) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
    a.download = `${fileBase()}.${ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  function browserDownload(url, ext) {
    try {
      const a = document.createElement("a");
      a.href = url;
      a.download = `${fileBase()}.${ext}`;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => a.remove(), 1500);
      ui.log("已交给浏览器下载；完成后若本地 App 在跑，「自动导入」会接手");
      return true;
    } catch (e) {
      ui.log("浏览器下载失败：" + e.message);
      return false;
    }
  }

  /** 取一条：mode=save 保存 / app 送本地。失败自动换原生格式、再退浏览器下载。 */
  async function take(it, mode, btn) {
    if (btn) btn.disabled = true;
    const label = btn ? btn.textContent : "";
    try {
      const bytes = await fetchBytes(it.url, (p) => btn && (btn.textContent = Math.round(p * 100) + "%"));
      if (bytes.length < 200) throw new Error(`只有 ${bytes.length} B`);
      if (mode === "app") {
        const res = await postToApp(bytes, it.type === "?" ? "bin" : it.type);
        ui.log(`已发送 ${it.type}（${kb(bytes.length)}）→ App ref=${res.ref || "?"}`);
      } else {
        saveLocal(bytes, it.type === "?" ? "bin" : it.type);
        ui.log(`已保存 ${it.type}（${kb(bytes.length)}）`);
      }
      return true;
    } catch (e) {
      ui.log(`${it.type} 取回失败：${e.message}`);
      if (await tryAlternates(it, mode)) return true;
      browserDownload(it.url, it.type === "?" ? "bin" : it.type);
      return false;
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = label;
      }
    }
  }

  async function tryAlternates(it, mode) {
    if (!/^mscz$/i.test(it.type || "")) return false;
    const alts = expandTypes(it.url).filter((x) => ["mscx", "mxl", "musicxml"].includes(x.type));
    for (const alt of alts) {
      try {
        ui.log(`改试同 h 的 ${alt.type} …`);
        const bytes = await fetchBytes(alt.url);
        if (bytes.length < 200) throw new Error(`只有 ${bytes.length} B`);
        if (mode === "app") {
          const res = await postToApp(bytes, alt.type);
          ui.log(`已改用 ${alt.type}（${kb(bytes.length)}）→ ref=${res.ref}；在 App 里勾 MSCZ 可由它重建工程`);
        } else {
          saveLocal(bytes, alt.type);
          ui.log(`已保存 ${alt.type}（${kb(bytes.length)}）`);
        }
        return true;
      } catch (e) {
        ui.log(`  ${alt.type} 也不行：${e.message}`);
      }
    }
    return false;
  }

  /* ----------------------------------------------------------------- 7. 界面 */
  const ui = {
    log: (m) => console.log("[LibreScore]", m),
    render: () => {},
    renderCaptured: () => {},
    setStatus: () => {},
  };

  const CSS = `
  .ls2{position:fixed;right:18px;bottom:18px;z-index:2147483000;width:412px;max-width:calc(100vw - 24px);
    display:flex;flex-direction:column;max-height:82vh;
    font:13px/1.55 "Segoe UI","Noto Sans SC",system-ui,sans-serif;color:#e6e9ef;
    background:#11141a;border:1px solid #242a35;border-radius:16px;overflow:hidden;
    box-shadow:0 18px 48px rgba(0,0,0,.55),0 2px 8px rgba(0,0,0,.35)}
  .ls2 *{box-sizing:border-box}
  .ls2 header{display:flex;align-items:center;gap:9px;padding:10px 12px;background:#161a21;
    border-bottom:1px solid #242a35;cursor:move;user-select:none;flex:0 0 auto}
  .ls2 .logo{width:22px;height:22px;border-radius:7px;display:grid;place-items:center;
    background:linear-gradient(135deg,#1d6144,#134956);color:#5ce09a;font-size:13px}
  .ls2 .name{font-size:13px;font-weight:600;letter-spacing:.2px}
  .ls2 .ver{font:10.5px/1 Consolas,monospace;color:#7d879b;background:#0d1117;border:1px solid #222833;
    border-radius:999px;padding:2px 6px}
  .ls2 .dot{width:7px;height:7px;border-radius:50%;background:#5c6675;flex:0 0 auto}
  .ls2 .dot.on{background:#45d483;box-shadow:0 0 0 3px rgba(69,212,131,.14)}
  .ls2 .dot.off{background:#ff6b6b;box-shadow:0 0 0 3px rgba(255,107,107,.12)}
  .ls2 .grow{flex:1}
  .ls2 .icon{background:none;border:none;color:#7d879b;cursor:pointer;font-size:15px;padding:0 3px;line-height:1}
  .ls2 .icon:hover{color:#cdd6e4}
  .ls2 .body{padding:12px;overflow:auto;display:flex;flex-direction:column;gap:10px}
  .ls2 .meta{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
  .ls2 .title{font-size:14px;font-weight:600;color:#f2f5fa;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ls2 .id{font:10.5px/1 Consolas,monospace;color:#7d879b}
  .ls2 .actions{display:flex;gap:8px;flex-wrap:wrap}
  .ls2 button{font:inherit;background:#1a1f27;color:#dfe5ee;border:1px solid #2a313d;border-radius:9px;
    padding:7px 11px;cursor:pointer;transition:border-color .15s,background .15s}
  .ls2 button:hover:not(:disabled){border-color:#3e8f68;background:#1d242d}
  .ls2 button:disabled{opacity:.45;cursor:not-allowed}
  .ls2 button.primary{background:linear-gradient(135deg,#1c5a3f,#14514a);border-color:#2b6a50;color:#d9ffea}
  .ls2 button.primary:hover:not(:disabled){border-color:#45d483}
  .ls2 button.ghost{background:transparent}
  .ls2 .section{display:flex;align-items:center;gap:8px;margin-top:2px}
  .ls2 .section .label{font-size:11px;letter-spacing:.4px;color:#7d879b;text-transform:uppercase}
  .ls2 .section .count{font:10.5px/1 Consolas,monospace;color:#5ce09a}
  .ls2 .section .line{flex:1;height:1px;background:#222a34}
  .ls2 .list{display:flex;flex-direction:column;gap:7px}
  .ls2 .row{display:flex;flex-wrap:wrap;align-items:center;gap:7px;padding:8px 9px;
    background:#141821;border:1px solid #232a35;border-radius:11px}
  .ls2 .row:hover{border-color:#2f3a47}
  .ls2 .chip{font:600 11.5px/1 Consolas,monospace;padding:4px 8px;border-radius:7px;
    background:#0d1a15;border:1px solid #1e3a2c;color:#79e3ac;min-width:56px;text-align:center}
  .ls2 .chip.audio{background:#1a1710;border-color:#3a3220;color:#e8c37e}
  .ls2 .chip.img{background:#141a22;border-color:#243042;color:#8fb6e8}
  .ls2 .src{font:10.5px/1 Consolas,monospace;color:#6f7a8d;background:#0f131a;border:1px solid #212833;
    border-radius:6px;padding:3px 6px}
  .ls2 .row .sp{flex:1}
  .ls2 .row button{padding:5px 9px;font-size:12px;border-radius:8px}
  .ls2 .url{flex:1 1 100%;font:10.5px/1.45 Consolas,monospace;color:#66718a;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ls2 .url:hover{color:#9aa7bd}
  .ls2 .empty{font-size:12px;color:#6f7a8d;padding:10px 4px;line-height:1.6}
  .ls2 .tab{border-top:1px solid #202733;padding:8px 12px;background:#0f131a}
  .ls2 .tab summary{cursor:pointer;color:#8a95a8;font-size:12px;outline:none;list-style:none}
  .ls2 .tab summary::-webkit-details-marker{display:none}
  .ls2 .tab summary::before{content:"▸ ";color:#5c6675}
  .ls2 .tab[open] summary::before{content:"▾ "}
  .ls2 .tab .pad{padding:8px 0 2px}
  .ls2 input[type=text]{width:100%;background:#0b0e13;border:1px solid #232a35;color:#dfe5ee;
    border-radius:9px;padding:7px 9px;font:11px/1.4 Consolas,monospace}
  .ls2 input[type=text]:focus{outline:none;border-color:#3e8f68}
  .ls2 .log{max-height:130px;overflow:auto;font:11px/1.5 Consolas,monospace;color:#9aa7bd;white-space:pre-wrap}
  .ls2 .hint{font-size:11px;color:#66718a;line-height:1.6}
  .ls2.collapsed .body,.ls2.collapsed .tab{display:none}
  `;

  function boot() {
    if (document.getElementById("ls2-panel")) return;

    const style = document.createElement("style");
    style.textContent = CSS;
    document.documentElement.appendChild(style);

    const panel = document.createElement("section");
    panel.id = "ls2-panel";
    panel.className = "ls2";
    panel.innerHTML = `
      <header id="ls2-head">
        <span class="logo">♪</span>
        <span class="name">LibreScore</span>
        <span class="ver">v${VERSION}</span>
        <span class="dot" id="ls2-dot" title="本地 App 连接状态"></span>
        <span class="grow"></span>
        <button class="icon" id="ls2-collapse" title="收起 / 展开">—</button>
      </header>
      <div class="body">
        <div class="meta">
          <span class="title" id="ls2-title">MuseScore</span>
          <span class="id" id="ls2-id"></span>
        </div>
        <div class="actions">
          <button class="primary" id="ls2-get">取回 MSCZ → 本地 App</button>
          <button id="ls2-save">直接下载</button>
          <button class="ghost" id="ls2-rescan">重扫</button>
        </div>
        <div class="section"><span class="label">可用直链</span><span class="count" id="ls2-count"></span><span class="line"></span></div>
        <div class="list" id="ls2-list"></div>
        <div class="actions">
          <button class="ghost" id="ls2-jmuse">jmuse 探测</button>
          <button class="ghost" id="ls2-why">为什么下不了</button>
          <button class="ghost" id="ls2-diag">诊断</button>
        </div>
      </div>
      <details class="tab" id="ls2-tab-capture">
        <summary>站点下载请求 <span class="count" id="ls2-capcount"></span></summary>
        <div class="pad list" id="ls2-cap"></div>
      </details>
      <details class="tab" id="ls2-tab-paste">
        <summary>粘贴下载地址</summary>
        <div class="pad">
          <input id="ls2-paste" type="text" placeholder="http://musescore.com/score/download/index?score_id=…&type=mscz&h=…" />
          <div class="actions" style="margin-top:8px">
            <button id="ls2-pastego">取回这条 URL</button>
            <button class="ghost" id="ls2-copyall">复制全部链接</button>
            <button class="ghost" id="ls2-capclear">清空捕获</button>
          </div>
        </div>
      </details>
      <details class="tab" id="ls2-tab-log">
        <summary>日志</summary>
        <div class="pad log" id="ls2-log"></div>
      </details>`;
    document.documentElement.appendChild(panel);

    const $ = (id) => panel.querySelector("#" + id);
    const listEl = $("ls2-list");
    const capEl = $("ls2-cap");
    const logEl = $("ls2-log");

    /* 追加式日志 */
    const logLines = [];
    const log = (m) => {
      const s = String(m ?? "");
      logLines.push(s);
      while (logLines.join("\n").length > 9000) logLines.shift();
      logEl.textContent = logLines.join("\n");
      logEl.scrollTop = logEl.scrollHeight;
      $("ls2-tab-log").open = true;
    };
    ui.log = log;

    /* ---------------------------------------------------------- 渲染 */
    const chipClass = (t) => (NATIVE.has(t) ? "" : t === "mp3" || t === "mid" ? "audio" : "img");

    const rowHtml = (it, i, kind) => {
      const hasH = /score\/download\/index/.test(it.url) && /[?&]h=/.test(it.url);
      const acts =
        `<button data-act="take" data-kind="${kind}" data-i="${i}">取回</button>` +
        `<button class="primary" data-act="app" data-kind="${kind}" data-i="${i}">→ App</button>` +
        (hasH ? `<button data-act="expand" data-kind="${kind}" data-i="${i}">展开</button>` : "") +
        `<button data-act="open" data-kind="${kind}" data-i="${i}">浏览器</button>`;
      return (
        `<div class="row">` +
        `<span class="chip ${chipClass(it.type)}">${esc(it.type)}</span>` +
        `<span class="src">${esc(it.source)}</span>` +
        `<span class="sp"></span>${acts}` +
        `<div class="url" data-act="copy" data-kind="${kind}" data-i="${i}" title="点击复制">${esc(shortUrl(it.url))}</div>` +
        `</div>`
      );
    };

    const paint = (el, items, kind, empty) => {
      if (!items.length) {
        el.innerHTML = `<div class="empty">${esc(empty)}</div>`;
        return 0;
      }
      el.innerHTML = items.map((it, i) => rowHtml(it, i, kind)).join("");
      const n = el.querySelectorAll("button").length;
      if (n < items.length * 3) {
        el.textContent = items.map((it) => `${it.type}  ${it.url}`).join("\n");
        log(`⚠ 渲染自检未通过（${items.length} 条 / ${n} 按钮），已退化为纯文本`);
      }
      return n;
    };

    const render = () => {
      $("ls2-count").textContent = state.candidates.length ? `${state.candidates.length} 条` : "";
      paint(listEl, state.candidates, "cand", "页面上没有现成直链。点「jmuse 探测」，或先点站点自己的 Download。");
      const tips = [];
      if (!state.candidates.some((c) => NATIVE.has(c.type))) tips.push("当前只有音频/图片：mscz 需要点站点自己的 Download 再回来取。");
      if (tips.length) listEl.insertAdjacentHTML("beforeend", `<div class="hint">${esc(tips.join(" "))}</div>`);
    };
    ui.render = render;

    const renderCaptured = () => {
      $("ls2-capcount").textContent = state.captured.length ? `${state.captured.length} 条` : "";
      if (state.captured.length) $("ls2-tab-capture").open = true;
      paint(capEl, state.captured, "cap", "空。点站点 Download 后这里会出现。");
    };
    ui.renderCaptured = renderCaptured;

    /* ------------------------------------------------------ 交互 */
    const arrOf = (kind) => (kind === "cap" ? state.captured : state.candidates);

    async function onClick(e) {
      const el = e.target.closest?.("[data-act]");
      if (!el) return;
      const act = el.dataset.act;
      if (act === "copy") {
        const it = arrOf(el.dataset.kind)[Number(el.dataset.i)];
        if (!it) return;
        try {
          await navigator.clipboard.writeText(it.url);
          log(`已复制：${it.url}`);
        } catch {
          log(it.url);
        }
        return;
      }
      const it = arrOf(el.dataset.kind)?.[Number(el.dataset.i)];
      if (!it) return;
      const btn = el.tagName === "BUTTON" ? el : null;

      if (act === "take") return take(it, "save", btn);
      if (act === "app") return take(it, "app", btn);
      if (act === "open") {
        UW.open(it.url, "_blank");
        return log("已用浏览器打开；验证通过后文件进入「下载」文件夹，本地 App 会自动导入");
      }
      if (act === "expand") {
        const extra = expandTypes(it.url);
        if (!extra.length) return log("这条 URL 没有可复用的 h");
        state.candidates = dedupe([...state.candidates, ...extra]);
        render();
        return log(`已按同一 h 展开 ${extra.length} 种格式`);
      }
    }
    panel.addEventListener("click", onClick);

    const rescan = () => {
      const s = sources();
      const keep = state.candidates.filter((c) => c.source === "jmuse" || c.source === "same-h");
      state.candidates = dedupe([...s.store, ...s.html, ...s.dom, ...keep]);
      render();
      log(`扫描：store ${s.store.length} · html ${s.html.length} · dom ${s.dom.length} → ${state.candidates.length} 条`);
    };

    $("ls2-rescan").addEventListener("click", rescan);

    $("ls2-get").addEventListener("click", async () => {
      if (!state.candidates.length) rescan();
      const target = state.candidates.find((c) => NATIVE.has(c.type)) || state.candidates[0];
      if (!target) return log("没有可用直链：先点站点自己的 Download，或把地址粘到「粘贴下载地址」");
      await take(target, "app", null);
    });

    $("ls2-save").addEventListener("click", async () => {
      if (!state.candidates.length) rescan();
      const target = state.candidates.find((c) => NATIVE.has(c.type)) || state.candidates[0];
      if (!target) return log("没有可用直链");
      await take(target, "save", null);
    });

    $("ls2-jmuse").addEventListener("click", async (e) => {
      e.target.disabled = true;
      log("jmuse 探测中…");
      const found = await probeJmuse((l) => log("  " + l));
      if (found.length) {
        state.candidates = dedupe([...state.candidates, ...found]);
        render();
      }
      log(`jmuse：${found.length} 个类型给出地址`);
      e.target.disabled = false;
    });

    $("ls2-why").addEventListener("click", () => {
      const d = UW.UGAPP?.store?.page?.data ?? {};
      const s = d.score ?? {};
      const show = (o, ks) => ks.filter((k) => k in o).map((k) => `${k}=${JSON.stringify(o[k])}`).join("  ");
      const official = !!(s.is_official || d.official_score);
      const free = s.is_free === true || s.is_free === 1;
      const access = s.hasAccess === true || s.has_access === true;
      const limited = d.is_download_limited ?? s.is_download_limited;
      const verdict = [];
      if (official) verdict.push("官方/授权谱面：mscz 需要 Pro 或购买");
      if (!free && !access) verdict.push("作者未开放免费下载（is_free=false 且无 access）");
      if (limited) verdict.push("下载被限流（is_download_limited）");
      if (!state.candidates.some((c) => c.type === "mscz")) verdict.push("页面里没有 mscz 直链");
      if (!verdict.length) verdict.push("未读到明确限制字段");
      log(
        [
          "为什么下不了：",
          "  " + show(s, ["id", "is_free", "is_official", "is_pdf", "hasAccess", "is_download_limited", "limit_download_count", "download_count"]),
          "  " + show(d, ["paywall", "billing", "copies_purchased", "as_pro", "is_banned_user", "score_blocked_by_country"]),
          "  → " + verdict.join("；"),
        ].join("\n")
      );
    });

    $("ls2-diag").addEventListener("click", async () => {
      const diag = {
        version: VERSION,
        href: location.href,
        scoreId: scoreId(),
        title: scoreTitle(),
        candidates: state.candidates.map((c) => `${c.type}\t${c.source}\t${c.url}`),
        captured: state.captured.map((c) => `${c.type}\t${c.source}\t${c.url}`),
        jmuse: state.jmuse,
        hooks: UW.__lsHooks || null,
        salt: state.salt,
        buttons: listEl.querySelectorAll("button").length,
        app: APP,
      };
      const text = JSON.stringify(diag, null, 1);
      try {
        await navigator.clipboard.writeText(text);
        log("诊断已复制到剪贴板");
      } catch {
        log(text);
      }
    });

    $("ls2-pastego").addEventListener("click", async (e) => {
      const raw = $("ls2-paste").value.trim();
      if (!raw) return log("先粘贴一条 URL");
      e.target.disabled = true;
      try {
        await take({ type: typeOfUrl(raw), url: raw, source: "paste" }, "app", e.target);
      } finally {
        e.target.disabled = false;
      }
    });

    $("ls2-copyall").addEventListener("click", async () => {
      const text = [...state.candidates, ...state.captured].map((c) => `${c.type}\t${c.url}`).join("\n");
      try {
        await navigator.clipboard.writeText(text);
        log("全部链接已复制");
      } catch {
        log(text);
      }
    });

    $("ls2-capclear").addEventListener("click", () => {
      state.captured = [];
      renderCaptured();
      log("已清空捕获");
    });

    /* 折叠 / 拖动 / 记住位置 */
    $("ls2-collapse").addEventListener("click", () => {
      const collapsed = panel.classList.toggle("collapsed");
      localStorage.setItem(LS.collapsed, collapsed ? "1" : "0");
    });
    if (localStorage.getItem(LS.collapsed) === "1") panel.classList.add("collapsed");

    (() => {
      const saved = JSON.parse(localStorage.getItem(LS.offset) || "null");
      if (saved) {
        panel.style.right = "auto";
        panel.style.bottom = "auto";
        panel.style.left = saved.x + "px";
        panel.style.top = saved.y + "px";
      }
      let drag = null;
      const head = $("ls2-head");
      head.addEventListener("mousedown", (e) => {
        if (e.target.closest("button")) return;
        const r = panel.getBoundingClientRect();
        drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
        panel.style.right = "auto";
        panel.style.bottom = "auto";
        panel.style.left = r.left + "px";
        panel.style.top = r.top + "px";
        e.preventDefault();
      });
      document.addEventListener("mousemove", (e) => {
        if (!drag) return;
        const x = Math.max(4, Math.min(window.innerWidth - 120, e.clientX - drag.dx));
        const y = Math.max(4, Math.min(window.innerHeight - 60, e.clientY - drag.dy));
        panel.style.left = x + "px";
        panel.style.top = y + "px";
      });
      document.addEventListener("mouseup", () => {
        if (!drag) return;
        drag = null;
        const r = panel.getBoundingClientRect();
        localStorage.setItem(LS.offset, JSON.stringify({ x: r.left, y: r.top }));
      });
    })();

    /* 本地 App 状态 */
    const probeApp = async () => {
      try {
        const r = await fetch(`${APP}/api/health`, { signal: AbortSignal.timeout(2500) });
        const j = await r.json();
        state.appOnline = !!j.ok;
        $("ls2-dot").className = "dot " + (j.ok ? "on" : "off");
        $("ls2-dot").title = j.ok ? `本地 App 已连接（${j.formats?.length || 0} 种格式）` : "本地 App 未连接";
      } catch {
        state.appOnline = false;
        $("ls2-dot").className = "dot off";
        $("ls2-dot").title = `本地 App 未连接（${APP}）——「→ App」会失败，可用「直接下载」`;
      }
    };

    /* 元信息 */
    $("ls2-title").textContent = scoreTitle();
    $("ls2-id").textContent = scoreId() ? "#" + scoreId() : "";
    $("ls2-title").title = scoreTitle();

    renderCaptured();
    rescan();
    probeApp();
    setInterval(probeApp, 15000);
    log(`LibreScore v${VERSION} 就绪 · scoreId=${scoreId() ?? "非乐谱页"}`);
    log(`本地 App：${APP}`);

    setTimeout(() => {
      if (!state.candidates.length) log("页面上没有直链，可点「jmuse 探测」或先点站点自己的 Download。");
    }, 1200);

    installHooks();
    setTimeout(installHooks, 1500);
    setTimeout(installHooks, 4000);
  }

  /* --------------------------------------------------------- 8. 启动 */
  try {
    UW.document.addEventListener(
      "click",
      (e) => {
        const a = e.target && e.target.closest && e.target.closest("a[href]");
        if (a) recordDownload(a.getAttribute("href") || a.href, "click:a");
      },
      true
    );
  } catch {}
  installHooks();
  setTimeout(installHooks, 1500);
  setTimeout(installHooks, 4000);

  try {
    if (typeof GM_registerMenuCommand === "function") {
      GM_registerMenuCommand("LibreScore：取回 MSCZ 并发送到本地 App", async () => {
        const s = sources();
        const target = dedupe([...s.store, ...s.html, ...s.dom]).find((c) => NATIVE.has(c.type));
        if (!target) return alert("没有找到 mscz 直链：请先在页面上点站点自己的 Download。");
        try {
          const bytes = await fetchBytes(target.url);
          const res = await postToApp(bytes, target.type);
          alert(`已发送 ${target.type}（${kb(bytes.length)}）→ ref=${res.ref}\n去 ${APP} 勾格式转换。`);
        } catch (e) {
          alert(`失败：${e.message}\n将用浏览器打开该地址，下载后本地 App 会自动导入。`);
          UW.open(target.url, "_blank");
        }
      });
    }
  } catch {}

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();

  /* -------------------------------------------------------------- md5 */
  function md5hex(str) {
    function safeAdd(x, y) {
      const l = (x & 0xffff) + (y & 0xffff);
      return (((x >> 16) + (y >> 16) + (l >> 16)) << 16) | (l & 0xffff);
    }
    const rol = (n, c) => (n << c) | (n >>> (32 - c));
    const cmn = (q, a, b, x, s, t) => safeAdd(rol(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b);
    const F = (a, b, c, d, x, s, t) => cmn((b & c) | (~b & d), a, b, x, s, t);
    const G = (a, b, c, d, x, s, t) => cmn((b & d) | (c & ~d), a, b, x, s, t);
    const H = (a, b, c, d, x, s, t) => cmn(b ^ c ^ d, a, b, x, s, t);
    const I = (a, b, c, d, x, s, t) => cmn(c ^ (b | ~d), a, b, x, s, t);
    const bytes = new TextEncoder().encode(str);
    const n = bytes.length;
    const words = new Int32Array((((n + 8) >> 6) + 1) * 16);
    for (let i = 0; i < n; i++) words[i >> 2] |= bytes[i] << ((i % 4) * 8);
    words[n >> 2] |= 0x80 << ((n % 4) * 8);
    words[words.length - 2] = n * 8;
    let a = 1732584193,
      b = -271733879,
      c = -1732584194,
      d = 271733878;
    for (let i = 0; i < words.length; i += 16) {
      const oa = a,
        ob = b,
        oc = c,
        od = d;
      a = F(a, b, c, d, words[i], 7, -680876936);
      d = F(d, a, b, c, words[i + 1], 12, -389564586);
      c = F(c, d, a, b, words[i + 2], 17, 606105819);
      b = F(b, c, d, a, words[i + 3], 22, -1044525330);
      a = F(a, b, c, d, words[i + 4], 7, -176418897);
      d = F(d, a, b, c, words[i + 5], 12, 1200080426);
      c = F(c, d, a, b, words[i + 6], 17, -1473231341);
      b = F(b, c, d, a, words[i + 7], 22, -45705983);
      a = F(a, b, c, d, words[i + 8], 7, 1770035416);
      d = F(d, a, b, c, words[i + 9], 12, -1958414417);
      c = F(c, d, a, b, words[i + 10], 17, -42063);
      b = F(b, c, d, a, words[i + 11], 22, -1990404162);
      a = F(a, b, c, d, words[i + 12], 7, 1804603682);
      d = F(d, a, b, c, words[i + 13], 12, -40341101);
      c = F(c, d, a, b, words[i + 14], 17, -1502002290);
      b = F(b, c, d, a, words[i + 15], 22, 1236535329);
      a = G(a, b, c, d, words[i + 1], 5, -165796510);
      d = G(d, a, b, c, words[i + 6], 9, -1069501632);
      c = G(c, d, a, b, words[i + 11], 14, 643717713);
      b = G(b, c, d, a, words[i], 20, -373897302);
      a = G(a, b, c, d, words[i + 5], 5, -701558691);
      d = G(d, a, b, c, words[i + 10], 9, 38016083);
      c = G(c, d, a, b, words[i + 15], 14, -660478335);
      b = G(b, c, d, a, words[i + 4], 20, -405537848);
      a = G(a, b, c, d, words[i + 9], 5, 568446438);
      d = G(d, a, b, c, words[i + 14], 9, -1019803690);
      c = G(c, d, a, b, words[i + 3], 14, -187363961);
      b = G(b, c, d, a, words[i + 8], 20, 1163531501);
      a = G(a, b, c, d, words[i + 13], 5, -1444681467);
      d = G(d, a, b, c, words[i + 2], 9, -51403784);
      c = G(c, d, a, b, words[i + 7], 14, 1735328473);
      b = G(b, c, d, a, words[i + 12], 20, -1926607734);
      a = H(a, b, c, d, words[i + 5], 4, -378558);
      d = H(d, a, b, c, words[i + 8], 11, -2022574463);
      c = H(c, d, a, b, words[i + 11], 16, 1839030562);
      b = H(b, c, d, a, words[i + 14], 23, -35309556);
      a = H(a, b, c, d, words[i + 1], 4, -1530992060);
      d = H(d, a, b, c, words[i + 4], 11, 1272893353);
      c = H(c, d, a, b, words[i + 7], 16, -155497632);
      b = H(b, c, d, a, words[i + 10], 23, -1094730640);
      a = H(a, b, c, d, words[i + 13], 4, 681279174);
      d = H(d, a, b, c, words[i], 11, -358537222);
      c = H(c, d, a, b, words[i + 3], 16, -722521979);
      b = H(b, c, d, a, words[i + 6], 23, 76029189);
      a = H(a, b, c, d, words[i + 9], 4, -640364487);
      d = H(d, a, b, c, words[i + 12], 11, -421815835);
      c = H(c, d, a, b, words[i + 15], 16, 530742520);
      b = H(b, c, d, a, words[i + 2], 23, -995338651);
      a = I(a, b, c, d, words[i], 6, -198630844);
      d = I(d, a, b, c, words[i + 7], 10, 1126891415);
      c = I(c, d, a, b, words[i + 14], 15, -1416354905);
      b = I(b, c, d, a, words[i + 5], 21, -57434055);
      a = I(a, b, c, d, words[i + 12], 6, 1700485571);
      d = I(d, a, b, c, words[i + 3], 10, -1894986606);
      c = I(c, d, a, b, words[i + 10], 15, -1051523);
      b = I(b, c, d, a, words[i + 1], 21, -2054922799);
      a = I(a, b, c, d, words[i + 8], 6, 1873313359);
      d = I(d, a, b, c, words[i + 15], 10, -30611744);
      c = I(c, d, a, b, words[i + 6], 15, -1560198380);
      b = I(b, c, d, a, words[i + 13], 21, 1309151649);
      a = I(a, b, c, d, words[i + 4], 6, -145523070);
      d = I(d, a, b, c, words[i + 11], 10, -1120210379);
      c = I(c, d, a, b, words[i + 2], 15, 718787259);
      b = I(b, c, d, a, words[i + 9], 21, -343485551);
      a = safeAdd(a, oa);
      b = safeAdd(b, ob);
      c = safeAdd(c, oc);
      d = safeAdd(d, od);
    }
    const hex = (n) => {
      let s = "";
      for (let i = 0; i < 4; i++) s += ("0" + ((n >> (i * 8)) & 0xff).toString(16)).slice(-2);
      return s;
    };
    return hex(a) + hex(b) + hex(c) + hex(d);
  }
})();
