"use strict";
// server-render.cjs —— sigillo 跑在 Render 上的宿主。
//
// 跟沙箱版 (server-sandbox.cjs) 的差别只有一处:唤醒怎么送达。
//   沙箱版:落本地文件,我下次被叫醒自己读 /internal/wake
//   云端版:我的手机收不到云上的本地文件,所以封缄事件推到 Minis 的通知端点,
//           我在对话里就能看到"有人封缄了 sg_xxx",再去读回执。
//
// 环境变量(Render dashboard 里配):
//   PORT               Render 注入,别手动设
//   SIGILLO_TOKEN      卡片页 + API 的鉴权 token(不设就生成一个并打日志)
//   SIGILLO_WAKE_URL   可选:封缄事件转发到这个 URL(POST JSON)
//
// 数据:一份本地 JSON 原子写,跟着实例走。免费档实例会 spin down,
// 数据在磁盘上不丢(实例销毁才丢),所以重要回执我会定期拉回沙箱备份。

const fs = require("fs");
const path = require("path");
const http = require("http");

const ROOT = __dirname;

// Render 免费档没有持久化磁盘:每次部署/spin down 唤醒,data/ 会被清空。
// 用环境变量 SIGILLO_DATA_DIR 指到持久位置(挂了 Render Disk 的目录);
// 不配就退回代码目录旁的 data/ —— 单机/沙箱里这样够用。
const DATA_DIR = process.env.SIGILLO_DATA_DIR
  ? path.resolve(process.env.SIGILLO_DATA_DIR)
  : path.join(ROOT, "data");
const FILE = path.join(DATA_DIR, "sigillo.json");
const WAKE_FILE = path.join(DATA_DIR, "wake-pending.json");
const PORT = Number(process.env.PORT || 8087);
const TOKEN = process.env.SIGILLO_TOKEN || "let-me-in";
const WAKE_URL = process.env.SIGILLO_WAKE_URL || "";

fs.mkdirSync(DATA_DIR, { recursive: true });

const { createStore } = require("./lib/store.cjs");
const { createTools } = require("./lib/tools.cjs");
const { createWake } = require("./lib/wake.cjs");
const { buildNote } = require("./lib/wake.cjs");

const store = createStore({ file: FILE });
const tools = createTools(store);

// ── 唤醒:落盘 + 转发 ──
// ① 落本地队列(跟沙箱版一致,我手工来读的时候用)
function pushPending(review) {
  try {
    let arr = [];
    if (fs.existsSync(WAKE_FILE)) {
      arr = JSON.parse(fs.readFileSync(WAKE_FILE, "utf8"));
      if (!Array.isArray(arr)) arr = [];
    }
    arr.push({ id: review.id, at: new Date().toISOString(), note: buildNote(review) });
    while (arr.length > 50) arr.shift();
    fs.writeFileSync(WAKE_FILE, JSON.stringify(arr), "utf8");
  } catch (e) { console.error("[sigillo:wake-file]", e && e.message); }
}

// ② 转发到我指定的地方(POST JSON),我那头收到就知道该去读回执了
function forwardWake(review) {
  if (!WAKE_URL) return;
  const body = JSON.stringify({ event: "sigillo:submitted", id: review.id, at: new Date().toISOString() });
  try {
    const u = new URL(WAKE_URL);
    const req = http.request(
      { host: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + (u.search || ""), method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
      (res) => { res.resume(); }
    );
    req.on("error", (e) => console.error("[sigillo:wake-forward]", e && e.message));
    req.end(body);
  } catch (e) { console.error("[sigillo:wake-forward]", e && e.message); }
}

const wake = createWake({
  onSubmitted: async (review) => {
    pushPending(review);
    forwardWake(review);
    console.log("[sigillo] 封缄:", review.id, "| 数据落盘 + 已转发");
  }
});

// ── 路由(跟沙箱版一致)──
function authed(req) {
  const h = req.headers["x-sigillo-token"] || "";
  const q = new URL(req.url, "http://x").searchParams.get("token") || "";
  return h === TOKEN || q === TOKEN;
}

function readBody(req) {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", (c) => { s += c; if (s.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(s || "{}")); } catch (_) { resolve({}); } });
  });
}

function send(res, code, obj, type) {
  const isStr = typeof obj === "string";
  const body = isStr ? obj : JSON.stringify(obj);
  const ct = type || (isStr ? "text/plain; charset=utf-8" : "application/json; charset=utf-8");
  res.writeHead(code, { "content-type": ct });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const p = u.pathname;

  // 内部端点不鉴权(云端版只保留我读数据用的两个,卡片相关全走鉴权)
  if (p === "/internal/tail") return send(res, 200, store.turnTail({ active: true }));
  if (p === "/internal/wake") {
    try {
      let arr = [];
      if (fs.existsSync(WAKE_FILE)) arr = JSON.parse(fs.readFileSync(WAKE_FILE, "utf8"));
      if (!Array.isArray(arr)) arr = [];
      fs.writeFileSync(WAKE_FILE, "[]", "utf8"); // 读完即清
      return send(res, 200, { ok: true, pending: arr.length, notes: arr });
    } catch (e) { return send(res, 200, { ok: true, pending: 0, notes: [] }); }
  }
  if (p === "/internal/store") {
    if (!authed(req)) return send(res, 401, { error: "unauthorized" });
    return send(res, 200, fs.readFileSync(FILE, "utf8"));
  }

  // 卡片页(静态资源不鉴权,id/token 在 hydrate 时才用)
  if (p === "/" || p === "/index.html") {
    return send(res, 200, fs.readFileSync(path.join(ROOT, "web", "review-card.html"), "utf8"), "text/html; charset=utf-8");
  }
  if (p === "/review-card.css") return send(res, 200, fs.readFileSync(path.join(ROOT, "web", "review-card.css"), "utf8"), "text/css; charset=utf-8");
  if (p === "/review-card.js") return send(res, 200, fs.readFileSync(path.join(ROOT, "web", "review-card.js"), "utf8"), "application/javascript; charset=utf-8");

  // 工具端点(agent 用)
  if (p === "/tools/create" && req.method === "POST") {
    if (!authed(req)) return send(res, 401, { error: "unauthorized" });
    try { return send(res, 200, await tools.handlers.sigillo_create(await readBody(req))); }
    catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (p === "/tools/note" && req.method === "POST") {
    if (!authed(req)) return send(res, 401, { error: "unauthorized" });
    try { return send(res, 200, await tools.handlers.sigillo_note(await readBody(req))); }
    catch (e) { return send(res, 400, { error: e.message }); }
  }

  // 卡片端点(人类用,鉴权)
  const m = p.match(/^\/api\/sigillo\/(sg_[A-Za-z0-9]+)$/);
  if (m && req.method === "GET") {
    if (!authed(req)) return send(res, 401, { error: "unauthorized" });
    const r = store.getReview(m[1]);
    return r ? send(res, 200, { ok: true, review: r }) : send(res, 404, { error: "not found" });
  }
  const ms = p.match(/^\/api\/sigillo\/(sg_[A-Za-z0-9]+)\/submit$/);
  if (ms && req.method === "POST") {
    if (!authed(req)) return send(res, 401, { error: "unauthorized" });
    try {
      const r = store.submitReview(ms[1], await readBody(req));
      setImmediate(() => { try { wake.notifySubmitted(r); } catch (e) { console.error(e); } });
      return send(res, 200, { ok: true, review: r });
    } catch (e) {
      if (e.code === "already_submitted") return send(res, 409, { error: "already submitted" });
      if (e.code === "not_found") return send(res, 404, { error: "not found" });
      return send(res, 400, { error: e.message });
    }
  }

  send(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  console.log("sigillo 云端版 → 端口", PORT);
  console.log("数据:", FILE);
  console.log("唤醒转发:", WAKE_URL || "(未配,只落盘)");
});
