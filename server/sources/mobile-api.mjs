// Provider C — MuseScore 官方移动端 API（`api.musescore.com/v2`）。
//
// 鉴权方式是从 com.musescore.playerlite 2.14.55（RN 应用，Metro packager.map
// 带 sourcesContent，5573 个原始 TS 模块全量还原）里逐行还原出来的：
//
//   X-MS-CLIENT-ID = 任意字符串（原版取 ANDROID_ID 左补 0 到 16 位）
//   X-MS-API-KEY   = md5_hex(clientId + "renderTime" + "YYYY-MM-DD:H")
//                    · 盐 "renderTime" 来自 NativeMd5Module.SALT
//                    · UTC 月/日补零，UTC 小时**不补零**，年取本地
//                    · 时间戳必须用服务端时间（GET /v2/common/hello 的 timestamp，秒）
//   498 = key 与服务器时间不匹配 → 重取 /common/hello 再试
//
// 实测（本机，随时可复现）：
//   GET /v2/score/search?text=adele&v=1.4           → 200 + 20 条真实结果
//   GET /v2/common/hello                            → 200 + 服务器时间
//   GET /v2/score/info?id=…&usage=online&v=1.4      → 422 device.attestation_failed
//   GET /v2/score/download?score_id=…&v=1.1         → 422 Attestation token is required
// 也就是说：搜索/元数据可用；**取文件被 Google Play Integrity 锁死**（f 参数不可离线伪造），
// 所以 MSCZ 的正路是站点 SSR 里的 type_download_list（见 userscript）。
import crypto from "node:crypto";

const BASE = process.env.MS_BASE || "https://api.musescore.com/v2";
const SALT = "renderTime";
const CLIENT_ID = process.env.MS_CLIENT_ID || "librescoreapp001";
const APP_VERSION = "2.14.55";
const APP_BUILD = "2701770";
const UA = `MS_ANDROID/${APP_VERSION}.${APP_BUILD} (Pixel 7; Android 14)`;

const pad2 = (n) => String(n).padStart(2, "0");

/** "YYYY-MM-DD:H"（UTC 月/日补零，UTC 小时不补零，年取本地） */
export function timeString(ms = Date.now()) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}:${d.getUTCHours()}`;
}

export function apiKey(ms = Date.now(), clientId = CLIENT_ID) {
  return crypto.createHash("md5").update(clientId + SALT + timeString(ms), "utf8").digest("hex");
}

export function headers(serverMs = Date.now(), clientId = CLIENT_ID) {
  return {
    accept: "application/json",
    "accept-language": "en-US",
    "x-ms-client-id": clientId,
    "x-ms-api-key": apiKey(serverMs, clientId),
    "x-mu-platform": "2",
    "x-ms-api-ver": "1",
    "user-agent": UA, // 必需：去掉 → 400 (missing client-id semantics)
  };
}

let cachedServerMs = 0;

export async function serverTime() {
  try {
    const r = await fetch(`${BASE}/common/hello`, { headers: headers(Date.now()), signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    if (j?.timestamp) return j.timestamp * 1000;
  } catch {}
  return Date.now();
}

/** 发一个 API 请求；498（时间漂移）自动校时重试一次。 */
export async function api(pathAndQuery, { retryOn498 = true, timeout = 15000 } = {}) {
  if (!cachedServerMs) cachedServerMs = await serverTime();
  const doFetch = (ms) =>
    fetch(`${BASE}${pathAndQuery}`, { headers: headers(ms), redirect: "follow", signal: AbortSignal.timeout(timeout) });

  let res = await doFetch(cachedServerMs).catch((e) => ({ status: 0, _err: e.message }));
  if (res.status === 0) return { status: 0, body: { error: res._err } };
  if (res.status === 498 && retryOn498) {
    cachedServerMs = await serverTime();
    res = await doFetch(cachedServerMs);
  }
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

/** 搜索谱面（无需登录、无需 Play Integrity）。 */
export async function search(query, { limit = 20 } = {}) {
  const { status, body } = await api(`/score/search?text=${encodeURIComponent(query)}&v=1.4`);
  const scores = Array.isArray(body?.scores) ? body.scores : [];
  return {
    status,
    ok: status === 200,
    results: scores.slice(0, limit).map((s) => ({
      id: s.id,
      title: s.title,
      composer: s.composer_name || null,
      pages: s.pages_count ?? null,
      isFree: !!s.is_free,
      isDownloadable: !!s.is_downloadable,
      isOfficial: !!s.is_official,
      artist: s.artist_name || null,
      url: s.id ? `https://musescore.com/score/${s.id}` : null,
      thumbHash: (String(s.thumbnails?.small || "").match(/scoredata\/g\/([0-9a-f]{40})\//) || [])[1] || null,
      thumb: s.thumbnails?.medium || s.thumbnails?.small || null,
    })),
    raw: status === 200 ? undefined : body,
  };
}

/** 谱面详情：会被 Play Integrity 拦住（422），保留以便诊断/未来可用。 */
export async function scoreInfo(id) {
  const { status, body } = await api(`/score/info?id=${id}&usage=online&v=1.4`);
  return {
    status,
    ok: status === 200,
    attested: status !== 422,
    message: body?.device?.attestation_failed || body?.message || (status === 422 ? "需要 Play Integrity 证明（f 参数）" : null),
    urls: body?.urls ?? null,
    body: status === 200 ? body : undefined,
  };
}
