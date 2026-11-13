// Local engine — libmscore compiled to WebAssembly (webmscore).
// One loaded score can emit every MuseScore format, which is how "download all formats" works.
import "./node-shim.mjs";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const FORMATS = {
  pdf: { kind: "doc", name: "PDF 曲谱" },
  mscz: { kind: "muse", name: "MSCZ 原始格式" },
  mscx: { kind: "muse", name: "MSCX 未压缩工程" },
  mxl: { kind: "doc", name: "MusicXML 压缩包 (mxl)" },
  musicxml: { kind: "doc", name: "MusicXML 源码 (xml)" },
  mid: { kind: "audio", name: "MIDI" },
  mp3: { kind: "audio", name: "MP3 音频" },
  flac: { kind: "audio", name: "FLAC 音频" },
  ogg: { kind: "audio", name: "OGG 音频" },
  wav: { kind: "audio", name: "WAV 音频" },
  png: { kind: "image", name: "PNG 逐页图片 (zip)" },
  svg: { kind: "image", name: "SVG 矢量页" },
};

export const FORMAT_LIST = Object.entries(FORMATS).map(([ext, v]) => ({ ext, ...v }));

const INPUT_FORMATS = new Set([
  "mscz", "mscx", "musicxml", "mxl", "mid", "midi", "xml", "kar",
  "gp", "gp3", "gp4", "gp5", "gpx", "gtp", "ptb",
]);

let WebMscore = null;
let fontsPromise = null;
let soundFontPromise = null;
let chain = Promise.resolve();

/** Serialize all libmscore work — the WASM module is a single instance. */
function exclusive(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

async function ensureEngine() {
  if (!WebMscore) {
    const mod = await import("webmscore");
    WebMscore = mod.default;
    await WebMscore.ready;
  }
  if (!fontsPromise) {
    fontsPromise = (async () => {
      const fonts = require("@librescore/fonts");
      return Promise.all(Object.values(fonts).map((p) => fs.promises.readFile(p)));
    })();
  }
  return { WebMscore, fonts: await fontsPromise };
}

async function ensureSoundFont() {
  if (!soundFontPromise) {
    soundFontPromise = (async () => {
      const sf3 = require("@librescore/sf3");
      const p = Object.values(sf3)[0];
      return fs.promises.readFile(p);
    })();
  }
  return soundFontPromise;
}

export function guessFormat(filename = "") {
  const ext = String(filename).toLowerCase().split(".").pop();
  if (ext === "midi") return "mid";
  if (ext === "xml") return "xml";
  return INPUT_FORMATS.has(ext) ? ext : "mscz";
}

export async function inspect(bytes, inputFormat = "mscz") {
  const { WebMscore, fonts } = await ensureEngine();
  return exclusive(async () => {
    const score = await WebMscore.load(inputFormat, new Uint8Array(bytes), fonts);
    try {
      await score.generateExcerpts();
      const md = await score.metadata().catch(() => ({}));
      const title = await score.titleFilenameSafe().catch(() => md?.workTitle ?? "score");
      const pages = await score.npages().catch(() => null);
      return {
        title,
        pages,
        parts: (md?.excerpts ?? []).map((e) => ({ id: e.id, title: e.title })),
        meta: {
          workTitle: md?.workTitle ?? null,
          composer: md?.composer ?? null,
          arranger: md?.arranger ?? null,
          lyricist: md?.lyricist ?? null,
          copyright: md?.copyright ?? null,
        },
      };
    } finally {
    }
  });
}

/**
 * Convert one score payload into the requested formats.
 * @returns {Promise<Array<{name:string, ext:string, data:Uint8Array}>>}
 */
export async function convertAll(
  bytes,
  { inputFormat = "mscz", formats = ["mscz"], partIds = null, onProgress = () => {} } = {}
) {
  const wanted = formats.filter((f) => FORMATS[f]);
  if (!wanted.length) throw new Error("没有可导出的格式");

  const { WebMscore, fonts } = await ensureEngine();
  const results = [];

  await exclusive(async () => {
    const score = await WebMscore.load(inputFormat, new Uint8Array(bytes), fonts);
    try {
      await score.generateExcerpts();
      const base = await score.titleFilenameSafe().catch(() => "score");
      const md = await score.metadata().catch(() => ({ excerpts: [] }));
      const parts = partIds?.length ? (md.excerpts ?? []).filter((e) => partIds.includes(e.id)) : [];
      const targets = [{ id: -1, title: null }, ...parts.map((p) => ({ id: p.id, title: p.title }))];

      const needAudio = wanted.some((f) => ["mp3", "flac", "ogg", "wav"].includes(f));
      if (needAudio) {
        try {
          await score.setSoundFont(await ensureSoundFont());
        } catch (e) {
          onProgress({ level: "warn", message: `音色库加载失败（音频将无声）：${e.message}` });
        }
      }

      for (const target of targets) {
        await score.setExcerptId(target.id);
        const suffix = target.id === -1 ? "" : ` - ${sanitize(target.title || `part${target.id}`)}`;
        for (const fmt of wanted) {
          onProgress({ level: "info", message: `导出 ${fmt}${suffix}` });
          try {
            const data = await exportOne(score, fmt);
            if (!data) continue;
            results.push({ name: `${sanitize(base)}${suffix}.${outExt(fmt)}`, ext: fmt, data });
          } catch (e) {
            onProgress({ level: "warn", message: `导出 ${fmt}${suffix} 失败：${e.message}` });
          }
        }
      }
    } finally {
    }
  });

  return results;
}

function outExt(fmt) {
  if (fmt === "musicxml") return "musicxml";
  return fmt;
}

function sanitize(s) {
  return String(s).replace(/[\s<>:{}"/\\|?*~.\0]+/g, "_").slice(0, 80);
}

async function exportOne(score, fmt) {
  switch (fmt) {
    case "mscz":
      return score.saveMsc("mscz");
    case "mscx":
      return score.saveMsc("mscx");
    case "mxl":
      return score.saveMxl();
    case "musicxml": {
      const xml = await score.saveXml();
      return Buffer.from(xml, "utf8");
    }
    case "mid":
      return score.saveMidi(true, true);
    case "pdf":
      return score.savePdf();
    case "mp3":
      return score.saveAudio("mp3");
    case "flac":
      return score.saveAudio("flac");
    case "ogg":
      return score.saveAudio("ogg");
    case "wav":
      return score.saveAudio("wav");
    case "svg": {
      const pages = await score.npages();
      const out = [];
      for (let i = 0; i < pages; i++) out.push(await score.saveSvg(i, false));
      return Buffer.from(out.join("\n<!-- page break -->\n"), "utf8");
    }
    case "png": {
      const pages = await score.npages();
      const { default: JSZip } = await import("jszip");
      const zip = new JSZip();
      for (let i = 0; i < pages; i++) {
        zip.file(`page-${String(i + 1).padStart(2, "0")}.png`, await score.savePng(i, false, false));
      }
      return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    }
    default:
      return null;
  }
}

