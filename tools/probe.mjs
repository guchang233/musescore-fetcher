#!/usr/bin/env node
// CLI: 看一眼某个乐谱在各个通道上的真实可用性（不下载，只探测）。
// 用法: node tools/probe.mjs https://musescore.com/user/xxx/scores/1234567
import { parseScoreId, resolveScore } from "../server/resolve.mjs";
import * as jmuse from "../server/sources/jmuse.mjs";
import * as official from "../server/sources/official.mjs";

const input = process.argv[2];
if (!input) {
  console.log("用法: node tools/probe.mjs <musescore 乐谱链接或ID>");
  process.exit(1);
}

const id = parseScoreId(input);
if (!id) {
  console.error("解析不出乐谱 ID");
  process.exit(1);
}

console.log(`\n目标: id=${id}\n`);

const meta = await resolveScore(input);
console.log("页面元信息:", JSON.stringify(meta, null, 2));

const saltInfo = await jmuse.discoverSalt({ scoreUrl: meta.url });
console.log(`\nsalt: ${saltInfo.salt}${saltInfo.cached ? " (缓存)" : ""}${saltInfo.error ? " — " + saltInfo.error : ""}\n`);

console.log("— jmuse 通道 —");
for (const type of jmuse.PROBE_TYPES) {
  const r = await jmuse.tryType(id, type, { salt: saltInfo.salt });
  console.log(`  ${type.padEnd(10)} ${r.ok ? "OK   " + r.url : `${r.status} ${r.message || ""}`}`);
}

console.log("\n— 官方 App API 通道 —");
const off = await official.acquireViaOfficial(id, { token: process.env.LS_TOKEN });
console.log(`  ok=${off.ok} ${off.ok ? `格式=${off.format} 字节=${off.bytes.length}` : off.reason}`);
for (const a of off.attempts || []) {
  console.log(`   · ${a.step}: ${a.ok ? "OK" : "失败"} ${typeof a.detail === "string" ? a.detail.slice(0, 140) : ""}`);
}
console.log("");
