// Unified fetcher: curl_cffi (browser TLS fingerprint) first, Node fetch as fallback.
//
// Why: Cloudflare decides largely on the TLS/HTTP2 fingerprint. Node's fetch is a known bot
// shape, so musescore.com answers "Just a moment…" even from a residential IP. A real Chrome
// handshake (curl_cffi) plus the user's cookies is what makes the plain-HTTP path work.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";

const PY = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
const SCRIPT = path.join(process.cwd(), "tools", "fetch_curl.py");
const TMP = path.join(process.cwd(), ".cache", "fetch");
fs.mkdirSync(TMP, { recursive: true });

let pyState = null; // undefined=unknown, true=works, false=missing

export async function curlCffiAvailable() {
  if (pyState !== null) return pyState;
  pyState = await new Promise((resolve) => {
    execFile(PY, ["-c", "import curl_cffi,sys;print(curl_cffi.__version__)"], { timeout: 15000 }, (err, stdout) => {
      resolve(!err && /\d+\.\d+/.test(String(stdout)));
    });
  });
  return pyState;
}

function runPy(cfg) {
  return new Promise((resolve) => {
    execFile(PY, [SCRIPT, JSON.stringify(cfg)], { timeout: (cfg.timeout || 60) * 1000 + 5000, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      if (err && !stdout) return resolve({ ok: false, error: err.message + " " + String(stderr).slice(0, 200) });
      try {
        resolve(JSON.parse(String(stdout).trim().split("\n").pop()));
      } catch (e) {
        resolve({ ok: false, error: "bad bridge output: " + String(stdout).slice(0, 200) });
      }
    });
  });
}

/**
 * @returns {Promise<{status:number, buf:Buffer, text:string, headers:Record<string,string>, via:string, finalUrl?:string, cf?:boolean}>}
 */
export async function smartFetch(url, { cookie = "", headers = {}, follow = true, timeout = 60, impersonate = "chrome" } = {}) {
  if (await curlCffiAvailable()) {
    const out = path.join(TMP, crypto.randomBytes(6).toString("hex") + ".bin");
    const res = await runPy({ url, cookie, headers, follow, timeout, impersonate, out });
    if (res && !res.error && typeof res.status === "number") {
      const buf = fs.existsSync(out) ? fs.readFileSync(out) : Buffer.alloc(0);
      fs.rm(out, { force: true }, () => {});
      return {
        status: res.status,
        buf,
        text: buf.toString("utf8"),
        headers: { "content-type": res.ctype || "" },
        via: `curl_cffi/${impersonate}`,
        finalUrl: res.final,
        cf: !!res.cf,
      };
    }
    // fall through to native fetch
  }
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout * 1000);
  try {
    const r = await fetch(url, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.2535.85",
        "accept-language": "en-US,en;q=0.9",
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
      redirect: follow ? "follow" : "manual",
      signal: ac.signal,
    });
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, buf, text: buf.toString("utf8"), headers: Object.fromEntries(r.headers), via: "node-fetch", finalUrl: r.url };
  } catch (e) {
    return { status: 0, buf: Buffer.alloc(0), text: "", headers: {}, via: "node-fetch", error: e.message };
  } finally {
    clearTimeout(t);
  }
}
