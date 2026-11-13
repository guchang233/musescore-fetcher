// Provider A — musescore.com public web endpoint `/api/jmuse`.
// Verified contract (from LibreScore's open-source dl-librescore):
//   GET /api/jmuse?id=<id>&type=<img|mp3|midi>&index=<n>   header: Authorization: md5(id+type+index+salt)[0..4]
// The salt is a literal scraped from the site build JS (`"...").substr(0,4)`), with a known fallback.
import crypto from "node:crypto";
import { smartFetch } from "../fetcher.mjs";
import fs from "node:fs";
import path from "node:path";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.2535.85";
export const FALLBACK_SALT = "9654,4e";
const BASE = process.env.MUSESCORE_BASE || "https://musescore.com";

const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");

const CACHE_DIR = path.join(process.cwd(), ".cache");
const CACHE_FILE = path.join(CACHE_DIR, `salt-${crypto.createHash("md5").update(process.env.MUSESCORE_BASE || "https://musescore.com").digest("hex").slice(0, 8)}.json`);
const SALT_TTL_MS = 6 * 60 * 60 * 1000;

function readCache() {
  try {
    const j = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    if (j && j.salt && Date.now() - j.at < SALT_TTL_MS) return j.salt;
  } catch {}
  return null;
}
function writeCache(salt) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ salt, at: Date.now() }));
  } catch {}
}

let memSalt = readCache();

async function get(url, { cookie = "", timeout = 20000, headers = {} } = {}) {
  const full = url.startsWith("http") ? url : BASE + url;
  const r = await smartFetch(full, { cookie, headers, timeout: Math.max(5, Math.round(timeout / 1000)), follow: true });
  return { ok: r.status >= 200 && r.status < 300, status: r.status, buf: r.buf, text: r.text, headers: r.headers, via: r.via, cf: r.cf };
}
/** Scrape the per-build salt from musescore.com asset bundles. */
export async function discoverSalt({ scoreUrl = "", cookie = "" } = {}) {
  if (memSalt) return { salt: memSalt, cached: true };
  const bundles = [];
  const htmlUrl = scoreUrl || BASE + "/sheetmusic";
  try {
    const page = await get(htmlUrl, { cookie });
    for (const m of page.text.matchAll(
      /link.+?href=["']((?:https?:\/\/[^"']+)?\/static\/public\/build\/musescore.*?(?:_es6)?\/20.+?\.js)["']/g
    )) {
      bundles.push(m[1]);
    }
  } catch (e) {
    return { salt: FALLBACK_SALT, cached: false, error: `页面抓取失败: ${e.message}` };
  }
  for (const url of bundles.slice(0, 6)) {
    try {
      const js = await get(url, { cookie });
      const m = js.text.match(/"([^"]+)"\)\.substr\(0,4\)/);
      if (m) {
        memSalt = m[1];
        writeCache(memSalt);
        return { salt: memSalt, cached: false, from: url };
      }
    } catch {}
  }
  return { salt: memSalt || FALLBACK_SALT, cached: !!memSalt, error: bundles.length ? "构建包中没有匹配到 salt" : "页面里没有构建包链接" };
}

export function jmuseAuth(id, type, index = 0, salt = FALLBACK_SALT) {
  return md5(`${id}${type}${index}${salt}`).slice(0, 4);
}

/** Resolve one jmuse file URL. Returns {ok, url, status, body}. */
export async function jmuseResolve(id, type, index = 0, { salt, cookie = "" } = {}) {
  const useSalt = salt ?? memSalt ?? FALLBACK_SALT;
  const auth = jmuseAuth(id, type, index, useSalt);
  const r = await get(`/api/jmuse?id=${id}&type=${type}&index=${index}`, {
    cookie,
    headers: { authorization: auth, accept: "application/json" },
  });
  let json = null;
  try {
    json = JSON.parse(r.text);
  } catch {}
  const url = json?.info?.url ?? null;
  return { ok: r.ok && !!url, status: r.status, url, body: json, auth, salt: useSalt };
}

/** Download bytes from a resolved CDN url. */
export async function download(url, { cookie = "", timeout = 120000 } = {}) {
  const r = await get(url, { cookie, timeout });
  if (!r.ok) {
    const err = new Error(`下载失败 HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return r.buf;
}

/** Try a type and report why it failed. */
export async function tryType(id, type, { salt, cookie = "", index = 0 } = {}) {
  try {
    const res = await jmuseResolve(id, type, index, { salt, cookie });
    if (!res.ok) {
      return { type, ok: false, status: res.status, message: res.body?.message || res.body?.error || "no url" };
    }
    return { type, ok: true, status: res.status, url: res.url };
  } catch (e) {
    return { type, ok: false, status: 0, message: e.message };
  }
}

export const WEB_TYPES = ["img", "mp3", "midi"];
export const PROBE_TYPES = ["mscz", "mscx", "mxl", "musicxml", "pdf", "mid", "midi", "mp3", "img", "xml", "json"];
