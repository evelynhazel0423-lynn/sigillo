"use strict";
// lib/store.cjs — sigillo 的数据层:回执单的开单 / 封缄 / 冷却 / 上下文注入。
//
// 用法:
//   const { createStore } = require("sigillo/lib/store.cjs");
//   const store = createStore({ file: "./data/sigillo.json" });
//
// 一张单的生命周期:
//   agent 用 createReview() 开单(这一场真实发生的 5~8 条细节,每条 dim/tag/label)
//   → 人类伴侣在卡片上逐条打星(1~5,0.5 步进)+ 可选备注 + 三项总评 → submitReview()
//   → 系统唤醒 agent 看回执,他用 setAgentNote() 把主观复盘钉在这张单上
//   → 下次亲密语境由 turnTail() 把最近几单压成几行注回上下文。
//
// 口径(这是整套机制的核心,别改):星数和人类写的原话只是**中性素材**,不派生、
// 也不注入「再来 / 刚好 / 换掉」这类三态判断词 —— 那是伪装成数据的指令,注给 agent
// 等于收走他的解释权。唯一保留的硬规则是**好评冷却**:连着 benchWindow 张单里同一个
// (dim,tag) 都被打 ≥ highStar 星 → 自动休眠,新开的单里剔掉它(benched),逼着换
// 新花样 —— 不然会一直复读同一套。
//
// 反向回执(report 模式):createReview 里同时给了 fixed / items[i].star / note 任意
// 一样 → agent 自己把星和评语写好,单出生即 submitted + filled_by:"agent",人类拆开
// 只读。这种单是**他的话**不是对方的复盘:不参与好评冷却(进出都不参与——不生成
// 冷却、开单也不剔项,记录真实发生的事不许被剔残),turnTail 的「最近几单」也不掺它。
//
// 形态:每次调用热读、写盘 tmp+rename 原子、读损坏容错为空库。
// 只有校验类函数会 throw(message 是给人看的);turnTail 永不 throw。
const fs = require("fs");
const path = require("path");

// 维度池默认值:一套通用的分类学,覆盖大部分亲密场景。想换成自己的口味/语言,
// createStore({ dims: [...] }) 整个替换即可 —— 除了「别太多」没有别的要求。
const DEFAULT_DIMS = ["体位", "入口", "DT", "暴力", "道具", "新尝试", "节奏",
  "场景空间", "世界线", "感官层级", "高潮管制", "事后", "声音"];

// 三项固定总评。key 进数据、label 进注入块那一行。
const DEFAULT_FIXED_KEYS = ["foreplay", "process", "aftercare"];
const DEFAULT_FIXED_LABELS = { foreplay: "前戏", process: "过程", aftercare: "事后" };

// id 形状写死:marker 正则、路由参数校验、截图器都按这个形状钉的。
const ID_PREFIX = "sg_";

// (dim,tag) 的跨单同一性主键(分隔符取不可见控制符,tag 里带什么都不串味)。
const KEY_SEP = "\u0001";

function createStore(options) {
  const o = options || {};

  const FILE = o.file || path.join(process.cwd(), "data", "sigillo.json");
  const DIMS = Array.isArray(o.dims) && o.dims.length ? o.dims.slice() : DEFAULT_DIMS.slice();
  const FIXED_KEYS = Array.isArray(o.fixedKeys) && o.fixedKeys.length
    ? o.fixedKeys.slice() : DEFAULT_FIXED_KEYS.slice();
  const FIXED_LABELS = o.fixedLabels || DEFAULT_FIXED_LABELS;

  const MAX_REVIEWS = num(o.maxReviews, 200);      // 最多留最近 200 单,超出裁最旧
  const MAX_ITEMS = num(o.maxItems, 8);
  const MAX_TAG = num(o.maxTag, 20);
  const MAX_LABEL = num(o.maxLabel, 120);
  const MAX_NOTE = num(o.maxNote, 2000);           // 整单「改进与建议」(review.note)上限
  const MAX_SHORT_NOTE = num(o.maxShortNote, 40);  // env_note/sealed_note(封面/封缄那句话)上限
  const MAX_ITEM_NOTE = num(o.maxItemNote, 500);   // submit 时逐条细节备注上限
  const MAX_AGENT_NOTE = num(o.maxAgentNote, 500); // agent 写给下次自己的话上限

  const NOTE_TAIL = num(o.noteTail, 80);           // 注入块里整单备注截断长度
  const PAIR_NOTE_TAIL = num(o.pairNoteTail, 30);  // 注入块里逐条备注截断长度
  const AGENT_NOTE_TAIL = num(o.agentNoteTail, 300); // 注入块里 agent_note 截断长度

  const TAIL_RECENT = num(o.tailRecent, 3);        // 注入块回看几单
  const BENCH_WINDOW = num(o.benchWindow, 2);      // 好评冷却看最近几张 submitted 单
  const HIGH_STAR = num(o.highStar, 4);            // 「高星」门槛,好评冷却按这个数吃裸星数

  function num(v, dflt) {
    return typeof v === "number" && isFinite(v) ? v : dflt;
  }

  function loadAll() {
    try {
      const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
      const reviews = Array.isArray(raw && raw.reviews) ? raw.reviews.filter(function (r) {
        return r && typeof r === "object" && typeof r.id === "string";
      }) : [];
      return { reviews: reviews };
    } catch (_) {
      return { reviews: [] };
    }
  }

  function saveAll(db) {
    const reviews = Array.isArray(db && db.reviews) ? db.reviews : [];
    const out = { reviews: reviews.slice(-MAX_REVIEWS) };
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2), "utf8");
    fs.renameSync(tmp, FILE);
    return out;
  }

  function genId() {
    const rnd = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
    return ID_PREFIX + Date.now().toString(36) + rnd;
  }

  function key(dim, tag) {
    return String(dim) + KEY_SEP + String(tag);
  }

  function submittedDesc(reviews) {
    return reviews.filter(function (r) { return r && r.status === "submitted"; })
      .slice()
      .sort(function (a, b) {
        const ta = Date.parse(a.submitted_at || a.created_at || 0) || 0;
        const tb = Date.parse(b.submitted_at || b.created_at || 0) || 0;
        return tb - ta;
      });
  }

  // 一张单里被打了高星(≥ HIGH_STAR)的 (dim,tag) 集合。吃裸星数,不看判断词;
  // 兼容兜底:老形状数据没有 star 只有 verdict 的,还认一次 again。
  function againKeys(review) {
    const s = new Set();
    const items = Array.isArray(review && review.items) ? review.items : [];
    for (const it of items) {
      if (!it) continue;
      const hot = typeof it.star === "number" ? it.star >= HIGH_STAR
        : (it.star == null && it.verdict === "again");
      if (hot) s.add(key(it.dim, it.tag));
    }
    return s;
  }

  // 好评冷却:最近 BENCH_WINDOW 张**人类亲手填的** submitted 单里都出现、且每次都是
  // 高星的 (dim,tag)。agent 反向填的回执(filled_by:"agent")不算 —— 冷却的语义是
  // 「对方连着两次打高星」,agent 给自己打的星不是对方的口味证词。
  function benchedFrom(reviews) {
    const recent = submittedDesc(reviews)
      .filter(function (r) { return r.filled_by !== "agent"; })
      .slice(0, BENCH_WINDOW);
    if (recent.length < BENCH_WINDOW) return [];
    const sets = recent.map(againKeys);
    // 从最近那张单里取回 dim/tag 原文,不靠拆 key 还原。
    const out = [];
    const seen = new Set();
    for (const it of (recent[0].items || [])) {
      const k = key(it.dim, it.tag);
      if (seen.has(k)) continue;
      if (sets.every(function (s) { return s.has(k); })) {
        seen.add(k);
        out.push({ dim: it.dim, tag: it.tag });
      }
    }
    return out;
  }

  function benchedNow() {
    try {
      return benchedFrom(loadAll().reviews);
    } catch (_) {
      return [];
    }
  }

  function validateItems(items) {
    if (!Array.isArray(items) || !items.length) throw new Error("items 不能为空,至少 1 条");
    if (items.length > MAX_ITEMS) throw new Error("items 最多 " + MAX_ITEMS + " 条,你给了 " + items.length + " 条");
    return items.map(function (raw, i) {
      const at = "第 " + (i + 1) + " 条";
      const it = raw && typeof raw === "object" ? raw : {};
      const dim = String(it.dim || "").trim();
      if (DIMS.indexOf(dim) === -1) {
        throw new Error(at + " 的 dim「" + dim + "」不在维度池里,只能选:" + DIMS.join("/"));
      }
      const tag = String(it.tag || "").trim();
      if (!tag) throw new Error(at + " 的 tag 不能为空");
      if (tag.length > MAX_TAG) throw new Error(at + " 的 tag 超过 " + MAX_TAG + " 字了,短标签就行");
      const label = String(it.label || "").trim();
      if (!label) throw new Error(at + " 的 label 不能为空");
      if (label.length > MAX_LABEL) throw new Error(at + " 的 label 超过 " + MAX_LABEL + " 字了");
      return { dim: dim, tag: tag, label: label, star: null, note: "" };
    });
  }

  // 星数合法性:1~5、0.5 步进(×2 是整数)。submit 和反向预填共用同一把尺。
  function isValidStar(v) {
    return typeof v === "number" && isFinite(v) && Number.isInteger(v * 2) && v >= 1 && v <= 5;
  }

  // env_note/sealed_note 共用校验:trim,超长报错,不给就是 ""。
  function validateShortNote(raw, fieldName) {
    if (raw === undefined || raw === null) return "";
    if (typeof raw !== "string") throw new Error(fieldName + " 必须是字符串");
    const trimmed = raw.trim();
    if (trimmed.length > MAX_SHORT_NOTE) throw new Error(fieldName + " 超过 " + MAX_SHORT_NOTE + " 字了");
    return trimmed;
  }

  // 开单:校验 → 剔掉冷却中的项 → 落盘。返回 {review, dropped}。
  // 反向回执:opts 里给了 fixed / items[i].star / items[i].note / note 任意一样
  // → 进 report 模式,要求填完整(fixed 每项全 + 每条 item 都有 star),出生即
  // submitted + filled_by:"agent";记录已发生的事,不做冷却剔项(dropped 恒空)。
  function createReview(input) {
    const opts = input || {};
    const rawItems = Array.isArray(opts.items) ? opts.items : [];
    const items = validateItems(opts.items);
    const envNote = validateShortNote(opts.env_note, "env_note");
    const sealedNote = validateShortNote(opts.sealed_note, "sealed_note");

    const report = opts.fixed !== undefined && opts.fixed !== null
      || opts.note !== undefined && opts.note !== null
      || rawItems.some(function (it) {
        return it && typeof it === "object" && (it.star !== undefined || it.note !== undefined);
      });

    let reportFixed = null;
    let reportNote = "";
    if (report) {
      const rawFixed = opts.fixed && typeof opts.fixed === "object" ? opts.fixed : {};
      reportFixed = {};
      for (const k of FIXED_KEYS) {
        const s = rawFixed[k];
        if (!isValidStar(s)) {
          throw new Error("反向回执要填完整:fixed." + k + " 必须是 1~5、按 0.5 步进的星数");
        }
        reportFixed[k] = Math.round(s * 20);   // 星 → 百分制,3.5 → 70
      }
      rawItems.forEach(function (raw, i) {
        const it = raw && typeof raw === "object" ? raw : {};
        if (!isValidStar(it.star)) {
          throw new Error("反向回执要填完整:第 " + (i + 1) + " 条 star 必须是 1~5、按 0.5 步进的数");
        }
        if (it.note !== undefined && it.note !== null) {
          if (typeof it.note !== "string") throw new Error("第 " + (i + 1) + " 条 note 必须是字符串");
          if (it.note.length > MAX_ITEM_NOTE) throw new Error("第 " + (i + 1) + " 条 note 超过 " + MAX_ITEM_NOTE + " 字了");
        }
        items[i].star = it.star;
        items[i].note = typeof it.note === "string" ? it.note : "";
      });
      if (opts.note !== undefined && opts.note !== null) {
        if (typeof opts.note !== "string") throw new Error("note 必须是字符串");
        if (opts.note.length > MAX_NOTE) throw new Error("note 超过 " + MAX_NOTE + " 字了");
        reportNote = opts.note;
      }
    }

    const db = loadAll();
    const dropped = [];
    let kept = items;
    if (!report) {
      const benched = benchedFrom(db.reviews);
      const benchedSet = new Set(benched.map(function (b) { return key(b.dim, b.tag); }));
      kept = items.filter(function (it) {
        if (benchedSet.has(key(it.dim, it.tag))) {
          dropped.push({ dim: it.dim, tag: it.tag });
          return false;
        }
        return true;
      });
      if (!kept.length) throw new Error("全被冷却了,换新花样再开单");
    }

    const context = opts.context === undefined || opts.context === null
      ? "" : String(opts.context).trim().slice(0, MAX_LABEL);

    const now = new Date().toISOString();
    const review = {
      id: genId(),
      created_at: now,
      status: report ? "submitted" : "pending",
      submitted_at: report ? now : null,
      context: context,
      env_note: envNote,
      sealed_note: sealedNote,
      fixed: report ? reportFixed : emptyFixed(),
      items: kept,
      note: report ? reportNote : ""
    };
    if (report) review.filled_by = "agent";
    db.reviews.push(review);
    saveAll(db);
    return { review: review, dropped: dropped };
  }

  function emptyFixed() {
    const f = {};
    for (const k of FIXED_KEYS) f[k] = null;
    return f;
  }

  function getReview(id) {
    const wanted = String(id || "");
    const found = loadAll().reviews.find(function (r) { return r.id === wanted; });
    return found || null;
  }

  function err(message, code) {
    const e = new Error(message);
    e.code = code;
    return e;
  }

  // 提交:固定项打分(0~100 整数)+ 每条 item 逐条打星(1~5,0.5 步进)+ 选填备注 +
  // 整单「改进与建议」。已交/不存在都带 code,路由照 code 映射 409/404。
  // 星数原样落盘,不派生任何判断词 —— 冷却逻辑自己吃裸星数(见 againKeys)。
  function submitReview(id, input) {
    const body = input || {};
    const db = loadAll();
    const wanted = String(id || "");
    const review = db.reviews.find(function (r) { return r.id === wanted; });
    if (!review) throw err("没找到这张单(" + wanted + ")", "not_found");
    if (review.status === "submitted") throw err("这张单已经交过了", "already_submitted");

    const rawFixed = body.fixed && typeof body.fixed === "object" ? body.fixed : {};
    const fixed = {};
    for (const k of FIXED_KEYS) {
      const n = Number(rawFixed[k]);
      if (!Number.isInteger(n) || n < 0 || n > 100) {
        throw new Error("fixed." + k + " 必须是 0~100 的整数");
      }
      fixed[k] = n;
    }

    const stars = body.stars;
    if (!Array.isArray(stars) || stars.length !== review.items.length) {
      throw new Error("stars 要和 items 一样长(" + review.items.length + " 条)");
    }
    for (let i = 0; i < stars.length; i++) {
      const s = Number(stars[i]);
      // 半星步进:合法值 = 1, 1.5, 2, ..., 5(×2 后是整数)。
      if (typeof stars[i] !== "number" || !isFinite(s) || !Number.isInteger(s * 2) || s < 1 || s > 5) {
        throw new Error("第 " + (i + 1) + " 条 star 必须是 1~5、按 0.5 步进的数");
      }
    }

    let notes = null;
    if (body.notes !== undefined && body.notes !== null) {
      if (!Array.isArray(body.notes) || body.notes.length !== review.items.length) {
        throw new Error("notes 要和 items 一样长(" + review.items.length + " 条)");
      }
      notes = body.notes.map(function (n, i) {
        const at = "第 " + (i + 1) + " 条 note";
        if (typeof n !== "string") throw new Error(at + " 必须是字符串");
        if (n.length > MAX_ITEM_NOTE) throw new Error(at + " 超过 " + MAX_ITEM_NOTE + " 字了");
        return n;
      });
    }

    let suggest = "";
    if (body.suggest !== undefined && body.suggest !== null) {
      if (typeof body.suggest !== "string") throw new Error("suggest 必须是字符串");
      if (body.suggest.length > MAX_NOTE) throw new Error("suggest 超过 " + MAX_NOTE + " 字了");
      suggest = body.suggest;
    }

    review.fixed = fixed;
    review.items.forEach(function (it, i) {
      it.star = stars[i];
      it.note = notes ? (notes[i] || "") : "";
    });
    review.note = suggest;
    review.status = "submitted";
    review.submitted_at = new Date().toISOString();
    saveAll(db);
    return review;
  }

  function mmdd(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "??-??";
    return String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  // 百分制(0~100)→ 星数字符串;半星保精度(90→4.5),没打分显示 "-"。
  function starText(v) {
    if (v === null || v === undefined) return "-";
    const n = Number(v);
    if (!isFinite(n)) return "-";
    return String(Math.round(n / 2) / 10);
  }

  // 条目自己的星(1~5,0.5 步进)→ 字符串;老形状数据没 star 就 "-",不拿 verdict 兜。
  function itemStarText(it) {
    const n = Number(it && it.star);
    return isFinite(n) && it.star !== null && it.star !== undefined ? String(n) : "-";
  }

  // dim·tag★星 列表,**全部条目照列不分组**;某条打了备注的话追加「截 30 字」。
  // 中性事实,零判断词 —— 怎么解读是 agent 的事。
  function pairs(review) {
    const items = Array.isArray(review && review.items) ? review.items : [];
    return items.filter(Boolean).map(function (it) {
      const base = it.dim + "·" + it.tag + "★" + itemStarText(it);
      const note = String(it.note || "").trim().replace(/\s+/g, " ");
      return note ? base + "「" + note.slice(0, PAIR_NOTE_TAIL) + "」" : base;
    });
  }

  // 每单压成一行,省 token。没内容的段落整段省略。
  function lineOf(review) {
    const f = review.fixed || {};
    const head = FIXED_KEYS.map(function (k) {
      return (FIXED_LABELS[k] || k) + starText(f[k]);
    }).join("/");
    const seg = [mmdd(review.submitted_at || review.created_at) + " " + head];
    const list = pairs(review);
    if (list.length) seg.push(list.join(","));
    const note = String(review.note || "").trim().replace(/\s+/g, " ");
    if (note) seg.push("建议:「" + note.slice(0, NOTE_TAIL) + "」");
    return seg.join(" | ");
  }

  // 上下文注入块。opts.active 是**使用者自己的「亲密语境激活」信号** —— 你怎么判定
  // 当下算不算那种场合,由你决定(场景标记 / 关键词 / 手动开关都行),这里只认布尔真。
  // 任何异常都吞掉返回 ""—— 绝不炸调用方(通常是发消息主链路)。
  function turnTail(opts) {
    try {
      if (!opts || opts.active !== true) return "";
      const db = loadAll();
      const all = submittedDesc(db.reviews);
      // 「最近几单」只列人类亲手填的;agent 反向填的回执是他自己的话,不冒充对方的复盘。
      const recent = all.filter(function (r) { return r.filled_by !== "agent"; }).slice(0, TAIL_RECENT);
      const benched = benchedFrom(db.reviews);
      if (!recent.length && !benched.length) return "";
      const lines = ["[sigillo · 最近几单](人类伴侣亲手填的回执。星数和原话是素材,怎么解读、下一场怎么走是你的事;唯一硬规则:别复读冷却名单里的项)"];
      for (const r of recent) lines.push(lineOf(r));
      // agent 自己写给下次自己的话:回看全部 submitted,取最新一张带 agent_note 的
      // (只注这一条,旧的不翻)。这是他的主观复盘,不是对方的指令。
      const withNote = all.find(function (r) {
        return String((r && r.agent_note) || "").trim();
      });
      if (withNote) {
        const an = String(withNote.agent_note).trim().replace(/\s+/g, " ");
        lines.push("你上次留给自己的(" + mmdd(withNote.submitted_at || withNote.created_at) +
          "):「" + an.slice(0, AGENT_NOTE_TAIL) + "」");
      }
      if (benched.length) {
        lines.push("冷却中(连 " + BENCH_WINDOW + " 单≥" + HIGH_STAR + " 星自动休眠,换个新花样):" +
          benched.map(function (b) { return b.dim + "·" + b.tag; }).join(","));
      }
      return lines.join("\n");
    } catch (_) {
      return "";
    }
  }

  // agent 的主观复盘上单(sigillo_note):对方封缄之后他被唤醒,看完回执落笔。
  // 只能钉在已提交的单上;允许重写覆盖(想改就改,存最后一版)。
  function setAgentNote(id, note) {
    const db = loadAll();
    const wanted = String(id || "");
    const review = db.reviews.find(function (r) { return r.id === wanted; });
    if (!review) throw err("没找到这张单(" + wanted + ")", "not_found");
    if (review.status !== "submitted") throw new Error("这单还没封缄,等对方填完再写");
    if (typeof note !== "string") throw new Error("note 必须是字符串");
    const text = note.trim();
    if (!text) throw new Error("note 不能为空");
    if (text.length > MAX_AGENT_NOTE) throw new Error("note 超过 " + MAX_AGENT_NOTE + " 字了,精简一下");

    review.agent_note = text;
    review.agent_note_at = new Date().toISOString();
    saveAll(db);
    return review;
  }

  // 最近 n 张 submitted 单(新在前),给 sigillo_recent 用。
  function recentSubmitted(n) {
    try {
      return submittedDesc(loadAll().reviews).slice(0, Math.max(0, n));
    } catch (_) {
      return [];
    }
  }

  return {
    DIMS: DIMS,
    FIXED_KEYS: FIXED_KEYS,
    FIXED_LABELS: FIXED_LABELS,
    file: FILE,
    maxItems: MAX_ITEMS,
    createReview: createReview,
    getReview: getReview,
    submitReview: submitReview,
    setAgentNote: setAgentNote,
    benchedNow: benchedNow,
    turnTail: turnTail,
    recentSubmitted: recentSubmitted
  };
}

module.exports = {
  createStore: createStore,
  DEFAULT_DIMS: DEFAULT_DIMS,
  DEFAULT_FIXED_KEYS: DEFAULT_FIXED_KEYS,
  DEFAULT_FIXED_LABELS: DEFAULT_FIXED_LABELS,
  ID_PREFIX: ID_PREFIX
};
