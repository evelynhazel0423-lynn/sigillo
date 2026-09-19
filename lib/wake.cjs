"use strict";
// lib/wake.cjs — 「封缄即唤醒」。
//
//   const wake = createWake({ onSubmitted: async (review, prompt) => {...} });
//   // 或者:createWake({ webhookUrl: "http://localhost:8080/hooks/sigillo" })
//
// 机制的第四根柱子:人类一封缄,系统立刻把回执**推**给 agent,让他在余温还在的
// 那一轮写主观复盘(sigillo_note → review.agent_note),而不是等下次亲密时才
// 回头翻账。推什么由 buildNote 拼:只报事实(星数 + 原话),不替他下结论。
//
// 两条出口,优先级从上到下:
//   1) onSubmitted(review, prompt) —— 你自己的注入函数。最好的接法是把 prompt
//      当成一条 user 消息塞进 agent 正在用的那条会话里、跑完一轮(这样他手上的
//      工具都在,能当场调 sigillo_note)。具体怎么塞是你那套系统的事。
//   2) webhookUrl —— POST {event:"sigillo.submitted", review, prompt},给没有
//      进程内钩子的部署用。
// 两个都没配就什么也不做。
//
// 全程不外抛:提交已经落盘了,唤醒失败不该冒泡成用户那边的红字。

const { DEFAULT_FIXED_KEYS, DEFAULT_FIXED_LABELS } = require("./store.cjs");

const CTX_TAIL = 120;       // 便签里 context 截断
const ITEM_NOTE_TAIL = 120; // 便签里逐条备注截断(比注入块宽,这轮是给他细读的)
const SUGGEST_TAIL = 500;   // 便签里整单建议截断

// 百分制(0~100)→ 星数字符串,半星保精度;没打分显示 "-"。同 store 的口径。
function starText(v) {
  if (v === null || v === undefined) return "-";
  const n = Number(v);
  if (!isFinite(n)) return "-";
  return String(Math.round(n / 2) / 10);
}

function itemStarText(it) {
  const n = Number(it && it.star);
  return isFinite(n) && it.star !== null && it.star !== undefined ? String(n) : "-";
}

function oneLine(v, tail) {
  return String(v || "").trim().replace(/\s+/g, " ").slice(0, tail);
}

// 便签本体。纯函数,可单测(HTTP 部分不测)。
// opts: { partner, fixedKeys, fixedLabels } —— 都有默认值,通常不用传。
function buildNote(review, opts) {
  const o = opts || {};
  const partner = o.partner || "对方";
  const fixedKeys = Array.isArray(o.fixedKeys) && o.fixedKeys.length ? o.fixedKeys : DEFAULT_FIXED_KEYS;
  const fixedLabels = o.fixedLabels || DEFAULT_FIXED_LABELS;

  const r = review || {};
  const f = r.fixed || {};
  const ctx = oneLine(r.context, CTX_TAIL);
  const items = Array.isArray(r.items) ? r.items : [];
  const head = fixedKeys.map(function (k) {
    return (fixedLabels[k] || k) + " " + starText(f[k]);
  }).join(" / ");
  const lines = [
    "[系统消息 · sigillo 回执]",
    partner + "刚封缄了你开的回执单(id " + (r.id || "?") + (ctx ? ",场景:" + ctx : "") + ")。填的:",
    head + "(满分5)"
  ];
  for (const it of items) {
    if (!it) continue;
    const note = oneLine(it.note, ITEM_NOTE_TAIL);
    lines.push("· " + it.dim + "·" + it.tag + " ★" + itemStarText(it) + (note ? "「" + note + "」" : ""));
  }
  const suggest = oneLine(r.note, SUGGEST_TAIL);
  if (suggest) lines.push("建议与意见:「" + suggest + "」");
  lines.push("两件事,这一轮做完:");
  lines.push("① " + partner + "刚填完就在线——想说什么就说;");
  lines.push("② 用 sigillo_note 把「写给下次自己的话」钉在这张单上(id 用上面的):主观地写,这次哪里真的到了、哪里其实没到但没说出口、下次想怎么走。这段话下次亲密语境会自动注回给你。" + partner + "看不到本系统消息。");
  return lines.join("\n");
}

function createWake(options) {
  const o = options || {};
  const onSubmitted = typeof o.onSubmitted === "function" ? o.onSubmitted : null;
  const webhookUrl = typeof o.webhookUrl === "string" && o.webhookUrl ? o.webhookUrl : null;
  const headers = o.headers && typeof o.headers === "object" ? o.headers : {};
  const noteOpts = { partner: o.partner, fixedKeys: o.fixedKeys, fixedLabels: o.fixedLabels };

  function note(review) {
    return buildNote(review, noteOpts);
  }

  // 封缄 → 唤醒。绝不外抛:调用方在 setImmediate 里跑,炸了也只留一行日志。
  async function notifySubmitted(review) {
    const prompt = note(review);
    try {
      if (onSubmitted) {
        await onSubmitted(review, prompt);
        return { woke: true, via: "callback" };
      }
      if (webhookUrl) {
        const r = await fetch(webhookUrl, {
          method: "POST",
          headers: Object.assign({ "Content-Type": "application/json" }, headers),
          body: JSON.stringify({ event: "sigillo.submitted", review: review, prompt: prompt })
        });
        // body 读掉再走,免得连接吊着(不读完的响应有些运行时不回收)。
        try { await r.text(); } catch (_) { /* 响应体不重要,读不到就算了 */ }
        return { woke: true, via: "webhook", status: r.status };
      }
      return { woke: false, via: "none" };
    } catch (e) {
      console.error("[sigillo:wake] notify failed:", e && e.message);
      return { woke: false, error: (e && e.message) || String(e) };
    }
  }

  return { notifySubmitted: notifySubmitted, buildNote: note };
}

module.exports = { createWake: createWake, buildNote: buildNote };
