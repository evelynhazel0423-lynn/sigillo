"use strict";
// 门面:把五个工厂函数摆在一起,省得逐个 require。
// 每个模块自己也能单独 require —— 只想要数据层的话 require("sigillo/lib/store.cjs")
// 就够了,不会顺带拖进 express / zod / playwright(那三个都是惰性加载的)。
module.exports = {
  createStore: require("./lib/store.cjs").createStore,
  createTools: require("./lib/tools.cjs").createTools,
  createWake: require("./lib/wake.cjs").createWake,
  createRouter: require("./lib/routes.cjs").createRouter,
  createSnapshot: require("./lib/snapshot.cjs").createSnapshot,
  buildNote: require("./lib/wake.cjs").buildNote,
  DEFAULT_DIMS: require("./lib/store.cjs").DEFAULT_DIMS
};
