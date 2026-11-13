// LibreScoreAPP web client
const $ = (id) => document.getElementById(id);
const logEl = $("log");

let resolved = null; // { id, title, url, ... }
let currentRef = null; // ref of the score stored on the server
let formatList = [];
let lastThumbHash = null;
let lastPicked = null;

function showPreview() {
  const box = $("preview");
  if (!lastThumbHash) {
    box.innerHTML = "";
    return;
  }
  box.innerHTML = `<img src="/api/preview?hash=${lastThumbHash}&page=0" alt="第 1 页预览" /><span>CDN 直取的第 1 页（<a href="/api/preview?hash=${lastThumbHash}&format=svg" target="_blank">SVG</a> · <a href="/api/preview?hash=${lastThumbHash}&page=0" target="_blank">PNG</a>）</span>`;
}

function log(msg, kind = "") {
  const ts = new Date().toLocaleTimeString();
  const span = document.createElement("span");
  if (kind) span.className = kind;
  span.textContent = `[${ts}] ${msg}\n`;
  logEl.appendChild(span);
  logEl.scrollTop = logEl.scrollHeight;
  if (kind === "err") console.error(msg);
}

async function api(path, body, opts = {}) {
  const r = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    ...opts,
  });
  const ct = r.headers.get("content-type") || "";
  if (ct.includes("application/zip")) return { zip: await r.blob(), filename: r.headers.get("content-disposition") };
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(json.error || json.reason || `HTTP ${r.status}`), { payload: json, status: r.status });
  return json;
}

function downloadBlob(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

/* ------------------------------ boot ------------------------------ */
async function boot() {
  try {
    const health = await api("/api/health");
    formatList = health.formats || [];
    $("status").textContent = `本地服务已连接 · Node ${health.env.node}`;
    $("status").className = "status ok";
    renderFormats();
    log("服务就绪，可用格式：" + formatList.map((f) => f.ext).join(", "), "ok");
  } catch (e) {
    $("status").textContent = "本地服务未连接";
    $("status").className = "status bad";
    log("连接本地服务失败：" + e.message, "err");
  }
}

function renderFormats() {
  const box = $("formats");
  box.innerHTML = "";
  for (const f of formatList) {
    const id = "fmt-" + f.ext;
    const label = document.createElement("label");
    label.className = "fmt" + (["mscz", "pdf", "mxl", "mid"].includes(f.ext) ? " on" : "");
    label.innerHTML = `<input type="checkbox" id="${id}" value="${f.ext}" ${
      ["mscz", "pdf", "mxl", "mid"].includes(f.ext) ? "checked" : ""
    } /><span>${f.ext.toUpperCase()}<small>${f.name}</small></span>`;
    label.querySelector("input").addEventListener("change", (e) => {
      label.classList.toggle("on", e.target.checked);
    });
    box.appendChild(label);
  }
}

function selectedFormats() {
  return [...document.querySelectorAll("#formats input:checked")].map((i) => i.value);
}

/* ------------------------------ search ------------------------------ */
$("searchBtn").addEventListener("click", doSearch);
$("q").addEventListener("keydown", (e) => {
  if (e.key === "Enter") doSearch();
});

async function doSearch() {
  const q = $("q").value.trim();
  if (!q) return;
  $("searchBtn").disabled = true;
  $("results").innerHTML = "";
  try {
    log(`搜索「${q}」…`);
    const r = await api(`/api/search?text=${encodeURIComponent(q)}&limit=12`);
    if (!r.ok) throw new Error(r.raw?.message || r.error || `HTTP ${r.status}`);
    log(`搜索命中 ${r.results.length} 条（官方移动端 API）`, "ok");
    for (const s of r.results) {
      const el = document.createElement("div");
      el.className = "result";
      el.innerHTML = `<span class="tag ${s.isFree ? "" : "paid"}">${s.isFree ? "free" : "paid"}${
        s.isDownloadable ? " · DL" : ""
      }</span><span class="t">${escapeHtml(s.title)}<small>${escapeHtml(s.composer || "")}${
        s.pages ? " · " + s.pages + " 页" : ""
      }</small></span>`;
      el.onclick = () => {
        $("url").value = `https://musescore.com/score/${s.id}`;
        lastThumbHash = s.thumbHash || null;
        lastPicked = s;
        showPreview();
        $("resolve").click();
      };
      $("results").appendChild(el);
    }
  } catch (e) {
    log("搜索失败：" + e.message, "err");
  } finally {
    $("searchBtn").disabled = false;
  }
}

const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/* ------------------------------ resolve ------------------------------ */
$("resolve").addEventListener("click", async () => {
  const url = $("url").value.trim();
  if (!url) return log("先粘贴一个 musescore.com 乐谱链接", "err");
  $("resolve").disabled = true;
  try {
    log("解析 " + url);
    const info = await api("/api/resolve", { url });
    if (lastPicked && String(lastPicked.id) === String(info.id)) {
      info.title = info.title || lastPicked.title;
      info.pageCount = info.pageCount || lastPicked.pages;
      info.author = info.author || lastPicked.composer;
      info.fromSearch = true;
    }
    resolved = info;
    const noteHtml = info.fromSearch
      ? `<br><span style="color:#7fd1b9">元数据来自官方 API（页面本身被 Cloudflare 挡住，文件请走「用浏览器取」）</span>`
      : info.note
        ? `<br><span style="color:#f0b35e">${info.note}</span>`
        : "";
    $("meta").innerHTML = `ID <b>${info.id}</b> · 标题 <b>${info.title || "(未知)"}</b>${
      info.author ? " · 作者 <b>" + info.author + "</b>" : ""
    }${info.pageCount ? " · 页数 <b>" + info.pageCount + "</b>" : ""}${noteHtml}`;
    log(`解析成功：id=${info.id} title=${info.title || "?"}`, "ok");
  } catch (e) {
    log("解析失败：" + e.message, "err");
    $("meta").innerHTML = `<span style="color:#f87171">${e.message}</span>`;
  } finally {
    $("resolve").disabled = false;
  }
});

/* ------------------------------ acquire ------------------------------ */
function acquireOpts(extra = {}) {
  const cookie = $("cookie").value.trim();
  const token = $("token").value.trim();
  return {
    url: $("url").value.trim(),
    id: resolved?.id,
    ...(cookie ? { cookie } : {}),
    ...(token ? { token } : {}),
    ...extra,
  };
}

async function acquire(format) {
  if (!resolved?.id && !$("url").value.trim()) throw new Error("先解析一个乐谱链接");
  log(`请求 ${format.toUpperCase()} …`);
  const res = await api("/api/acquire", acquireOpts({ format }));
  if (res.ref) {
    currentRef = res.ref;
    $("convert").disabled = false;
    $("convertHint").textContent = `已缓存在本地：#${res.ref}（${res.source || res.format}）`;
  }
  return res;
}

/* ------------------------ browser engine (recommended) ------------------------ */
$("getBrowser").addEventListener("click", async (e) => {
  const url = $("url").value.trim();
  if (!url) return log("先填一个乐谱链接（或搜索选一个）", "err");
  e.target.disabled = true;
  try {
    log("启动本机浏览器取文件…窗口会自动打开；如果出现 Cloudflare 验证，在窗口里点一下即可（profile 会记住）");
    const res = await api("/api/browser", {
      url,
      want: ["mscz", "mxl", "mid", "mp3", "pdf"],
      headful: true,
    });
    for (const line of res.logs || []) log("  " + line);
    if (!res.ok) throw new Error(res.message || "浏览器没取到文件");
    const list = (res.list || []).map((x) => x.type).join(", ");
    log(`页面直链：${list}`, "ok");
    for (const r of res.refs || []) log(`  ${r.type}: ${(r.bytes / 1024).toFixed(1)} KiB → ref=${r.ref}`);
    const native = (res.refs || []).find((r) => r.type === "mscz") || res.refs?.[0];
    if (native) {
      currentRef = native.ref;
      $("convert").disabled = false;
      $("convertHint").textContent = `已就绪：${native.type}（${(native.bytes / 1024).toFixed(1)} KiB）· 来源=浏览器`;
      $("source").textContent = `浏览器取到 ${res.refs.length} 个文件：${res.refs.map((r) => r.type).join(", ")}`;
      log("现在勾格式 → 转换并打包下载", "ok");
    }
  } catch (err) {
    log("浏览器取文件失败：" + err.message, "err");
    $("source").textContent =
      "浏览器没拿到。可试：① 确认本机浏览器能正常打开该谱面；② 用油猴脚本「→ App」；③ 把下载好的 .mscz 拖进投放区。";
  } finally {
    e.target.disabled = false;
  }
});

$("getMscz").addEventListener("click", async (e) => {
  e.target.disabled = true;
  try {
    const res = await acquire("mscz");
    log(`MSCZ 获取成功：${res.bytes} 字节，来源 ${res.source}`, "ok");
    $("source").textContent = `原生文件已就绪（${(res.bytes / 1024).toFixed(1)} KiB，来源 ${res.source}）。现在可以转换任意格式。`;
    renderReport(res.report);
  } catch (err) {
    log("MSCZ 获取失败：" + err.message, "err");
    renderReport(err.payload?.report || err.payload?.attempts);
    $("source").textContent =
      "原生文件没拿到。可尝试：① 在 musescore.com 登录后复制 Cookie 填到高级里；② 用配套油猴脚本在页面上取；③ 若只是要 PDF/MP3/MIDI，用右边的站点直下。";
  } finally {
    e.target.disabled = false;
  }
});

function renderReport(report) {
  if (!Array.isArray(report) || !report.length) return;
  const lines = report.map((r) => {
    if (r.strategy) return `• ${r.strategy}: ${r.ok ? "OK" : "失败"}${r.reason ? " — " + r.reason : ""}`;
    if (r.step) return `• ${r.step}: ${r.ok ? "OK" : "失败"}${r.detail ? " — " + (typeof r.detail === "string" ? r.detail : JSON.stringify(r.detail).slice(0, 160)) : ""}`;
    return "• " + JSON.stringify(r).slice(0, 160);
  });
  log("尝试记录：\n" + lines.join("\n"));
}

for (const [id, fmt] of [
  ["getPdf", "pdf"],
  ["getMp3", "mp3"],
  ["getMidi", "mid"],
]) {
  $(id).addEventListener("click", async (e) => {
    e.target.disabled = true;
    try {
      const res = await acquire(fmt);
      log(`${fmt.toUpperCase()} 获取成功：${(res.bytes / 1024).toFixed(1)} KiB`, "ok");
      // fetch the stored bytes back as a file
      const r = await fetch(`/api/raw?ref=${encodeURIComponent(res.ref)}&name=${encodeURIComponent(fmt)}`);
      downloadBlob(await r.blob(), scoreName() + "." + fmt);
    } catch (err) {
      log(`${fmt.toUpperCase()} 获取失败：${err.message}`, "err");
    } finally {
      e.target.disabled = false;
    }
  });
}

function scoreName() {
  return (resolved?.title || resolved?.id || "score").toString().replace(/[\s<>:{}"/\\|?*]+/g, "_").slice(0, 70);
}

$("dlImport").addEventListener("click", async (e) => {
  const url = $("dlurl").value.trim();
  if (!url) return log("先把直链粘进来（油猴脚本面板里能拿到）", "err");
  e.target.disabled = true;
  try {
    log("服务器尝试抓取直链…（若被 Cloudflare 拦，请改用油猴脚本的「下载 / → App」）");
    const res = await api("/api/fetch", { url, cookie: $("cookie").value.trim() || undefined });
    currentRef = res.ref;
    $("convert").disabled = false;
    $("convertHint").textContent = `已从直链导入：${res.ext} / ${(res.bytes / 1024).toFixed(1)} KiB`;
    log(`直链导入成功：${res.ext} ${(res.bytes / 1024).toFixed(1)} KiB → ref=${res.ref}`, "ok");
  } catch (err) {
    log("直链导入失败：" + err.message, "err");
  } finally {
    e.target.disabled = false;
  }
});

$("probe").addEventListener("click", async (e) => {  e.target.disabled = true;
  try {
    log("探测接口矩阵（会依次请求 jmuse 的各种 type 与官方 v2 接口）…");
    const res = await api("/api/probe", { url: $("url").value.trim(), id: resolved?.id, token: $("token").value.trim() || undefined });
    const table = [
      `salt: ${res.salt.value} ${res.salt.cached ? "(缓存)" : ""}${res.salt.error ? " — " + res.salt.error : ""}`,
      ...res.jmuse.map((r) => `jmuse ${r.type.padEnd(9)} ${r.ok ? "OK  " + r.url : `${r.status} ${r.message || ""}`}`),
      `official: ${res.official.ok ? "OK " + res.official.format : res.official.reason}`,
      ...(res.official.attempts || []).map((a) => `  · ${a.step}: ${a.ok ? "OK" : "失败"} ${typeof a.detail === "string" ? a.detail : ""}`),
    ];
    log(table.join("\n"), res.official.ok ? "ok" : "");
  } catch (err) {
    log("探测失败：" + err.message, "err");
  } finally {
    e.target.disabled = false;
  }
});

/* ------------------------ inbox: auto-imported files ------------------------ */
async function pollInbox() {
  try {
    const r = await api("/api/inbox");
    $("inboxHint").textContent = `监听：${r.watching}（把 .mscz/.mscx/.mxl/.musicxml/.mid 放进去就会自动出现）`;
    const box = $("inbox");
    box.innerHTML = "";
    if (!r.items?.length) return;
    for (const it of r.items) {
      const el = document.createElement("div");
      el.className = "result";
      el.innerHTML = `<span class="tag">${(it.inputFormat || "?").toUpperCase()}</span><span class="t">${escapeHtml(
        it.title || it.name
      )}<small>${(it.bytes / 1024).toFixed(1)} KiB${it.pages ? " · " + it.pages + " 页" : ""}</small></span>`;
      el.onclick = () => {
        currentRef = it.ref;
        $("convert").disabled = false;
        $("convertHint").textContent = `已载入自动导入的《${it.title || it.name}》`;
        log(`已选中自动导入：${it.name} ✓ ref=${it.ref}`, "ok");
        $("convert").scrollIntoView({ behavior: "smooth", block: "center" });
      };
      box.appendChild(el);
    }
  } catch (e) {
    $("inboxHint").textContent = "监听状态不可用：" + e.message;
  }
}

/* ------------------------------ convert ------------------------------ */
$("convert").addEventListener("click", async (e) => {
  const formats = selectedFormats();
  if (!formats.length) return log("至少勾选一个格式", "err");
  if (!currentRef) return log("还没有可转换的谱面：先获取 MSCZ 或拖入文件", "err");
  e.target.disabled = true;
  try {
    log(`开始转换 → ${formats.join(", ")}（首次加载 libmscore WASM 约 1-2 秒）`);
    const r = await fetch("/api/convert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: currentRef, formats, partIds: $("parts").checked ? undefined : [] }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${r.status}`);
    }
    const blob = await r.blob();
    const n = r.headers.get("x-lscore-files") || "?";
    downloadBlob(blob, `${scoreName()}-${formats.join("+")}.zip`);
    log(`转换完成：${n} 个文件已打包下载`, "ok");
  } catch (err) {
    log("转换失败：" + err.message, "err");
  } finally {
    e.target.disabled = false;
  }
});

$("all").addEventListener("click", async (e) => {
  e.target.disabled = true;
  try {
    if (!currentRef) {
      log("先获取原生 MSCZ …");
      const res = await acquire("mscz");
      log(`MSCZ 就绪：${res.bytes} 字节（${res.source}）`, "ok");
      $("source").textContent = `原生文件已就绪（${(res.bytes / 1024).toFixed(1)} KiB，来源 ${res.source}）`;
    }
    const formats = formatList.map((f) => f.ext);
    log("一键导出：" + formats.join(", "));
    const r = await fetch("/api/convert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: currentRef, formats, partIds: $("parts").checked ? undefined : [] }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    downloadBlob(await r.blob(), `${scoreName()}-all-formats.zip`);
    log("全部格式已打包", "ok");
  } catch (err) {
    log("一键导出失败：" + err.message, "err");
  } finally {
    e.target.disabled = false;
  }
});

/* ------------------------------ drop zone ------------------------------ */
const drop = $("drop");
drop.addEventListener("click", () => $("file").click());
drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  drop.classList.add("hover");
});
drop.addEventListener("dragleave", () => drop.classList.remove("hover"));
drop.addEventListener("drop", async (e) => {
  e.preventDefault();
  drop.classList.remove("hover");
  const f = e.dataTransfer.files[0];
  if (f) await uploadFile(f);
});
$("file").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (f) await uploadFile(f);
});

async function uploadFile(file) {
  try {
    log(`上传 ${file.name}（${(file.size / 1024).toFixed(1)} KiB）到本地引擎…`);
    const r = await fetch("/api/upload", {
      method: "POST",
      headers: {
        "x-filename": encodeURIComponent(file.name),
        "content-type": "application/octet-stream",
        ...(resolved?.id ? { "x-score-id": String(resolved.id) } : {}),
      },
      body: file,
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    currentRef = j.ref;
    $("convert").disabled = false;
    $("convertHint").textContent = `已载入 ${file.name}：${j.pages ?? "?"} 页${j.parts?.length ? `，${j.parts.length} 个分谱` : ""}`;
    log(`载入成功：#${j.ref}「${j.title}」${j.parts?.length ? " 分谱: " + j.parts.map((p) => p.title).join(" / ") : ""}`, "ok");
  } catch (e) {
    log("载入失败：" + e.message, "err");
  }
}

boot();
pollInbox();
setInterval(pollInbox, 4000);
