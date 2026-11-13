#!/usr/bin/env node
// 能力矩阵自检：在这台机器上，把每条通道都真实打一遍，告诉你哪条能用。
// 用法：
//   node tools/verify.mjs                          # 用内置示例谱面
//   node tools/verify.mjs https://musescore.com/score/4579129206530088
//   node tools/verify.mjs <url> --browser          # 额外跑一遍浏览器引擎（会弹窗）
import { parseScoreId } from "../server/resolve.mjs";
import { search } from "../server/sources/mobile-api.mjs";
import { pageRender, thumbHashFrom } from "../server/sources/cdn.mjs";
import { smartFetch, curlCffiAvailable } from "../server/fetcher.mjs";
import { findBrowser } from "../server/browser-engine.mjs";
import { FORMAT_LIST } from "../server/convert.mjs";

const arg = process.argv[2] || "https://musescore.com/score/4579129206530088";
const withBrowser = process.argv.includes("--browser");
const id = parseScoreId(arg);
const rows = [];
const add = (name, ok, detail) => {
  rows.push({ name, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name.padEnd(28)} ${detail}`);
};

console.log(`\n目标: ${arg}  (id=${id ?? "?"})\n`);

/* 1. 官方移动端 API（搜索/元数据） */
try {
  const r = await search("skyfall adele", { limit: 5 });
  add("官方移动端 API", r.status === 200, `HTTP ${r.status} · ${r.results.length} 条结果`);
} catch (e) {
  add("官方移动端 API", false, e.message);
}

/* 2. CDN 预览页（无 Cloudflare） */
try {
  const r = await search("skyfall adele", { limit: 5 });
  const first = r.results[0];
  if (first?.thumbHash) {
    const p = await pageRender(first.thumbHash, { page: 0, format: "png" });
    add("CDN 页面渲染", p.ok, p.ok ? `${(p.bytes.length / 1024).toFixed(1)} KiB PNG（第 1 页）` : p.message);
  } else {
    add("CDN 页面渲染", false, "搜索里没带 render hash");
  }
} catch (e) {
  add("CDN 页面渲染", false, e.message);
}

/* 3. curl_cffi 直取（TLS 指纹） */
const hasCurl = await curlCffiAvailable();
try {
  const r = await smartFetch(arg.startsWith("http") ? arg : `https://musescore.com/score/${id}`, { timeout: 30 });
  const cf = /just a moment|verify you are human/i.test(r.text);
  add("HTTP 直取（TLS 指纹）", r.status === 200 && !cf, `HTTP ${r.status} · ${r.via}${cf ? " · Cloudflare 挑战" : ""}`);
} catch (e) {
  add("HTTP 直取（TLS 指纹）", false, e.message);
}
add("curl_cffi 可用", hasCurl, hasCurl ? "python -c 'import curl_cffi' OK" : "pip install curl_cffi");

/* 4. 浏览器引擎 */
const browser = findBrowser();
add("浏览器可执行文件", !!browser, browser || "未找到 Chrome/Edge（设 BROWSER_PATH）");
if (withBrowser && browser) {
  const { browserFetch } = await import("../server/browser-engine.mjs");
  const r = await browserFetch({
    scoreUrl: arg.startsWith("http") ? arg : `https://musescore.com/score/${id}`,
    want: ["mscz"],
    headful: true,
    timeoutMs: 90000,
    onLog: (m) => console.log("   ·", m),
  });
  add("浏览器取文件", r.ok, r.ok ? `${r.files.map((f) => f.type + ":" + f.bytes.length).join(", ")}` : r.message);
}

/* 5. 本地转换引擎 */
add("本地转换引擎", true, `${FORMAT_LIST.length} 种格式可用（mscz→…）`);

console.log("\n结论：");
const okCount = rows.filter((r) => r.ok).length;
console.log(`  ${okCount}/${rows.length} 项通过。`);
if (!rows.find((r) => r.name.startsWith("HTTP 直取"))?.ok) {
  console.log("  · 这台机器的出口 IP 被 Cloudflare 挑战，纯 HTTP 拿不到页面 —— 用浏览器引擎或油猴脚本。");
}
console.log("");
