// Provider B — the official-app API that LibreScore's closed-source desktop app talks to.
//
// Recovered from its Flutter AOT snapshot (app.so v6.0.23) as string evidence:
//   https://api.musescore.com/v2/score/file?ssid=
//   https://api.musescore.com/v2/score/info?f=
//   https://api.musescore.com/v2/score/search?text= / ?device_id=
//   headers: x-ms-api-key , x-ms-client-id
//   embedded client JWT (role=client, version=v6.0.22)
//   https://librescore.ddns.net:5433/api/rpc/get_t  (token broker)
//   https://librescore.ddns.net:5433/api/rpc/get_s?ssid=  (per-score helper)
//
// Live server behaviour probed from this machine:
//   GET /v2/score/info?ssid=1234            -> 400 "Missing required api parameter: \"getClientId\"."
//   ... + header x-ms-client-id: <any>      -> 400 "Invalid client name"
//   ... + ?token=<anything>                 -> 401 Unauthorized   (so `token` is the auth query param)
//   GET /v2/score/file?ssid=1234            -> 400 "missing key in the query string"
//
// So this provider needs a live client token. It can be supplied via LS_TOKEN,
// fetched from the LibreScore token broker, or pasted from the user's own app session.
import crypto from "node:crypto";
import https from "node:https";
import dns from "node:dns/promises";

const UA = "Dart/3.9 (dart:io)";
export const API = "https://api.musescore.com";
export const RPC_HOST = "librescore.ddns.net";
export const RPC_PORT = 5433;
export const EMBEDDED_JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiY2xpZW50IiwidmVyc2lvbiI6InY2LjAuMjIifQ.uzs55YOshs7FIINFMBMTPeTzwpU9E4r4M0hCwcKudxw";

/** Resolve a hostname through public DoH, so local fake-IP proxies can be bypassed. */
export async function resolveReal(host) {
  const urls = [
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`,
    `https://dns.google/resolve?name=${encodeURIComponent(host)}&type=A`,
  ];
  for (const u of urls) {
    try {
      const r = await fetch(u, { headers: { accept: "application/dns-json" } });
      const j = await r.json();
      const ips = (j.Answer || []).filter((a) => a.type === 1).map((a) => a.data);
      if (ips.length) return ips;
    } catch {}
  }
  return [];
}

/** HTTPS request pinned to an IP (keeps SNI + cert validation against the host name). */
export function httpsPinned({ host, ip, port = 443, path: p, method = "GET", headers = {}, body = null, timeout = 15000 }) {
  return new Promise((resolve) => {
    const req = https.request(
      {
        host: ip,
        port,
        path: p,
        method,
        servername: host,
        ALPNProtocols: ["http/1.1"],
        headers: { host: port === 443 ? host : `${host}:${port}`, "user-agent": UA, accept: "*/*", ...headers },
        timeout,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          resolve({ status: res.statusCode, headers: res.headers, buf, text: buf.toString("utf8") });
        });
      }
    );
    req.on("error", (e) => resolve({ status: 0, error: e.message, text: "", buf: Buffer.alloc(0) }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, error: "timeout", text: "", buf: Buffer.alloc(0) });
    });
    if (body) req.write(body);
    req.end();
  });
}

async function apiGet(pathname, { token, headers = {}, timeout = 20000 } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  try {
    const r = await fetch(API + pathname, {
      headers: {
        "user-agent": UA,
        accept: "application/json, */*",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      signal: ac.signal,
    });
    const buf = Buffer.from(await r.arrayBuffer());
    return { ok: r.ok, status: r.status, buf, text: buf.toString("utf8") };
  } catch (e) {
    return { ok: false, status: 0, buf: Buffer.alloc(0), text: "", error: e.message };
  } finally {
    clearTimeout(t);
  }
}

/** Ask the LibreScore token broker for a fresh client token. */
export async function fetchBrokerToken({ host = RPC_HOST, port = RPC_PORT } = {}) {
  const ips = await resolveReal(host);
  const attempts = [];
  for (const ip of ips.slice(0, 2)) {
    for (const p of ["/api/rpc/get_t", "/api/q", "/api/p"]) {
      const r = await httpsPinned({ host, ip, port, path: p });
      attempts.push({ ip, path: p, status: r.status, error: r.error, sample: r.text.slice(0, 160) });
      if (r.status === 200 && r.text) {
        let json = null;
        try {
          json = JSON.parse(r.text);
        } catch {}
        const tok =
          json?.token ||
          json?.t ||
          json?.data?.token ||
          (typeof json === "string" ? json : null) ||
          (r.text.length > 40 && !r.text.trim().startsWith("<") ? r.text.trim() : null);
        if (tok) return { ok: true, token: String(tok), ip, path: p, attempts };
      }
    }
  }
  return { ok: false, attempts, ips };
}

function collectKeyCandidates(obj, out = [], depth = 0) {
  if (!obj || depth > 4) return out;
  if (typeof obj === "string") return out;
  if (Array.isArray(obj)) {
    for (const v of obj.slice(0, 20)) collectKeyCandidates(v, out, depth + 1);
    return out;
  }
  if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      if (/key|token|hash|sig/i.test(k) && typeof v === "string" && v.length >= 4) out.push({ field: k, value: v });
      collectKeyCandidates(v, out, depth + 1);
    }
  }
  return out;
}

export async function scoreInfo(id, { token } = {}) {
  const variants = [
    `/v2/score/info?ssid=${id}`,
    `/v2/score/info?f=${id}`,
    `/v2/score/info?ssid=${id}&token=${encodeURIComponent(token || "")}`,
  ];
  const results = [];
  for (const v of variants) {
    const r = await apiGet(v, { token, headers: token ? {} : {} });
    let json = null;
    try {
      json = JSON.parse(r.text);
    } catch {}
    results.push({ path: v, status: r.status, body: json ?? r.text.slice(0, 200), error: r.error });
    if (r.ok && json) return { ok: true, data: json, path: v, keyCandidates: collectKeyCandidates(json), results };
  }
  return { ok: false, results };
}

const FILE_TYPES = ["mscz", "mscx", "mxl", "musicxml", "xml", "pdf", "mid", "mp3"];

export async function scoreFile(id, t, { token, key } = {}) {
  const qs = new URLSearchParams({ ssid: String(id) });
  if (key) qs.set("key", key);
  qs.set("t", t);
  if (token) qs.set("token", token);
  const r = await apiGet(`/v2/score/file?${qs.toString()}`, { token });
  const isJson = (r.headers?.["content-type"] || "").includes("json") || r.buf.subarray(0, 1).toString() === "{";
  return {
    ok: r.ok && !isJson,
    status: r.status,
    buf: r.buf,
    text: isJson ? r.text.slice(0, 300) : `<binary ${r.buf.length} bytes>`,
    contentType: r.headers?.["content-type"],
  };
}

/**
 * Try everything this provider can do for one score and report a full matrix.
 * Returns the first successful payload plus the attempt log.
 */
export async function acquireViaOfficial(id, { token, label = "" } = {}) {
  const attempts = [];
  if (!token) {
    const broker = await fetchBrokerToken();
    attempts.push({ step: "broker get_t", ok: broker.ok, detail: broker.ok ? `token ${broker.token.slice(0, 18)}…` : broker.attempts?.slice(0, 3) });
    if (broker.ok) token = broker.token;
  } else {
    attempts.push({ step: "token", ok: true, detail: `supplied (${label || "manual"})` });
  }
  if (!token) return { ok: false, attempts, reason: "没有可用的 client token（设置 LS_TOKEN，或让 LibreScore 客户端运行以便取到 broker token）" };

  const info = await scoreInfo(id, { token });
  attempts.push({ step: "score/info", ok: info.ok, detail: info.ok ? info.path : info.results?.map((r) => `${r.path} -> ${r.status}`).join(" | ") });
  const keyCandidates = info.keyCandidates?.map((c) => c.value) ?? [];

  for (const t of FILE_TYPES) {
    const keys = keyCandidates.length ? keyCandidates : [undefined];
    for (const key of keys) {
      const r = await scoreFile(id, t, { token, key });
      attempts.push({ step: `file t=${t} key=${key ? key.slice(0, 10) + "…" : "(none)"}`, ok: r.ok, detail: `${r.status} ${String(r.text).slice(0, 120)}` });
      if (r.ok && r.buf.length > 128) {
        return { ok: true, bytes: r.buf, format: t, contentType: r.contentType, attempts };
      }
    }
  }
  return { ok: false, attempts, reason: "官方 API 所有组合都没返回文件（token 可能已过期 / 该谱面不支持）" };
}
