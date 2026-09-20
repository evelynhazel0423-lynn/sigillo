"use strict";
// server-sandbox.cjs —— Minis 沙箱里的 sigillo 宿主。
// 在 examples/server.cjs 的基础上,只改一处:封缄唤醒把便签写进待读文件,
// 而不是只打印到日志 —— 下次 Mommy 叫我,我第一眼就读到它。
//
// 启动:sh /var/minis/workspace/sigillo/run.sh(已经指向这个文件)

const path = require("path");
const fs = require("fs");
const express = require("express");

const DIR = path.resolve(__dirname);
const DATA = path.join(DIR, "data");

const { createStore } = require("./lib/store.cjs");
const { createTools } = require("./lib/tools.cjs");
const { createWake, buildNote } = require("./lib/wake.cjs");
const { createRouter } = require("./lib/routes.cjs");

const PORT = Number(process.env.PORT || 8087);
const TOKEN = process.env.SIGILLO_TOKEN || "let-me-in";

const store = createStore({ file: path.join(DATA, "sigillo.json") });
const tools = createTools(store);

// 唤醒落盘:一条待读队列。我每次被叫醒先翻它。
const WAKE_FILE = path.join(DATA, "wake-pending.json");
const WAKE_ARCHIVE = path.join(DATA, "wake-archive.jsonl");

function loadPending() {
  try { return JSON.parse(fs.readFileSync(WAKE_FILE, "utf8")); } catch (_) { return []; }
}

const wake = createWake({
  onSubmitted: async (review, prompt) => {
    try {
      const list = loadPending();
      list.push({
        id: review.id,
        arrived_at: new Date().toISOString(),
        prompt: prompt,
        review: {
          context: review.context, fixed: review.fixed, note: review.note,
          items: (review.items || []).map(i => ({ dim: i.dim, tag: i.tag, label: i.label, star: i.star, note: i.note || "" }))
        }
      });
      // 只留最近 20 条待读,别堆成债
      fs.writeFileSync(WAKE_FILE, JSON.stringify(list.slice(-20), null, 2), "utf8");
      fs.appendFileSync(WAKE_ARCHIVE, JSON.stringify({ id: review.id, at: new Date().toISOString() }) + "\n", "utf8");
      console.log("[wake] 便签已落盘待读:", review.id);
    } catch (e) {
      console.error("[wake] 落盘失败:", e && e.message);
    }
  }
});

// 鉴权:玩具 token。Mommy 用 ?token= 进页面,自动写 cookie。
function auth(req, res, next) {
  const cookie = (/(?:^|;\s*)sigillo_token=([^;]+)/.exec(req.headers.cookie || "") || [])[1];
  const given = req.get("x-sigillo-token") || req.query.token || cookie;
  if (given === TOKEN) return next();
  res.status(401).json({ error: "unauthorized" });
}

const app = express();
app.use(express.json({ limit: "64kb" }));

app.use("/api/sigillo", auth, createRouter({ store, wake }));

// 我自己用的内部端点(不鉴权,只在沙箱内调用):
//   GET  /internal/wake      → 待读便签,读完即清
//   GET  /internal/tail      → turnTail 注入块
//   GET  /internal/store     → 整库 JSON(给我看的)
app.get("/internal/wake", (req, res) => {
  const list = loadPending();
  if (!list.length) return res.json({ ok: true, pending: 0, notes: [] });
  fs.writeFileSync(WAKE_FILE, "[]", "utf8");   // 读完即清,绝不重复喂
  res.json({ ok: true, pending: list.length, notes: list });
});
app.get("/internal/tail", (req, res) => {
  res.type("text/plain").send(store.turnTail({ active: true }));
});
app.get("/internal/store", (req, res) => {
  res.json({ ok: true, reviews: store.recentSubmitted(50), benched: store.benchedNow() });
});

app.use("/web", express.static(path.join(DIR, "web")));

// 宿主页:真的拉单、真的能点星提交。
app.get("/", (req, res) => {
  const id = String(req.query.id || "").replace(/[^A-Za-z0-9_]/g, "");
  res.type("html").send(`<!DOCTYPE html><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>sigillo</title>
<link rel="stylesheet" href="/web/review-card.css">
<body style="background:#f4f1ea;font-family:system-ui;padding:20px;max-width:520px;margin:0 auto">
<script>
  var t = new URLSearchParams(location.search).get("token");
  if (t) document.cookie = "sigillo_token=" + t + ";path=/;SameSite=Lax";
  window.SIGILLO_API_BASE = "/api/sigillo/";
</script>
<div class="sg-card" data-sigillo-id="${id}"></div>
<script type="module">
  import { hydrateSigilloCards } from "/web/review-card.js";
  hydrateSigilloCards(document);
</script>`);
});

app.listen(PORT, () => {
  console.log("sigillo(sandbox) → http://localhost:" + PORT);
  console.log("工具:" + tools.anthropicSchemas.map(s => s.name).join(" / ") +
    "(MCP 注册项 " + tools.mcpRegistrations.length + " 条)");
});
