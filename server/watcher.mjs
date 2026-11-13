// Downloads-folder watcher.
//
// Why: musescore.com's signed download URL is behind a Cloudflare challenge when you open it
// as a navigation, but the *browser* solves that for you and saves the file. So the most
// robust fallback is: let the browser download it, and pick the file up automatically here.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const EXTS = new Set([".mscz", ".mscx", ".mxl", ".musicxml", ".mid", ".midi"]);
const seen = new Map(); // path -> size@mtime

export function defaultWatchDir() {
  return process.env.WATCH_DIR || path.join(os.homedir(), "Downloads");
}

/**
 * @param {{dir?:string, onFile:(file:{path:string,name:string,bytes:Buffer})=>void, log?:(s:string)=>void}} opts
 */
/** 只接收真正的乐谱文件，忽略 CF 拦截页存下来的 .html/.mscz 假文件 */
function looksLikeScore(bytes, filePath) {
  const head = bytes.subarray(0, 200).toString("utf8").toLowerCase();
  if (head.includes("<!doctype html") || head.includes("<html")) return false;
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".mscz":
    case ".mxl":
      return bytes[0] === 0x50 && bytes[1] === 0x4b; // PK
    case ".mscx":
    case ".musicxml":
      return head.includes("<?xml") || head.includes("<musescore") || head.includes("<score-partwise");
    case ".mid":
    case ".midi":
      return bytes[0] === 0x4d && bytes[1] === 0x54 && bytes[2] === 0x68 && bytes[3] === 0x64; // MThd
    default:
      return false;
  }
}
export function startWatcher({ dir = defaultWatchDir(), onFile, log = () => {} } = {}) {
  let watcher = null;

  const consider = (filePath) => {
    try {
      const st = fs.statSync(filePath);
      if (!st.isFile()) return;
      if (!EXTS.has(path.extname(filePath).toLowerCase())) return;
      const stamp = `${st.size}@${Math.round(st.mtimeMs)}`;
      if (seen.get(filePath) === stamp) return;
      seen.set(filePath, stamp);
      // skip files still being written
      if (Date.now() - st.mtimeMs < 600) {
        setTimeout(() => {
          seen.delete(filePath);
          consider(filePath);
        }, 1200);
        return;
      }
      const bytes = fs.readFileSync(filePath);
      if (bytes.length < 256) return;
      if (!looksLikeScore(bytes, filePath)) {
        log(`[watch] 跳过 ${path.basename(filePath)}：内容不像乐谱（可能是 Cloudflare 拦截页）`);
        return;
      }
      onFile({ path: filePath, name: path.basename(filePath), bytes });
    } catch {
      /* ignore */
    }
  };

  const sweep = () => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isFile()) continue;
      consider(path.join(dir, e.name));
    }
  };

  try {
    fs.mkdirSync(dir, { recursive: true });
    // 先把已存在的文件登记成"已见"，避免启动时把旧文件全灌进来
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile()) continue;
      const p = path.join(dir, e.name);
      try {
        const st = fs.statSync(p);
        seen.set(p, `${st.size}@${Math.round(st.mtimeMs)}`);
      } catch {}
    }
    watcher = fs.watch(dir, { persistent: false }, (_evt, filename) => {
      if (!filename) return;
      const p = path.join(dir, filename.toString());
      setTimeout(() => consider(p), 400);
    });
    watcher.on("error", (e) => log(`[watch] error ${e.message}`));
    log(`[watch] 监听 ${dir}（.mscz/.mscx/.mxl/.musicxml/.mid）`);
  } catch (e) {
    log(`[watch] 无法监听 ${dir}: ${e.message}`);
  }

  const timer = setInterval(sweep, 5000);
  timer.unref?.();

  return {
    dir,
    stop() {
      try {
        watcher?.close();
      } catch {}
      clearInterval(timer);
    },
  };
}
