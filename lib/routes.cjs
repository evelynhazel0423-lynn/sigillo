"use strict";
// lib/routes.cjs — 卡片用的三条 HTTP 端点,打包成一个 express.Router。
//
//   const router = createRouter({ store, wake, snapshot });
//   app.use("/api/sigillo", myAuthMiddleware, router);
//
// 路由内部只有相对路径(/:id、/:id/submit、/:id/snapshot),挂在哪儿由你决定 ——
// 前端把 window.SIGILLO_API_BASE 指到同一个前缀即可。
//
// **鉴权不内置**:这是一份私密数据,但怎么认人是你那套系统的事(cookie / session /
// 反代的 basic auth 都行)。像上面那样把你自己的中间件挂在 router 前面。
// express 是可选 peer dependency,这里惰性 require —— 只用 lib/store 的人不该被
// 强迫装一个 web 框架。
//
// 路由只负责状态码映射,业务错误的人话文案原样透传给前端:
//   404 = 没这张单 / 409 = 已经交过了 / 400 = 载荷不合法。

function createRouter(options) {
  const o = options || {};
  const store = o.store;
  if (!store) throw new Error("createRouter 需要 { store }");
  const wake = o.wake || null;
  const snapshot = typeof o.snapshot === "function" ? o.snapshot : null;

  let express;
  try {
    express = require("express");
  } catch (_) {
    throw new Error("createRouter 需要 express(peer dependency):npm i express");
  }
  const router = express.Router();

  router.get("/:id", (req, res) => {
    try {
      const review = store.getReview(req.params.id);
      if (!review) return res.status(404).json({ error: "not found" });
      res.json({ ok: true, review: review });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post("/:id/submit", (req, res) => {
    try {
      const review = store.submitReview(req.params.id, req.body || {});
      res.json({ ok: true, review: review });
      // 封缄成功 → 唤醒 agent 看回执 + 用 sigillo_note 落主观复盘。
      // setImmediate 且不 await:提交的响应已经发出去了,唤醒慢/挂都不该让人干等。
      if (wake && typeof wake.notifySubmitted === "function") {
        setImmediate(() => {
          try {
            const p = wake.notifySubmitted(review);
            if (p && typeof p.catch === "function") {
              p.catch((e) => console.error("[sigillo:wake]", e && e.message));
            }
          } catch (e) {
            console.error("[sigillo:wake]", e && e.message);
          }
        });
      }
    } catch (e) {
      if (e.code === "already_submitted") return res.status(409).json({ error: "already submitted" });
      if (e.code === "not_found") return res.status(404).json({ error: "not found" });
      res.status(400).json({ error: e.message });
    }
  });

  // 回执存为长图:服务端无头浏览器渲染完整展开的只读回执 → PNG。
  // 卡上的星形是 clip-path 画的,客户端截图库渲不动,所以图只能在这边出。
  // 出图慢(2~5s)且不可缓存,no-store。没接 snapshot 模块就当这条路不存在。
  router.get("/:id/snapshot", async (req, res) => {
    if (!snapshot) return res.status(404).json({ ok: false, error: "snapshot not enabled" });
    try {
      const review = store.getReview(req.params.id);
      if (!review) return res.status(404).json({ ok: false, error: "not found" });
      if (review.status !== "submitted") {
        return res.status(400).json({ ok: false, error: "还没封缄,没有回执可存" });
      }
      const png = await snapshot(review);
      res.set("Cache-Control", "no-store");
      res.type("png").send(png);
    } catch (e) {
      console.error("[sigillo:snapshot]", e && e.message);
      res.status(500).json({ ok: false, error: "生成失败,再试一次" });
    }
  });

  return router;
}

module.exports = { createRouter: createRouter };
