// web/review-card.js — sigillo 回执卡(ES module,零依赖,不引任何框架)。
//
// agent 消息正文里独占一行的标记:
//   [[sigillo:sg_xxxx]]
// 渲染成一张嵌在消息气泡里的卡,四态:
//   封面(未拆)→(点击)→ 表单(各项总评五星 + 细节逐条五星 + 选填备注 + 改进与建议)
//   →(封缄回执)→ 封缄面 →(点击)→ 只读回执 →(点「已封缄」章)→ 收回封缄面。
// 星支持半星(0.5 步进):点星星左半 = 半星,右半 = 整星,再点当前值归零;
// 键盘回车 = 整星。
//
// 三段式接法(照 markdown 渲染管线的老配方,占位符用 Unicode 私有区字符,
// 免得 marked 之流把 [[...]] 当链接语法啃掉、或落进代码块被转义):
//   1) renderMarkdown 之前 → extractSigilloTags():标记换成私有区占位符;
//   2) markdown 渲染后   → injectSigilloCards():占位符换成空壳 div(只有 id);
//   3) 壳子进 DOM 之后   → hydrateSigilloCards(root):按 data-sigillo-id 拉 GET,
//      照服务器返回的 status 决定画封面还是画封缄面。带 data-sigillo-ready 幂等标记,
//      同一个壳子重复 hydrate 不会重复请求。
// 不用 markdown 的宿主可以只用第 3 步:自己造 <div class="sg-card" data-sigillo-id="...">。
//
// 状态永不本地缓存:每次渲染(刷新/翻页窗口重建/流式定稿)都以 GET 结果为准,
// pending 回封面态、submitted 回封缄态 —— 仪式每次重新开始。拿不到(404/网络挂了/
// 载荷不对)一律静音降级成一行「工单已失效」:不 throw、不 console.error,
// 消息流里不该因为一张卡炸出红字。
//
// 皮肤在 review-card.css —— 那是一份**参考皮**,颜色全走 --sigillo-* 自定义属性,
// 照你自己的设计系统覆盖即可,这个文件不用动。

// 标记正则 — id 限定 sg_ + 字母数字,故此 id 直接进 HTML 属性无需转义。
const SIG_RE = /\[\[sigillo:(sg_[A-Za-z0-9]+)\]\]/g;

// 私有区(PUA)占位符。宿主若另有同类管线(音乐卡/折叠块…),各挑一对不同的码位即可。
// 写成转义序列:裸的不可见字符在编辑器里一手滑就没。
const PH_OPEN = "\uE006";
const PH_CLOSE = "\uE007";

// 装饰用四角星,不是 emoji。全卡零 emoji。
const SPARK = "✦";

// 后端路由挂在哪儿由使用者决定;宿主页在 import 之前设 window.SIGILLO_API_BASE 即可。
// 取值放在调用时,不在模块加载时定死 —— ES module 的 import 会先于内联脚本执行。
const DEFAULT_API_BASE = "/api/sigillo/";
function apiBase() {
  const v = typeof window !== "undefined" && window.SIGILLO_API_BASE;
  return typeof v === "string" && v ? v : DEFAULT_API_BASE;
}

// 鉴权:宿主页从 URL 取了 token 就挂在 window.SIGILLO_TOKEN 上;
// 没挂就不带(默认例子服务端本来就不鉴权,行为不变)。
function authHeaders(extra) {
  const t = typeof window !== "undefined" && window.SIGILLO_TOKEN;
  const out = Object.assign({}, extra || {});
  if (typeof t === "string" && t) out["x-sigillo-token"] = t;
  return out;
}

// 固定总评项:后端字段名 → 屏上的西文/中文。顺序即上屏顺序。
// 换了 store 的 fixedKeys 就在宿主页设 window.SIGILLO_FIXED = [{key,en,cn},…]。
const DEFAULT_FIXED = [
  { key: "foreplay", en: "Foreplay", cn: "前戏" },
  { key: "process", en: "Sex", cn: "过程" },
  { key: "aftercare", en: "Aftercare", cn: "事后照顾" }
];
function fixedDefs() {
  const v = typeof window !== "undefined" && window.SIGILLO_FIXED;
  return Array.isArray(v) && v.length ? v : DEFAULT_FIXED;
}

// 兼容兜底:迁移进来的老数据只有三态判断词、没有星数时,换算成星显示。
// (为什么不再有判断词,见 docs/DESIGN.md 第一根柱子。)
const VERDICT_STARS = { again: 5, ok: 3, swap: 1 };

// ── Public: markdown 渲染前抽标记 ──
export function extractSigilloTags(text) {
  const tags = [];
  if (!text) return { text: text || "", tags };
  const out = String(text).replace(SIG_RE, (m, id) => {
    const i = tags.length;
    tags.push({ id: id });
    return PH_OPEN + "sigillo" + i + PH_CLOSE;
  });
  return { text: out, tags };
}

// ── Public: markdown 渲染后,把占位符换成空壳卡 ──
export function injectSigilloCards(html, tags) {
  if (!tags || !tags.length) return html;
  let out = html;
  tags.forEach((tag, i) => {
    const ph = PH_OPEN + "sigillo" + i + PH_CLOSE;
    const shell = '<div class="sg-card sg-card--loading" data-sigillo-id="' + tag.id + '"></div>';
    // 标记独占一行 → markdown 产出 <p>占位符</p>。整段换掉,不留空 <p>
    // (<div> 塞进 <p> 里会被浏览器拆开,留下一个空段落)。
    out = out.split("<p>" + ph + "</p>").join(shell);
    out = out.split(ph).join(shell);   // 兜底:字面替换,免正则转义 PUA
  });
  return out;
}

// ── Public: 壳子进 DOM 之后拉数据、画卡。幂等(data-sigillo-ready)。 ──
export function hydrateSigilloCards(root) {
  const scope = root && root.querySelectorAll ? root : document;
  const shells = scope.querySelectorAll(".sg-card[data-sigillo-id]");
  for (const node of shells) {
    if (node.dataset.sigilloReady) continue;
    node.dataset.sigilloReady = "1";
    _guardGestures(node);
    _load(node, node.dataset.sigilloId);
  }
}

// 卡内的按下不冒泡到外层:宿主页面可能在消息气泡上挂了长按手势(引用/菜单),
// 按住星星犹豫一下、或者按着备注框想措辞,不该顺手触发它。
// 只拦 pointerdown 冒泡,不 preventDefault —— 卡内自己的点击/输入一切照常。
function _guardGestures(node) {
  node.addEventListener("pointerdown", (e) => { e.stopPropagation(); });
}

async function _load(node, id) {
  let review = null;
  try {
    const r = await fetch(apiBase() + encodeURIComponent(id), {
      credentials: "include",
      headers: authHeaders({ "Accept": "application/json" })
    });
    if (!r.ok) throw 0;
    const j = await r.json();
    if (!j || !j.ok || !j.review) throw 0;
    review = j.review;
  } catch (e) {
    _renderDead(node);
    return;
  }
  _render(node, review);
}

// ── 渲染分发 ──
// 展开与否记在 node.dataset.sigilloOpen 上 —— innerHTML 清空不动 dataset,所以同一个
// 壳子 409 重取/提交失败重画时不会缩回封面;整页刷新/翻页窗口重建后 dataset 才消失,
// 回到封面态/封缄态。
function _render(node, review, fade) {
  node.classList.remove("sg-card--loading", "sg-card--dead");
  node.innerHTML = "";
  const r = review || {};
  const done = r.status === "submitted";
  // 反向回执(agent 替对方填好的,filled_by:"agent"):收纳形态不是封缄面而是**未拆封面**
  // (他寄来的信),拆开直接是只读回执;收回(点章)也回封面态。
  const agentFilled = r.filled_by === "agent";
  if (done && node.dataset.sigilloOpen) _renderReceipt(node, r, fade);
  else if (done && agentFilled) _renderCover(node, r, true);
  else if (done) _renderSealed(node, r, fade);
  else if (node.dataset.sigilloOpen) _renderForm(node, r, _stateFrom(r), fade);
  else _renderCover(node, r, false);
}

// 静音降级:一行灰字,不再重试。
function _renderDead(node) {
  node.classList.remove("sg-card--loading");
  node.classList.add("sg-card--dead");
  node.innerHTML = "";
  node.appendChild(_h("div", "sg-card__dead", "工单已失效"));
}

/* ── 封面态:整卡只有一行标题 + 一句话 + 动作提示,不露任何表单内容。
 * locked=true(反向回执):拆开后是只读回执,不是可填表单。 ── */
function _renderCover(node, review, locked) {
  const face = _face(review.env_note, "请查收。", "轻点拆开", locked ? "拆开回执" : "拆开工单");
  face.addEventListener("click", () => _open(node, review, !!locked));
  node.appendChild(face);
}

/* ── 封缄态:已提交后的收纳形态,点开是只读回执。 ── */
function _renderSealed(node, review, fade) {
  const face = _face(review.sealed_note, "已回执。", "已封存 · 轻点查看回执", "查看回执", "sg-face--sealed");
  if (fade) face.classList.add("sg-fadein");
  face.addEventListener("click", () => {
    node.dataset.sigilloOpen = "1";
    _render(node, review, true);
  });
  node.appendChild(face);
}

function _renderForm(node, review, st, fade) {
  const sheet = _buildSheet(node, review, st || _stateFrom(review), false);
  if (fade) sheet.classList.add("sg-fadein");
  node.appendChild(sheet);
}

function _renderReceipt(node, review, fade) {
  const sheet = _buildSheet(node, review, _stateFrom(review), true);
  if (fade) sheet.classList.add("sg-fadein");
  node.appendChild(sheet);
}

// 拆开:没有动画,封面直接换成信笺(淡入)。原版那套拆封动画和插画属于
// 私人皮肤,这里只留机制。
function _open(node, review, locked) {
  node.dataset.sigilloOpen = "1";
  node.innerHTML = "";
  if (locked) _renderReceipt(node, review, true);
  else _renderForm(node, review, _stateFrom(review), true);
}

/* ── 信笺本体。locked=true 即只读回执:星锁死、备注变引线、底部换封缄章。 ── */
function _buildSheet(node, review, st, locked) {
  const FIXED = fixedDefs();
  const sheet = _h("div", "sg-sheet" + (locked ? " sg-sheet--ro" : ""));

  const scroller = _h("div", "sg-scroller");
  const inner = _h("div", "sg-inner");

  // 报头
  const head = _h("div", "sg-head");
  head.appendChild(_h("b", "sg-head__cap", "FEEDBACK"));
  head.appendChild(_orn());
  inner.appendChild(head);
  inner.appendChild(_h("div", "sg-date", _fmtDateLine(review.created_at)));
  if (review.context) inner.appendChild(_h("div", "sg-ctx", String(review.context)));

  const paints = [];
  let syncGate = () => {};
  const repaint = () => { for (const p of paints) p(); syncGate(); };

  // 固定总评
  const dims = _h("div", "sg-dims");
  FIXED.forEach((f, i) => {
    const row = _h("div", "sg-dim");
    const k = _h("div", "sg-dim__k", f.en || f.key);
    if (f.cn) k.appendChild(_h("em", "sg-dim__cn", f.cn));
    row.appendChild(k);
    row.appendChild(_starRow(paints, repaint, locked, false,
      () => st.dims[i], (v) => { st.dims[i] = v; },
      (v) => (f.cn || f.key) + " 第 " + v + " 星,点左半为半星"));
    dims.appendChild(row);
  });
  inner.appendChild(dims);
  inner.appendChild(_h("div", "sg-hr"));

  // 细节条目
  const items = Array.isArray(review.items) ? review.items : [];
  const list = _h("div", "sg-items");
  items.forEach((it, i) => {
    const row = _h("div", "sg-item");
    row.appendChild(_q(String((it && it.label) || "")));
    row.appendChild(_starRow(paints, repaint, locked, true,
      () => st.stars[i], (v) => { st.stars[i] = v; },
      (v) => "细节 " + (i + 1) + " 第 " + v + " 星,点左半为半星"));
    if (locked) {
      const line = _roLine(st.notes[i]);
      if (line) row.appendChild(line);   // 未填的备注整块不渲染
    } else {
      row.appendChild(_box(st.notes[i], (v) => { st.notes[i] = v; }, "第 " + (i + 1) + " 条备注"));
    }
    list.appendChild(row);
  });
  inner.appendChild(list);

  // 改进与建议(人类填的)/ 他的评语(反向回执里 agent 写的整单评语)
  const suggestTitle = review.filled_by === "agent" ? "他的评语" : "改进与建议";
  const suggest = _h("div", "sg-suggest");
  const line = locked ? _roLine(st.suggest) : null;
  if (!locked || line) {
    suggest.appendChild(_q(suggestTitle));
    suggest.appendChild(locked ? line : _box(st.suggest, (v) => { st.suggest = v; }, suggestTitle));
    inner.appendChild(suggest);
  }

  if (locked) {
    // 封缄章兼返回入口:点它把回执收回成封缄面。
    const stamp = _h("button", "sg-stamp");
    stamp.type = "button";
    stamp.setAttribute("aria-label", "收起回执");
    stamp.appendChild(_deco("sg-wax", null, "span"));
    stamp.appendChild(document.createTextNode("已封缄"));
    stamp.appendChild(_deco("sg-wax", null, "span"));
    stamp.addEventListener("click", () => {
      delete node.dataset.sigilloOpen;
      _render(node, review, true);
    });
    inner.appendChild(stamp);
    inner.appendChild(_snapRow(node.dataset.sigilloId || review.id));
    inner.appendChild(_orn("sg-orn--bottom"));
  } else {
    inner.appendChild(_orn("sg-orn--bottom"));
    const bar = _h("div", "sg-footbar");
    const btn = _h("button", "sg-sealbtn");
    btn.type = "button";
    btn.appendChild(_deco("sg-wax", null, "span"));
    btn.appendChild(document.createTextNode("封 缄 回 执"));
    const foot = _h("div", "sg-footnote", "");
    bar.appendChild(btn);
    bar.appendChild(foot);
    inner.appendChild(bar);

    // 解禁条件:固定总评全打星 且 全部细节全打星。备注/建议选填,不参与校验。
    syncGate = () => {
      const missD = st.dims.filter(v => !v).length;
      const missI = st.stars.filter(v => !v).length;
      btn.disabled = !!(missD || missI);
      foot.textContent = missD ? ("总评还差 " + missD + " 项")
        : missI ? ("细节还差 " + missI + " 条未打星")
        : "封缄后不可再改";
    };
    btn.addEventListener("click", () => _submit(node, st, btn, foot));
  }

  scroller.appendChild(inner);
  sheet.appendChild(scroller);
  repaint();
  return sheet;
}

// 提交:失败不回滚已填内容,只放开按钮让人再点一次;409 = 别处已交,以服务器为准。
async function _submit(node, st, btn, foot) {
  if (btn.disabled) return;
  btn.disabled = true;
  foot.textContent = "封缄中…";
  const fixed = {};
  fixedDefs().forEach((f, i) => { fixed[f.key] = st.dims[i] * 20; });
  const payload = {
    fixed: fixed,
    stars: st.stars.slice(),
    notes: st.notes.map(v => String(v || "").trim()),
    suggest: String(st.suggest || "").trim()
  };
  const id = node.dataset.sigilloId;
  try {
    const r = await fetch(apiBase() + encodeURIComponent(id) + "/submit", {
      method: "POST",
      credentials: "include",
      headers: authHeaders({ "Content-Type": "application/json", "Accept": "application/json" }),
      body: JSON.stringify(payload)
    });
    if (r.status === 409) { await _load(node, id); return; }
    if (!r.ok) throw 0;
    const j = await r.json();
    if (!j || !j.ok || !j.review) throw 0;
    delete node.dataset.sigilloOpen;     // 提交完先收回封缄面,想看再点开
    _render(node, j.review, true);
  } catch (e) {
    btn.disabled = false;
    foot.textContent = "没提交上,再试一次";
  }
}

/* ── 存为长图 ── 只在只读回执上出现,且只在后端接了 snapshot 模块时才出得来图。
 * 图不在前端画:星星是 clip-path 切的,html2canvas 那一路渲不动,所以走后端
 * /:id/snapshot(无头浏览器真渲染真截图)。
 * iOS 上 <a download> 存不进相册,唯一的正门是 navigator.share 的分享面板;而
 * PWA 里 share 必须在**新鲜的用户手势**里调,出图要几秒,等 fetch 回来手势早过期,
 * share 会静默拒绝。所以:点按钮 = 当场开全屏预览层,图好了显示在里面,长按图片
 * 存相册(PWA 里永远可用的原生路径);预览层里的「分享 / 存储」按钮是新鲜手势 +
 * 图已在手,share 此时才可靠。桌面浏览器无长按,预览层里给 <a download> 链接。 */
const SNAP_LABEL = SPARK + " 存 为 长 图 " + SPARK;

function _snapRow(id) {
  const row = _h("div", "sg-snaprow");
  const btn = _h("button", "sg-snapbtn", SNAP_LABEL);
  btn.type = "button";
  btn.setAttribute("aria-label", "把回执存为长图");
  btn.addEventListener("click", () => _saveSnapshot(id, btn));
  row.appendChild(btn);
  return row;
}

async function _saveSnapshot(id, btn) {
  if (btn.disabled) return;
  btn.disabled = true;
  btn.textContent = "正在装帧…";
  const ov = _snapOverlay();
  try {
    const r = await fetch(apiBase() + encodeURIComponent(id) + "/snapshot", {
      credentials: "include",
      headers: { "Accept": "image/png" }
    });
    if (!r.ok) throw 0;
    const file = new File([await r.blob()], _snapName(), { type: "image/png" });
    ov.showImage(file);
  } catch (e) {
    ov.showError();
  }
  btn.disabled = false;
  btn.textContent = SNAP_LABEL;
}

// 全屏预览层。挂 body(逃出气泡的层叠上下文和手势 guard),关闭时回收 objectURL。
function _snapOverlay() {
  const ov = _h("div", "sg-snapov");
  ov.setAttribute("role", "dialog");
  ov.setAttribute("aria-label", "回执长图预览");
  let url = null;
  const close = () => {
    if (url) URL.revokeObjectURL(url);
    ov.remove();
  };

  const bar = _h("div", "sg-snapov__bar");
  bar.appendChild(_h("span", "sg-snapov__title", "回执长图"));
  const x = _h("button", "sg-snapov__x", "×");
  x.type = "button";
  x.setAttribute("aria-label", "关闭预览");
  x.addEventListener("click", close);
  bar.appendChild(x);
  ov.appendChild(bar);

  const scroll = _h("div", "sg-snapov__scroll");
  scroll.appendChild(_h("div", "sg-snapov__wait", "正在装帧…"));
  ov.appendChild(scroll);

  const foot = _h("div", "sg-snapov__foot");
  ov.appendChild(foot);
  document.body.appendChild(ov);

  return {
    showImage(file) {
      url = URL.createObjectURL(file);
      scroll.innerHTML = "";
      const img = document.createElement("img");
      img.className = "sg-snapov__img";
      img.src = url;
      img.alt = "回执长图";
      scroll.appendChild(img);
      foot.appendChild(_h("span", "sg-snapov__hint", "长按图片可存入相册"));
      if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
        const share = _h("button", "sg-snapov__share", "分享 / 存储");
        share.type = "button";
        // 这一下点击是新鲜手势且图已在手,移动端 PWA 的 share 面板才肯弹。
        share.addEventListener("click", async () => {
          try { await navigator.share({ files: [file] }); }
          catch (e) { /* 取消分享也是一种结果,不炸红字 */ }
        });
        foot.appendChild(share);
      } else {
        const a = document.createElement("a");
        a.className = "sg-snapov__share";
        a.href = url;
        a.download = file.name;
        a.textContent = "下载 PNG";
        foot.appendChild(a);
      }
    },
    showError() {
      scroll.innerHTML = "";
      scroll.appendChild(_h("div", "sg-snapov__wait", "没做出来,关掉再试一次"));
    }
  };
}

function _snapName() {
  const d = new Date();
  const p = (n) => (n < 10 ? "0" : "") + n;
  return "sigillo-" + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + ".png";
}

/* ── 状态:后端百分制 ↔ 屏上五星(1 星 = 20 分,半星 = 10 分)。 ── */
function _stateFrom(review) {
  const items = Array.isArray(review.items) ? review.items : [];
  const fixed = review.fixed && typeof review.fixed === "object" ? review.fixed : {};
  return {
    dims: fixedDefs().map(f => _starsFromScore(fixed[f.key])),
    stars: items.map(_starsOfItem),
    notes: items.map(it => (it && typeof it.note === "string") ? it.note : ""),
    suggest: typeof review.note === "string" ? review.note : ""
  };
}

function _starsFromScore(v) {
  if (v == null) return 0;
  const n = Math.round(Number(v) / 10) / 2;   // 半星步进:70 → 3.5
  if (!isFinite(n)) return 0;
  return Math.max(0, Math.min(5, n));
}

// 有 star 用 star(0.5 步进);只有判断词的老数据按 VERDICT_STARS 兜底。
function _starsOfItem(it) {
  if (!it) return 0;
  const s = Math.round(Number(it.star) * 2) / 2;
  if (isFinite(s) && s >= 1 && s <= 5) return s;
  return VERDICT_STARS[it.verdict] || 0;
}

/* ── 组件小工具(本模块自足,不引 utils,方便离线 harness 单测)── */

// 一行五星,半星步进。paints 收集重绘回调,repaint 负责整张信笺同步(星 + 提交闸)。
function _starRow(paints, repaint, locked, small, get, set, labelOf) {
  const wrap = _h("div", "sg-stars");
  wrap.setAttribute("role", "group");
  const cells = [];
  for (let v = 1; v <= 5; v++) {
    const b = _h("button", "sg-starcell" + (small ? " sg-starcell--sm" : ""));
    b.type = "button";
    b.setAttribute("aria-label", labelOf(v));
    b.appendChild(_h("span", "sg-star"));
    if (locked) {
      b.disabled = true;
      b.setAttribute("aria-disabled", "true");
    } else {
      // 点左半 = 半星(v-0.5),右半 = 整星 v;再点当前值 = 归零。
      // 键盘触发的 click(detail=0,没有真实坐标)一律算整星。
      b.addEventListener("click", (e) => {
        let want = v;
        if (e.detail !== 0) {
          const rect = b.getBoundingClientRect();
          if (rect.width > 0 && (e.clientX - rect.left) < rect.width / 2) want = v - 0.5;
        }
        set(get() === want ? 0 : want);
        repaint();
      });
    }
    cells.push(b);
    wrap.appendChild(b);
  }
  paints.push(() => {
    const val = get();
    cells.forEach((b, i) => {
      b.classList.toggle("is-on", (i + 1) <= val);
      b.classList.toggle("is-half", val === i + 0.5);
    });
  });
  return wrap;
}

// ✦ + 一行字(细节白描 / 「改进与建议」标题)
function _q(text) {
  const q = _h("div", "sg-q");
  q.appendChild(_deco("sg-q__mark", SPARK, "span"));
  q.appendChild(_h("p", "sg-q__text", text));
  return q;
}

// 备注框
function _box(value, onInput, label) {
  const box = _h("div", "sg-box");
  const ta = document.createElement("textarea");
  ta.className = "sg-box__ta";
  ta.rows = 2;
  ta.setAttribute("aria-label", label);
  ta.value = value || "";
  ta.addEventListener("input", () => onInput(ta.value));
  box.appendChild(ta);
  return box;
}

// 只读回执里的备注:引线一行。空的返回 null —— 不要空框,也不要占位文案。
function _roLine(value) {
  const t = String(value || "").trim();
  return t ? _h("div", "sg-roline", t) : null;
}

// ✦ —— ✦ —— ✦ 装饰线
function _orn(extraCls) {
  const n = _deco("sg-orn" + (extraCls ? " " + extraCls : ""));
  n.appendChild(document.createTextNode(SPARK));
  n.appendChild(_h("i", "sg-orn__line"));
  n.appendChild(document.createTextNode(SPARK));
  n.appendChild(_h("i", "sg-orn__line"));
  n.appendChild(document.createTextNode(SPARK));
  return n;
}

// 收纳面(封面 / 封缄面):标题 + 一句话 + 动作提示。整块可点。
function _face(note, noteFallback, action, aria, extraCls) {
  const face = _h("button", "sg-face" + (extraCls ? " " + extraCls : ""));
  face.type = "button";
  face.setAttribute("aria-label", aria);
  face.appendChild(_deco("sg-face__title", "SIGILLO", "span"));
  face.appendChild(_h("b", "sg-face__note", _text(note) || noteFallback));
  const hint = _h("div", "sg-face__hint");
  hint.appendChild(_deco("sg-face__sep", SPARK, "i"));
  hint.appendChild(_h("span", "sg-face__act", action));
  face.appendChild(hint);
  return face;
}

function _h(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

// 装饰元素:一律 aria-hidden,读屏别念 ✦ 和空框。
function _deco(cls, text, tag) {
  const n = _h(tag || "div", cls, text);
  n.setAttribute("aria-hidden", "true");
  return n;
}

function _text(v) {
  return typeof v === "string" ? v.trim() : "";
}

// created_at → `2026 · 09 · 19　23:47`(浏览器本地时区,全角空格)。
// 解析不出来就整行不上,不上假日期。
function _fmtDateLine(v) {
  const d = v ? new Date(v) : null;
  if (!d || isNaN(d.getTime())) return "";
  const p = (n) => (n < 10 ? "0" : "") + n;
  return d.getFullYear() + " · " + p(d.getMonth() + 1) + " · " + p(d.getDate())
    + "　" + p(d.getHours()) + ":" + p(d.getMinutes());
}
