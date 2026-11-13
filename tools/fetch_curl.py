#!/usr/bin/env python3
"""curl_cffi bridge: fetch a URL with a real Chrome/Safari/Firefox TLS fingerprint.

Node's fetch() has an obvious bot TLS fingerprint, so Cloudflare challenges it even from a
clean IP. This helper gives the local service a browser-grade handshake (and accepts the
user's own cookies), which is what makes the "direct" path usable on a normal home network.

Usage:  python fetch_curl.py '<json>'
json = {"url": "...", "cookie": "...", "impersonate": "chrome", "follow": true,
        "headers": {...}, "out": "path", "timeout": 60}

Prints one JSON line: {"ok":true,"status":200,"len":N,"out":"...","final":"...","ctype":"..."}
"""
import json
import sys

try:
    from curl_cffi import requests
except Exception as e:  # pragma: no cover
    print(json.dumps({"ok": False, "error": f"curl_cffi not installed: {e}"}))
    sys.exit(9)


def main():
    cfg = json.loads(sys.argv[1])
    url = cfg["url"]
    out = cfg.get("out") or "fetch.out"
    headers = {
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
    }
    headers.update(cfg.get("headers") or {})
    cookie = cfg.get("cookie") or ""
    if cookie:
        headers["cookie"] = cookie

    try:
        s = requests.Session(impersonate=cfg.get("impersonate") or "chrome")
        r = s.get(url, headers=headers, timeout=cfg.get("timeout", 60), allow_redirects=cfg.get("follow", True))
        with open(out, "wb") as f:
            f.write(r.content)
        print(json.dumps({
            "ok": 200 <= r.status_code < 400,
            "status": r.status_code,
            "len": len(r.content),
            "out": out,
            "final": r.url,
            "ctype": r.headers.get("content-type"),
            "cf": ("Just a moment" in r.text[:4000]) or ("Verify you are human" in r.text[:4000]),
        }))
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}))


main()
