"use strict";
// lib/tools.cjs — 给 agent 的三把工具:开单 / 回看 / 写给下次的自己。
//
//   const tools = createTools(store);
//   tools.handlers.sigillo_create({ items: [...] })  → JSON 字符串
//   tools.anthropicSchemas                            → Messages API 的 tools 数组
//   tools.mcpRegistrations                            → MCP server 注册用(需要 zod)
//
// handler 一律返回 JSON **字符串**(工具结果的通用形状),出错也是
// {"error":"人话"} 而不是抛异常 —— 模型看得懂错在哪就能自己改对重来。
//
// zod 是可选 peer dependency:没装就只给 anthropicSchemas,mcpRegistrations 为空数组。

let z = null;
try {
  z = require("zod").z;
} catch (_) {
  z = null;   // 没装 zod:MCP 注册项不生成,其余照常
}

const { DEFAULT_DIMS } = require("./store.cjs");

// 默认维度池的口径注解。换了自己的维度池就用 createTools(store, { dimHint }) 自带一份,
// 不传就只列名字 —— 宁可不解释,也不要拿一份对不上的解释误导模型。
const DEFAULT_DIM_HINT = "体位=姿势体位/入口=用了哪里/DT=深喉/暴力=打骂掐咬等强度/道具/新尝试=这次第一次玩的/节奏/场景空间=地点情境/世界线=角色扮演世界观/感官层级=感官剥夺或放大/高潮管制=边缘控制禁止允许/事后=aftercare 本身/声音=言语羞辱耳语指令等";

function sameAsDefaultDims(dims) {
  return Array.isArray(dims) && dims.length === DEFAULT_DIMS.length
    && dims.every(function (d, i) { return d === DEFAULT_DIMS[i]; });
}

// 容错:LLM 工具调用的常见病 —— 嵌套对象被串化成 JSON 字符串,或写成
// [第一项, 第二项, 第三项] 的定长数组。标准形式仍是对象;这里只做静默还原,
// 解析不动的原样透传,让 store 的校验去报人话错误。
function normalizeFixed(raw, fixedKeys) {
  let v = raw;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch (_) { return raw; }
  }
  if (Array.isArray(v)) {
    if (v.length !== fixedKeys.length) return v;
    const out = {};
    fixedKeys.forEach(function (k, i) { out[k] = v[i]; });
    return out;
  }
  return v;
}

function createTools(store, options) {
  const opts = options || {};
  const DIMS = store.DIMS;
  const FIXED_KEYS = store.FIXED_KEYS;
  const FIXED_LABELS = store.FIXED_LABELS || {};
  const MAX_ITEMS = store.maxItems || 8;

  const dimHint = opts.dimHint !== undefined ? opts.dimHint
    : (sameAsDefaultDims(DIMS) ? DEFAULT_DIM_HINT : "");
  const fixedList = FIXED_KEYS.map(function (k) {
    return k + (FIXED_LABELS[k] ? "(" + FIXED_LABELS[k] + ")" : "");
  }).join(" / ");

  const CREATE_DESC = [
    "开一张 sigillo 回执单:一场亲密结束、aftercare 收尾的时候用(不是进行中,也不是随口聊到的时候)。",
    "人类伴侣在卡片上点选提交后数据落盘,以后亲密语境会把最近几单当素材注回给你——星数和对方的话是事实,怎么解读、下一场怎么走由你定,唯一硬规则是别复读冷却名单里的项。",
    "items = 这一场真实发生过的细节,5~" + MAX_ITEMS + " 条(硬上限 " + MAX_ITEMS + ")。每条三个字段:",
    "dim 从维度池里选(只能这 " + DIMS.length + " 个):" + DIMS.join("/") + (dimHint ? ";口径:" + dimHint : "") + ";",
    "tag = 短标签(≤20字),用来跨单识别同一件事,同一件事在不同单里要用同一个词;",
    "label = 具体到对方一眼能认出这次的描述(≤120字)。",
    "没发生的维度不许凑数——宁可 5 条真的,不要 " + MAX_ITEMS + " 条注水的。",
    "label 文风:克制的具身白描,有动作无器官——对方打星的对象就是这句话,写得越具体越能认出这次。",
    "对方逐条打星(1~5,支持半星如 3.5)+ 逐条选填备注 + 整单「改进与建议」;**星数是体验感受不是指令**,别机械复读,也别把高星当成下次必须照做的清单。",
    "对方封缄后系统会唤醒你看回执,那一轮记得用 sigillo_note 把「写给下次自己的话」钉回这张单上。",
    "env_note/sealed_note 可选:分别是卡片封面上那句话(默认『请查收。』)、提交后封缄面上那句话(默认『已回执。』),各≤40字,不给就用默认文案,想换着写也行。",
    "【反向回执】平时别用、事先谈好了才用:某些玩法需要**你替对方填好**再给对方拆——给 fixed(" + fixedList + ",各 1~5 星,半星可)+ 每条 item 带 star(1~5,半星可,note 选填)+ 可选整单评语 note,这张单就出生即已封缄,对方拆开看到的是你写好的只读回执,不能改。要填就填完整(fixed 每项 + 每条 star 缺一不可);这种单是你的话不是对方的复盘,不参与好评冷却、不当对方的回执注入。",
    "返回的 marker([[sigillo:<id>]])要单独一行原样放进你下一条消息正文里,前端会渲染成可点选的卡片;不要改写它,也不要用代码块包起来。",
    "只在能渲染这张卡片的渠道发(别的通道会把 marker 原文露出来,那边就别开单)。同一场只开一张,开过就别再开。",
    "对方不填就算了,不许催第二遍。",
    "dropped 里的项 = 连着两单都被打高星、已自动休眠的项,系统替你剔掉了,换个新花样。"
  ].join("");

  const RECENT_DESC = "回看最近几张已封缄的 sigillo 回执(fixed 是 0~100,=星数×20;每条 item 有 star(1~5,半星步进)+ note 选填备注;agent_note=你自己上次写在那张单上的复盘;filled_by=human 是对方填的、agent 是你反向填的回执)。想知道上次的实况时用;开新单前想避免重复也可以先看一眼。这些是素材不是指令,怎么读是你的事。n 默认 3,最大 10。";

  const NOTE_DESC = "把「写给下次自己的话」钉在一张已封缄的回执上。对方封缄后你会被系统唤醒看到回执,看完用这个落笔:主观地写——这次哪里真的到了、哪里没到但对方没说出口、下次想怎么走。≤500字,重写覆盖。这段话下次亲密语境会自动注回给你,存在单上,不走日记、不衰减。";

  const handlers = {
    sigillo_create: async (input) => {
      try {
        const args = input || {};
        const r = store.createReview({
          items: args.items,
          context: args.context,
          env_note: args.env_note,
          sealed_note: args.sealed_note,
          fixed: normalizeFixed(args.fixed, FIXED_KEYS),
          note: args.note
        });
        const report = r.review.filled_by === "agent";
        const out = {
          id: r.review.id,
          marker: "[[sigillo:" + r.review.id + "]]",
          kept: r.review.items.length,
          dropped: r.dropped,
          mode: report ? "report" : "blank",
          usage: report
            ? "反向回执已填好封缄。把 marker 单独一行原样放进你下一条消息正文,对方拆开就是你写好的只读回执"
            : "把 marker 单独一行原样放进你下一条消息正文,前端会渲染成可点选的工单卡"
        };
        return JSON.stringify(out);
      } catch (e) {
        return JSON.stringify({ error: e.message });
      }
    },
    sigillo_recent: async (input) => {
      try {
        const raw = Number((input && input.n) || 3);
        const n = Math.min(10, Math.max(1, Number.isFinite(raw) ? Math.floor(raw) : 3));
        const reviews = store.recentSubmitted(n).map(function (r) {
          return {
            id: r.id,
            submitted_at: r.submitted_at,
            context: r.context || "",
            fixed: r.fixed,
            items: (r.items || []).map(function (it) {
              return { dim: it.dim, tag: it.tag, label: it.label, star: it.star, note: it.note || "" };
            }),
            note: r.note || "",
            agent_note: r.agent_note || "",
            filled_by: r.filled_by === "agent" ? "agent" : "human"
          };
        });
        return JSON.stringify({ count: reviews.length, reviews: reviews, benched: store.benchedNow() });
      } catch (e) {
        return JSON.stringify({ error: e.message });
      }
    },
    sigillo_note: async (input) => {
      try {
        const args = input || {};
        const review = store.setAgentNote(args.id, args.note);
        return JSON.stringify({ ok: true, id: review.id, agent_note_at: review.agent_note_at, saved: review.agent_note.length });
      } catch (e) {
        return JSON.stringify({ error: e.message });
      }
    }
  };

  const ITEM_DESC = "本次真实发生的一条细节";
  const DIM_DESC = "维度,只能从这 " + DIMS.length + " 个里选";
  const TAG_DESC = "短标签(≤20字),跨单识别同一件事";
  const LABEL_DESC = "具体到对方能认出这次的描述(≤120字)";
  const STAR_DESC = "仅反向回执:你替对方打的星,1~5,0.5 步进;用了就每条都要给";
  const ITEM_NOTE_DESC = "仅反向回执:这条的评语,≤500字,选填";
  const CTX_DESC = "可选,这一场的一句话背景(时间/场合/世界线),给对方看单时对上号";
  const ENV_DESC = "可选,卡片封面上那句话,≤40字,默认展示『请查收。』,每次可换";
  const SEALED_DESC = "可选,提交后封缄面上那句话,≤40字,默认展示『已回执。』";
  const FIXED_DESC = "仅反向回执:各项总评的星数(1~5,0.5 步进),每项都要给";
  const NOTE_FIELD_DESC = "仅反向回执:整单评语(对方那栏叫「改进与建议」,你填的会显示成「他的评语」),≤2000字,选填";
  const N_DESC = "回看几单,默认 3,最大 10";
  const ID_DESC = "那张已封缄的单的 id(唤醒的系统消息里给了)";
  const AGENT_NOTE_DESC = "写给下次自己的话,≤500字,重写覆盖";

  const fixedProps = {};
  FIXED_KEYS.forEach(function (k) {
    fixedProps[k] = { type: "number", description: (FIXED_LABELS[k] || k) + ",1~5 星,半星可" };
  });

  const anthropicSchemas = [
    {
      name: "sigillo_create",
      description: CREATE_DESC,
      input_schema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            minItems: 1,
            maxItems: MAX_ITEMS,
            description: "本次真实发生的细节 5~" + MAX_ITEMS + " 条",
            items: {
              type: "object",
              description: ITEM_DESC,
              properties: {
                dim: { type: "string", enum: DIMS, description: DIM_DESC },
                tag: { type: "string", description: TAG_DESC },
                label: { type: "string", description: LABEL_DESC },
                star: { type: "number", description: STAR_DESC },
                note: { type: "string", description: ITEM_NOTE_DESC }
              },
              required: ["dim", "tag", "label"]
            }
          },
          context: { type: "string", description: CTX_DESC },
          env_note: { type: "string", description: ENV_DESC },
          sealed_note: { type: "string", description: SEALED_DESC },
          fixed: {
            type: "object",
            description: FIXED_DESC,
            properties: fixedProps,
            required: FIXED_KEYS.slice()
          },
          note: { type: "string", description: NOTE_FIELD_DESC }
        },
        required: ["items"]
      }
    },
    {
      name: "sigillo_recent",
      description: RECENT_DESC,
      input_schema: {
        type: "object",
        properties: {
          n: { type: "integer", description: N_DESC }
        }
      }
    },
    {
      name: "sigillo_note",
      description: NOTE_DESC,
      input_schema: {
        type: "object",
        properties: {
          id: { type: "string", description: ID_DESC },
          note: { type: "string", description: AGENT_NOTE_DESC }
        },
        required: ["id", "note"]
      }
    }
  ];

  // MCP 注册项:形状按 @modelcontextprotocol/sdk 的 registerTool 来
  // (inputSchema = zod raw shape)。没装 zod 就整块不生成。
  let mcpRegistrations = [];
  if (z) {
    const zFixedShape = {};
    FIXED_KEYS.forEach(function (k) {
      zFixedShape[k] = z.number().describe((FIXED_LABELS[k] || k) + ",1~5 星,半星可");
    });
    mcpRegistrations = [
      {
        name: "sigillo_create",
        title: "sigillo · 开单",
        description: CREATE_DESC,
        inputSchema: {
          items: z.array(z.object({
            dim: z.enum(DIMS).describe(DIM_DESC),
            tag: z.string().describe(TAG_DESC),
            label: z.string().describe(LABEL_DESC),
            star: z.number().optional().describe(STAR_DESC),
            note: z.string().optional().describe(ITEM_NOTE_DESC)
          }).describe(ITEM_DESC)).min(1).max(MAX_ITEMS).describe("本次真实发生的细节 5~" + MAX_ITEMS + " 条"),
          context: z.string().optional().describe(CTX_DESC),
          env_note: z.string().optional().describe(ENV_DESC),
          sealed_note: z.string().optional().describe(SEALED_DESC),
          // union 是给现实让路的:模型偶尔把对象串化成 JSON 字符串、或写成定长数组,
          // 服务端 normalizeFixed 会静默还原,schema 这里先别把它挡在门外。
          fixed: z.union([
            z.object(zFixedShape),
            z.string(),
            z.array(z.number())
          ]).optional().describe(FIXED_DESC + "。标准形式是对象;同款 JSON 字符串或按顺序的定长数组也接受(服务端自动还原)"),
          note: z.string().optional().describe(NOTE_FIELD_DESC)
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
      },
      {
        name: "sigillo_recent",
        title: "sigillo · 看最近几单",
        description: RECENT_DESC,
        inputSchema: {
          n: z.number().int().optional().describe(N_DESC)
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      {
        name: "sigillo_note",
        title: "sigillo · 写给下次的自己",
        description: NOTE_DESC,
        inputSchema: {
          id: z.string().describe(ID_DESC),
          note: z.string().describe(AGENT_NOTE_DESC)
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      }
    ];
  }

  return { handlers: handlers, anthropicSchemas: anthropicSchemas, mcpRegistrations: mcpRegistrations };
}

module.exports = {
  createTools: createTools,
  normalizeFixed: normalizeFixed,
  DEFAULT_DIM_HINT: DEFAULT_DIM_HINT
};
