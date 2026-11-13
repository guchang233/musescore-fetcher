import { smartFetch } from "./fetcher.mjs";

// Score URL parsing + page metadata scraping.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.2535.85";

export const SCORE_URL_RE =
  /^https?:\/\/(?:s|www\.)?musescore\.com\/(?:.*\/)?(?:scores|score)\/(\d+)/i;

export function parseScoreId(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (/^\d{3,}$/.test(s)) return Number(s);
  const m = s.match(SCORE_URL_RE);
  if (m) return Number(m[1]);
  // share links: ...?share=1234567 or /score/1234567?...
  const m2 = s.match(/[?&](?:ssid|share|id)=(\d{3,})/);
  return m2 ? Number(m2[1]) : null;
}

export function scoreUrl(id) {
  return `https://musescore.com/score/${id}`;
}

export async function fetchText(url, { cookie = process.env.MUSESCORE_COOKIE || "", timeout = 20000 } = {}) {
  const r = await smartFetch(url, { cookie, timeout: Math.max(5, Math.round(timeout / 1000)), follow: true });
  return { ok: r.status >= 200 && r.status < 300, status: r.status, text: r.text, url: r.finalUrl || url, headers: r.headers, via: r.via, cf: r.cf };
}
const decodeEntities = (s) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/g, "'");

export function extractPageMeta(html) {
  if (!html) return {};
  const meta = (prop) => {
    const m =
      html.match(new RegExp(`<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']*)["']`, "i")) ||
      html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${prop}["']`, "i"));
    return m ? decodeEntities(m[1]) : null;
  };
  const ogTitle = meta("og:title");
  const titleTag = html.match(/<title>([^<]*)<\/title>/i);
  const scoreJson = html.match(/"is_pdf"\s*:\s*(true|false)/);
  const pageCount =
    html.match(/"page_count"\s*:\s*(\d+)/) || html.match(/"pages"\s*:\s*(\d+)\b/);
  return {
    title: (ogTitle || (titleTag ? decodeEntities(titleTag[1]) : "")).replace(/\s*\|.*$/, "").trim() || null,
    author: meta("musescore:author") || null,
    description: meta("og:description") || meta("description") || null,
    thumbnail: meta("og:image") || null,
    isPdf: scoreJson ? scoreJson[1] === "true" : null,
    pageCount: pageCount ? Number(pageCount[1]) : null,
  };
}

export async function resolveScore(input, opts = {}) {
  const id = parseScoreId(input);
  if (!id) {
    const err = new Error("无法从输入中解析出乐谱 ID。支持 https://musescore.com/user/xxx/scores/123456 或 /score/123456");
    err.code = "BAD_URL";
    throw err;
  }
  const url = scoreUrl(id);
  const out = { id, url, title: null, author: null, pageCount: null, thumbnail: null, isPdf: null, fetched: false, note: null };
  try {
    const r = await fetchText(url, opts);
    if (r.ok) {
      Object.assign(out, extractPageMeta(r.text));
      out.fetched = true;
    } else if (r.status === 403) {
      out.note = "musescore.com 返回 403（Cloudflare 挑战）。标题等信息留空，文件获取走浏览器助手。";
    } else {
      out.note = `musescore.com 返回 ${r.status}`;
    }
  } catch (e) {
    out.note = `抓取页面失败：${e.message}`;
  }
  if (out.title) out.title = out.title.replace(/\s*-\s*MuseScore.*$/i, "").trim();
  return out;
}
