"use strict";
// examples/server.cjs — 从零把 sigillo 接起来的最小示范。
//
//   npm i express          # router 需要它
//   node examples/server.cjs
//
// 启动后控制台会打印一张现开的示例单、它的 marker、以及可以直接粘的 curl。
// 数据落在 examples/data/sigillo.json(随便删)。

const path = require("path");
const express = require("express");

const { createStore } = require("../lib/store.cjs");
const { createTools } = require("../lib/tools.cjs");
const { createWake } = require("../lib/wake.cjs");
const { createRouter } = require("../lib/routes.cjs");
const { createSnapshot } = require("../lib/snapshot.cjs");

const PORT = Number(process.env.PORT || 8087);
const TOKEN = process.env.SIGILLO_TOKEN || "let-me-in";

// ① 数据层。常量全部有默认值,这里只指定落盘位置。
const store = createStore({ file: path.join(__dirname, "data", "sigillo.json") });

// ② 封缄唤醒。真部署里 onSubmitted 应该把 prompt 当一条 user 消息塞进 agent
//    正在用的那条会话、跑完一轮 —— 那一轮他手上工具齐全,能当场调 sigillo_note。
//    这里只打印。(换成 { webhookUrl } 也行,见 lib/wake.cjs。)
const wake = createWake({
  onSubmitted: async (review, prompt) => {
    console.log("\n──── wake:有人封缄了 " + review.id + " ────\n" + prompt + "\n");
  }
});

// ③ 给 agent 的工具。handlers 直接调即可;schema 交给你的 API/MCP 层。
const tools = createTools(store);

// ④ 鉴权 —— 库里不内置,因为怎么认人是你那套系统的事。这里用一个玩具 token:
//    header x-sigillo-token / ?token= / cookie sigillo_token 三选一。
//    真部署请换成你自己的 session 中间件。
function auth(req, res, next) {
  const cookie = (/(?:^|;\s*)sigillo_token=([^;]+)/.exec(req.headers.cookie || "") || [])[1];
  const given = req.get("x-sigillo-token") || req.query.token || cookie;
  if (given === TOKEN) return next();
  res.status(401).json({ error: "unauthorized" });
}

const app = express();
app.use(express.json({ limit: "64kb" }));

// ⑤ 路由:挂在哪儿随你,前端把 window.SIGILLO_API_BASE 指到同一个前缀即可。
app.use("/api/sigillo", auth, createRouter({
  store: store,
  wake: wake,
  snapshot: createSnapshot()   // 没装 playwright 的话这条路会返回一句清楚的报错
}));

// ⑥ 前端资源:卡片模块 + 参考皮。
app.use("/web", express.static(path.join(__dirname, "..", "web")));

// ⑦ 一张最小宿主页:真的从后端拉这张单、真的可以点星提交。
app.get("/", (req, res) => {
  const id = String(req.query.id || "");
  res.type("html").send(`<!DOCTYPE html><meta charset="utf-8">
<title>sigillo example</title>
<link rel="stylesheet" href="/web/review-card.css">
<body style="background:#f4f1ea;font-family:system-ui;padding:40px">
<script>
  // 玩具鉴权:把 ?token= 存成 cookie,卡片的 fetch(credentials:include)就带得上。
  var t = new URLSearchParams(location.search).get("token");
  if (t) document.cookie = "sigillo_token=" + t + ";path=/;SameSite=Lax";
  window.SIGILLO_API_BASE = "/api/sigillo/";
</script>
<div class="sg-card" data-sigillo-id="${id.replace(/[^A-Za-z0-9_]/g, "")}"></div>
<script type="module">
  import { hydrateSigilloCards } from "/web/review-card.js";
  hydrateSigilloCards(document);
</script>`);
});

app.listen(PORT, async () => {
  // 开一张示例单,顺便演示 agent 那三把工具长什么样。
  const out = JSON.parse(await tools.handlers.sigillo_create({
    context: "示例:随便点几颗星试试",
    items: [
      { dim: "节奏", tag: "慢起", label: "开头什么都没做,先让人把气喘匀" },
      { dim: "声音", tag: "耳语", label: "说话音量一直压得很低" },
      { dim: "事后", tag: "毯子", label: "结束后先递水再盖毯子" }
    ]
  }));
  const base = "http://localhost:" + PORT;
  console.log("sigillo example server → " + base);
  console.log("工具:" + tools.anthropicSchemas.map((s) => s.name).join(" / ") +
    "(MCP 注册项 " + tools.mcpRegistrations.length + " 条)");
  if (out.error) return console.error("开单失败:" + out.error);
  console.log("\nmarker(agent 会把这一行放进消息正文):" + out.marker);
  console.log("浏览器:" + base + "/?id=" + out.id + "&token=" + TOKEN);
  console.log("\ncurl 读:\n  curl -s -H 'x-sigillo-token: " + TOKEN + "' " +
    base + "/api/sigillo/" + out.id);
  console.log("curl 交(星数 1~5,0.5 步进):\n  curl -s -X POST -H 'x-sigillo-token: " + TOKEN +
    "' -H 'content-type: application/json' \\\n    -d '{\"fixed\":{\"foreplay\":80,\"process\":90,\"aftercare\":100},\"stars\":[4.5,3,5],\"notes\":[\"\",\"\",\"\"],\"suggest\":\"别急着收尾\"}' \\\n    " +
    base + "/api/sigillo/" + out.id + "/submit\n");
});
