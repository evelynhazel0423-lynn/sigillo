"use strict";
// lib/snapshot.cjs —— 只读回执 → 高清长图(PNG Buffer)。**可选模块**。
//
//   const snapshot = createSnapshot();            // 默认渲染仓库自带的 web/
//   const png = await snapshot(review);           // → Buffer
//   createRouter({ store, wake, snapshot });      // 挂上就有 GET /:id/snapshot
//
// 为什么要服务端出图:回执那张纸用 clip-path 画星星,html2canvas 那一路的客户端
// 截图库渲不出来,所以改走无头 Chromium 真渲染真截图。playwright 是可选依赖,
// 这里惰性 require —— 不存图的人不该为它付出安装成本,也不该把它拖进常驻内存。
//
// 零鉴权依赖:无头浏览器没有你的 cookie,也不该去闯你的登录页。所以整页
// route("**/*") 全量拦截 —— 静态资源直接从磁盘 fulfill,单据 JSON 用调用方传进来的
// review 现编(不回头查库,避免和调用方看到的不一致),其余请求默认掐掉。
// URL 里的域名只是个壳,没有一个字节真的经过网络。
//
// 渲染用的是**同一份前端模块**(web/snapshot.html 里 import web/review-card.js),
// 不复制任何渲染逻辑:卡片改版,长图自动跟着改。
const fs = require("fs");
const path = require("path");

const WEB_MOUNT = "/web/";
const PAGE_PATH = WEB_MOUNT + "snapshot.html";

// 430×900 = 手机逻辑视口;3x 是为了存进相册后放大也不糊(长图按内容真实高度出)。
const VIEWPORT = { width: 430, height: 900 };
const SCALE = 3;

const READY_MS = 15000;   // 页内 __snapReady 的等待上限
const TOTAL_MS = 30000;   // 单次出图的总闸(含 launch/close)

// fulfill 用的 content-type 表。回执只会用到 html/css/js,其余是顺手兜底。
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff"
};

function createSnapshot(options) {
  const o = options || {};
  const WEB_DIR = path.resolve(o.webDir || path.join(__dirname, "..", "web"));
  const API_PREFIX = o.apiPrefix || "/api/sigillo/";
  const ORIGIN = o.origin || "http://sigillo.local";
  const viewport = o.viewport || VIEWPORT;
  const scale = typeof o.scale === "number" ? o.scale : SCALE;
  const readyMs = typeof o.readyMs === "number" ? o.readyMs : READY_MS;
  const totalMs = typeof o.totalMs === "number" ? o.totalMs : TOTAL_MS;
  // 默认掐掉一切外部请求。自己改了 web/ 想引外链字体的话把它打开。
  const allowNetwork = o.allowNetwork === true;

  // 并发闸:手抖双击不该同时开两个浏览器(内存直接翻倍)。模块级单条 Promise 链,
  // 后来的排队等前一位跑完;链子只关心「上一位结束了」,不关心成败 —— 所以续链时
  // 先 catch 掉,免得一次失败把后面所有请求一起毒死。
  let chain = Promise.resolve();

  function snapshot(review) {
    const next = chain.then(function () { return withTimeout(run(review), totalMs); });
    chain = next.catch(function () {});
    return next;
  }

  async function run(review) {
    // 懒加载:没人存图的时候不把 playwright(以及它那一大坨)拖进常驻内存。
    let chromium;
    try {
      chromium = require("playwright").chromium;
    } catch (_) {
      throw new Error("存长图需要 playwright(optional dependency):npm i playwright && npx playwright install chromium");
    }

    const id = String((review && review.id) || "");
    // id 直接拼进 URL 和拦截器的比较串,先钉死形状(store 的 genId 就是这个形状)。
    if (!/^sg_[A-Za-z0-9]+$/.test(id)) throw new Error("review.id 不合法");

    const browser = await chromium.launch({ headless: true });
    try {
      const ctx = await browser.newContext({ viewport: viewport, deviceScaleFactor: scale });
      const page = await ctx.newPage();
      await page.route("**/*", function (route) { return handle(route, id, review); });
      // commit 即可:剩下的等待全交给页内的 __snapReady(它自己等字体和图片解码)。
      // api 参数告诉页面去哪儿拉这张单(拦截器就按这个前缀喂 JSON),两边同源同值。
      const url = ORIGIN + PAGE_PATH + "?id=" + encodeURIComponent(id) +
        "&api=" + encodeURIComponent(API_PREFIX);
      await page.goto(url, { waitUntil: "commit" });
      await page.waitForFunction("window.__snapReady === true", null, { timeout: readyMs });
      return await page.locator("#snap").screenshot({ type: "png" });
    } finally {
      // close 失败不能盖掉真正的异常(浏览器已经崩了的场景)。
      await browser.close().catch(function () {});
    }
  }

  // 路由拦截:三条分支,顺序即优先级。
  async function handle(route, id, review) {
    let pathname;
    try {
      pathname = new URL(route.request().url()).pathname;
    } catch (_) {
      return allowNetwork ? route.continue() : route.abort();
    }

    // 1) 这张单的数据:用传进来的 review,不回头查库。
    if (pathname === API_PREFIX + id) {
      return route.fulfill({
        status: 200,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify({ ok: true, review: review })
      });
    }

    // 2) 站内静态资源:直接读盘喂进去,绕开任何鉴权。
    if (pathname.startsWith(WEB_MOUNT)) {
      return fromDisk(route, pathname);
    }

    // 3) 其余:默认掐掉。
    return allowNetwork ? route.continue() : route.abort();
  }

  function fromDisk(route, pathname) {
    let abs;
    try {
      abs = path.resolve(WEB_DIR, decodeURIComponent(pathname.slice(WEB_MOUNT.length)));
    } catch (_) {
      return route.fulfill({ status: 400, body: "" });
    }
    // 路径穿越防护:resolve 之后必须仍在 web 目录内,越界一律 404。
    if (!abs.startsWith(WEB_DIR + path.sep)) return route.fulfill({ status: 404, body: "" });

    let buf;
    try {
      buf = fs.readFileSync(abs);
    } catch (_) {
      return route.fulfill({ status: 404, body: "" });
    }
    return route.fulfill({
      status: 200,
      contentType: MIME[path.extname(abs).toLowerCase()] || "application/octet-stream",
      body: buf
    });
  }

  return snapshot;
}

// 超时看门狗:定时器必须清,否则 node 会被吊住 30s 不退出(脚本会卡)。
function withTimeout(p, ms) {
  let timer = null;
  const guard = new Promise(function (_, reject) {
    timer = setTimeout(function () { reject(new Error("快照超时(" + ms + "ms)")); }, ms);
  });
  return Promise.race([p, guard]).finally(function () { if (timer) clearTimeout(timer); });
}

module.exports = { createSnapshot: createSnapshot };
