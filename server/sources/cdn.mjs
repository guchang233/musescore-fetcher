// Provider D — cdn.ustatik.com (MuseScore's asset CDN, *not* behind Cloudflare).
//
// Verified live from this host:
//   GET https://cdn.ustatik.com/musescore/scoredata/g/<40-hex>/score_0.png@0   -> 200, real PNG
//   GET https://cdn.ustatik.com/musescore/scoredata/g/<40-hex>/score_0.svg     -> 200, real SVG
// The <40-hex> is the render hash that the score's metadata carries
// (`thumbnails.small` in the mobile API). Only page 1 is pre-rendered publicly;
// pages 2+ are generated on demand behind /api/jmuse (Cloudflare).
//
// This gives a Cloudflare-free way to (a) confirm a score exists and (b) fetch a real
// page-1 render, which is useful for previews and for single-page PDFs.
import { smartFetch } from "../fetcher.mjs";

export const CDN = "https://cdn.ustatik.com/musescore/scoredata/g";

export function thumbHashFrom(url) {
  const m = String(url || "").match(/scoredata\/g\/([0-9a-f]{40})\//);
  return m ? m[1] : null;
}

export async function pageRender(hash, { page = 0, format = "png", timeout = 40 } = {}) {
  if (!/^[0-9a-f]{40}$/.test(hash || "")) return { ok: false, message: "hash 不合法（需要 40 位十六进制）" };
  const url = `${CDN}/${hash}/score_${page}.${format === "svg" ? "svg" : "png@0"}`;
  const r = await smartFetch(url, { timeout });
  const ok = r.status === 200 && r.buf.length > 500;
  return {
    ok,
    status: r.status,
    bytes: r.buf,
    contentType: r.headers["content-type"] || "",
    url,
    message: ok ? null : `CDN 返回 ${r.status}（第 ${page + 1} 页可能还没被预渲染）`,
  };
}
