// Browser engine — 用你本机真实的 Chrome/Edge 取文件。
//
// 为什么需要它：musescore.com 挂在 Cloudflare 后面，纯 HTTP 客户端（Node/Python/curl）
// 会被 "Just a moment…" 挡住；而真实浏览器带着正常指纹 + 你的网络出口，验证基本自动通过，
// 页面里的 type_download_list 和文件本身都能拿到。这一步没法在服务器上伪造，只能借你的浏览器。
//
// 流程：启动浏览器（独立 profile，cf_clearance 可复用）→ 打开乐谱页 → 等 CF 验证通过
//      → 在页面上下文里解析 type_download_list → 用页面自己的 fetch 取字节（同源、跟随 302）
//      → base64 回传给 Node → 后续交给本地引擎转换。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PROFILE_DIR = path.join(process.cwd(), ".cache", "browser-profile");

const CANDIDATES = [
  process.env.BROWSER_PATH,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

export function findBrowser() {
  for (const p of CANDIDATES) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

let puppeteer = null;
async function loadPuppeteer() {
  if (!puppeteer) puppeteer = (await import("puppeteer-core")).default;
  return puppeteer;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs in the page: locate `type_download_list` in the SSR JSON blob. */
function pageParser() {
  const recover = (s) =>
    s
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&#x27;/gi, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");

  const balanced = (text, start) => {
    const opener = text[start];
    if (opener !== "{" && opener !== "[") return -1;
    const stack = [];
    let inStr = null;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === inStr) inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'") inStr = ch;
      else if (ch === "{" || ch === "[") stack.push(ch);
      else if (ch === "}" || ch === "]") {
        const open = stack.pop();
        if ((ch === "}" && open !== "{") || (ch === "]" && open !== "[")) return -1;
        if (stack.length === 0) return i + 1;
      }
    }
    return -1;
  };

  const findByKey = (decoded, key) => {
    const needle = `"${key}":`;
    let pos = 0;
    for (;;) {
      const at = decoded.indexOf(needle, pos);
      if (at < 0) return null;
      pos = at + needle.length;
      let p = pos;
      while (p < decoded.length && /\s/.test(decoded[p])) p++;
      if (decoded[p] === "[") {
        const end = balanced(decoded, p);
        if (end > 0) {
          try {
            const arr = JSON.parse(decoded.slice(p, end));
            if (Array.isArray(arr) && arr.length) return arr;
          } catch {}
        }
      }
    }
  };

  // 1) live store
  try {
    const out = [];
    const walk = (o, d) => {
      if (!o || d > 6 || typeof o !== "object") return;
      if (Array.isArray(o.type_download_list)) out.push(...o.type_download_list);
      for (const v of Object.values(o)) walk(v, d + 1);
    };
    walk(window.UGAPP?.store, 0);
    if (out.length) return { list: out, from: "store", title: window.UGAPP?.store?.page?.data?.score?.title ?? null };
  } catch {}

  // 2) SSR JSON blob in the markup
  const html = document.documentElement.outerHTML;
  const list = findByKey(recover(html), "type_download_list");
  let title = null;
  try {
    title = window.UGAPP?.store?.page?.data?.score?.title ?? null;
  } catch {}
  if (!title) {
    const m = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)/i) || html.match(/<title>([^<]*)</i);
    if (m) title = m[1];
  }
  return { list: list || [], from: list ? "html" : null, title };
}

async function waitForChallenge(page, { timeoutMs = 180000, onLog = () => {} } = {}) {
  const started = Date.now();
  let announced = false;
  while (Date.now() - started < timeoutMs) {
    const state = await page.evaluate(() => {
      const title = document.title || "";
      const body = (document.body && document.body.innerText || "").slice(0, 400);
      const blocked = /just a moment|verify you are human|请稍候|检查站点连接/i.test(title + " " + body);
      return { title, blocked, hasScore: !!document.querySelector("#jmuse-scroller-component, #ELEMENT_ID_SCORE_DOWNLOAD_SECTION, [data-testid]") || /musescore:author/.test(document.head.innerHTML) };
    });
    if (!state.blocked && state.hasScore) return { ok: true, waited: Date.now() - started };
    if (state.blocked && !announced) {
      onLog("浏览器里出现了 Cloudflare 验证，请在窗口里点一下（或等它自动过）。profile 会记住，下次不用再点。");
      announced = true;
    }
    await sleep(1200);
  }
  return { ok: false, waited: Date.now() - started };
}

/**
 * @param {{scoreUrl:string, want?:string[], headful?:boolean, timeoutMs?:number, onLog?:(s:string)=>void}} opts
 * @returns {Promise<{ok:boolean, title?:string, list?:Array<{type:string,url:string}>, files?:Array<{type:string,bytes:Buffer}>, message?:string}>}
 */
export async function browserFetch(opts) {
  const { scoreUrl, want = ["mscz"], headful = true, timeoutMs = 180000, onLog = () => {} } = opts || {};
  const exe = findBrowser();
  if (!exe) return { ok: false, message: "没找到 Chrome / Edge。用环境变量 BROWSER_PATH 指一个可执行文件。" };
  if (!scoreUrl || !/^https?:\/\//.test(scoreUrl)) return { ok: false, message: "scoreUrl 不合法" };

  const puppeteerLib = await loadPuppeteer();
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  onLog(`启动浏览器：${path.basename(exe)}（首次会打开窗口，验证一次之后 profile 会记住）`);
  const browser = await puppeteerLib.launch({
    executablePath: exe,
    headless: headful ? false : "new",
    userDataDir: PROFILE_DIR,
    defaultViewport: null,
    args: ["--no-first-run", "--no-default-browser-check", "--disable-blink-features=AutomationControlled"],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.2535.85"
    );
    onLog(`打开 ${scoreUrl}`);
    await page.goto(scoreUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});

    const state = await waitForChallenge(page, { timeoutMs, onLog });
    if (!state.ok) {
      return { ok: false, message: "Cloudflare 验证没通过（窗口里可能需要人点一下）。脚本没拿到页面内容。" };
    }
    onLog(`验证通过，用时 ${(state.waited / 1000).toFixed(1)}s`);

    const parsed = await page.evaluate(pageParser);
    if (!parsed?.list?.length) {
      return {
        ok: false,
        title: parsed?.title,
        message: "页面打开了，但没找到 type_download_list（该谱面可能禁止下载，或站点改版）。",
      };
    }
    onLog(`读到 ${parsed.list.length} 个直链：${parsed.list.map((x) => x.type).join(", ")}`);

    const files = [];
    for (const type of want) {
      const item = parsed.list.find((x) => x.type === type) || (type === "mid" ? parsed.list.find((x) => x.type === "midi") : null);
      if (!item) {
        onLog(`${type}: 页面没提供这个类型的直链，跳过`);
        continue;
      }
      onLog(`${type}: 抓取 ${String(item.url).slice(0, 80)}…`);
      const b64 = await page.evaluate(async (url) => {
        const r = await fetch(url, { credentials: "include", redirect: "follow" });
        if (!r.ok) return { error: `HTTP ${r.status}` };
        const buf = new Uint8Array(await r.arrayBuffer());
        let s = "";
        const chunk = 0x8000;
        for (let i = 0; i < buf.length; i += chunk) s += String.fromCharCode.apply(null, buf.subarray(i, i + chunk));
        return { b64: btoa(s), size: buf.length, finalUrl: r.url };
      }, item.url);

      if (b64?.error) {
        onLog(`${type}: 页面内 fetch 失败（${b64.error}），改用浏览器下载…`);
        continue;
      }
      files.push({ type, bytes: Buffer.from(b64.b64, "base64"), finalUrl: b64.finalUrl });
      onLog(`${type}: 拿到 ${(b64.size / 1024).toFixed(1)} KiB ✓`);
    }

    return {
      ok: files.length > 0,
      title: parsed.title,
      list: parsed.list,
      files,
      message: files.length ? null : "页面里没有任何格式能取到字节。",
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

/** Save bytes through the browser's own download stack (fallback when in-page fetch is blocked). */
export async function browserSaveDownload(scoreUrl, { timeoutMs = 180000, onLog = () => {} } = {}) {
  const exe = findBrowser();
  if (!exe) return { ok: false, message: "没找到浏览器" };
  const puppeteerLib = await loadPuppeteer();
  const browser = await puppeteerLib.launch({ executablePath: exe, headless: false, userDataDir: PROFILE_DIR, defaultViewport: null });
  try {
    const page = await browser.newPage();
    await page.goto(scoreUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await waitForChallenge(page, { timeoutMs, onLog });
    const parsed = await page.evaluate(pageParser);
    const item = parsed?.list?.find((x) => x.type === "mscz");
    if (!item) return { ok: false, message: "页面没提供 mscz 直链" };
    const dir = path.join(process.cwd(), "downloads");
    fs.mkdirSync(dir, { recursive: true });
    const client = await page.createCDPSession();
    await client.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: dir });
    await page.goto(item.url).catch(() => {});
    await sleep(8000);
    const newest = fs
      .readdirSync(dir)
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0];
    if (!newest) return { ok: false, message: "浏览器下载目录里没有新文件" };
    const p = path.join(dir, newest.f);
    return { ok: true, path: p, bytes: fs.readFileSync(p), name: newest.f };
  } finally {
    await browser.close().catch(() => {});
  }
}
