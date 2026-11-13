# 设计与实现笔记（v2.0.0）

这份笔记记录"为什么这么写"，尤其是踩过的坑，避免以后又绕回去。

---

## 1. 数据从哪来

musescore.com 把乐谱页的 SSR 数据塞进 DOM（HTML 属性转义的 JSON），其中：

```
store.page.data.type_download_list = [
  { type: "mscz",       url: "https://musescore.com/score/download/index?score_id=…&type=mscz&h=…" },
  { type: "mxl",        url: "…&type=mxl&h=…" },
  { type: "mid",        url: "…&type=mid&h=…" },
  { type: "mp3",        url: "…&type=mp3&h=…" },
  { type: "pdf",        url: "…&type=pdf&h=…" },
  { type: "pdf-sample", url: "…&type=pdf-sample&h=…" },
  { type: "mp4-sheet",  url: "…&type=mp4-sheet&h=…" }
]
```

关键点：

1. **同一个 `h` 覆盖所有 type**（实测某谱：`h=7038688961150814783` 对 8 种类型都对）
   → 所以只需要拿到其中一条 URL，就能"换 type"得到其它格式。
2. `h` 是服务端签的，**客户端算不出来**，只能从页面/站点请求里读到。
3. 是否真给文件由服务端决定：`is_free` / `hasAccess` / `is_download_limited` / `paywall` 这些字段决定 402 还是 200。

### 三个采集器

| 来源 | 说明 |
|---|---|
| `store` | 深挖 `UGAPP / __INITIAL_STATE__ / __NUXT__`，深度 12，数组也走 |
| `html` | 反转义后找 `"type_download_list":[…]`；另用正则兜底扫裸链接 |
| `dom` | 真实 `<a href*="score/download">` |

> 这里必须用 `unsafeWindow`：Tampermonkey 沙箱里的 `window` 是代理对象，读不到页面的 `UGAPP`，也挂不上钩子。

---

## 2. 抓"站点自己发出的下载请求"

站点点 Download 时可能：`window.open()` 新标签页、`<a download>` 点击、或 `fetch/XHR`。

因此钩子要覆盖这四类，且**必须挂在页面真实 window 上**，并在 `document-start` 就装好：

```js
const UW = unsafeWindow;
UW.fetch = wrap(UW.fetch);
UW.XMLHttpRequest.prototype.open = wrap(…);
UW.HTMLAnchorElement.prototype.click = wrap(…);
UW.open = wrap(…);
```

过滤规则（避免抓到自己）：

```
收： /score/download/index 、 .mscz|.mscx|.mxl|.musicxml 、 type=mscz…
弃： /api/jmuse 、 type=mp3|midi|mid|img
```

---

## 3. 取字节的顺序（踩坑后定稿）

```
1) 页面 fetch(url, {credentials:'include'})   ← 带你自己的 cf_clearance，最像正常请求
2) GM_xmlhttpRequest（绕过 CORS，可跟随 302 到 S3）
3) 两者都失败 → 用同一个 h 换 mscx/mxl/musicxml 再试
4) 仍失败 → <a download> 交给浏览器网络栈；文件落「下载」夹，本地 App 自动导入
```

判定"失败"的依据不能只看 `r.ok`：

- `content-type: text/html` 且内容含 `just a moment` → Cloudflare 挑战页
- `content-type: application/json` + 402/403 → 站点按账号拦
- 长度 < 200 B → 不是文件

把这三类写进日志，用户一眼能分清"被墙"还是"被限权"。

---

## 4. 界面为什么用"字符串渲染 + 事件委托"

早期版本用 `document.createElement` 逐元素拼行：

```js
const row = document.createElement("div");
row.append(chip, src, btn1, btn2, …);   // ← 在某些管理器/页面里静默失败
```

结果用户看到的是**一排空框**（元素没进 DOM，样式还在），而且不同版本坏法不一样（有时只剩两个走 `appendChild` 的按钮）。排查成本极高。

现在：

```js
listEl.innerHTML = items.map((it, i) => rowHtml(it, i)).join("");
listEl.addEventListener("click", (e) => {
  const el = e.target.closest("[data-act]");
  // 用 data-kind / data-i 索引，不依赖闭包
});
```

优点：
- 只要 `innerHTML` 能用（面板本身就是这么画的），行就一定渲染
- 不依赖 `append`、不依赖闭包、不依赖逐元素样式
- 自带渲染自检：按钮数 < 条数×3 时自动退化成纯文本

---

## 5. 交互细节

| 细节 | 原因 |
|---|---|
| 每行都显示 URL（点一下复制） | 之前只有按钮，用户反映"看不到每个链接是什么" |
| 标题栏可拖动，位置写 localStorage | 面板挡住谱面时能挪开 |
| `<details>` 分区 | 日志/粘贴/捕获不常用，默认收起 |
| 右上角状态点 | 绿=本地 App 在线（能转格式），红=离线（只能保存/浏览器下载） |
| 日志追加而非覆盖 | 失败原因不会被下一条冲掉 |
| 「为什么下不了」 | 直接读页面字段给出人话结论，省得反复猜 |

---

## 6. 与本地后端的分工

- 油猴：**取**（直链、捕获、字节）与**存**（保存到硬盘）
- 本地 App（Node）：**转**（webmscore/libmscore WASM，12 种格式 + 分谱）
- 断线时：`→ App` 自动降级为浏览器下载；本地 App 的下载夹监听会补上

这样拆的原因：把 30 MB 的 WASM 塞进页面，既有 CSP 风险，也会拖慢每次打开乐谱页。

---

## 7. 已知边界

- `/api/jmuse` **永远不会**返回 mscz（它只产播放器用的图/音/MIDI）
- 桌面端 `api.musescore.com/v2/score/file` 需要服务端签发的 `key`，且移动端 `urls.mscze` 被 Play Integrity 锁死 → 第三方客户端无解
- 因此 mscz 只可能来自：页面 `type_download_list`、站点自己下载时的签名 URL
- 站点按账号拦（402/403 JSON）时，任何客户端都拿不到；这不是脚本能绕的
