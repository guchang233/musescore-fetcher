// Node-side compat shim for webmscore (libmscore WASM in Node).
// 1) Node >= 21 exposes a getter-only global `navigator`; webmscore's DOM shim assigns to it.
// 2) webmscore's emscripten loader uses `fetch()` for the .wasm payload, but Node's fetch
//    rejects plain filesystem paths ("unknown scheme"). We teach fetch about local files.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

try {
  const desc = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  if (desc && !desc.writable) {
    Object.defineProperty(globalThis, "navigator", {
      value: { userAgent: "node", platform: process.platform, language: "en-US" },
      configurable: true,
      writable: true,
    });
  }
} catch {
  /* ignore */
}

const realFetch = globalThis.fetch;
if (!globalThis.__lscoreFetchShim) {
  globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input && typeof input === "object" && "url" in input
          ? input.url
          : String(input);
    const isHttp = /^https?:\/\//i.test(url);
    const isFileUrl = url.startsWith("file://");
    if (isHttp) return realFetch(input, init);
    try {
      const p = isFileUrl ? fileURLToPath(url) : url;
      const buf = await fs.promises.readFile(p);
      return new Response(buf, {
        status: 200,
        headers: {
          "content-type": p.endsWith(".wasm") ? "application/wasm" : "application/octet-stream",
          "content-length": String(buf.length),
        },
      });
    } catch (e) {
      return realFetch(url, init).catch(() => {
        throw e;
      });
    }
  };
  globalThis.__lscoreFetchShim = true;
}

export const ready = true;
