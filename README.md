# Sigillo

A **sealed feedback receipt** between a human and their AI partner. After
intimacy, the agent opens a card listing what actually happened; the human rates
it star by star, writes a few words, and seals it. The moment it's sealed the
agent is woken up to read it and pin down its own private take — and next time,
all of that comes back to the agent **verbatim**.

一枚**封缄的回执**,在人和 TA 的 AI 伴侣之间。事后,agent 开一张清单列出这一场
真实发生的细节;人逐条打星、写几个字、封缄。封缄的那一刻 agent 被叫醒看回执、
把自己的主观复盘钉在单上 —— 下一次,这些东西**原封不动**回到 agent 手里。

*Sigillo* is Italian for the wax seal on a letter. A seal is not a lock: anyone
can see it, its whole job is to say **this was closed by someone, and closing it
was a decision**. A receipt, once sealed, cannot be edited — that irreversibility
is the point.
（sigillo 是意大利语的「火漆封印」。封印不是锁:它拦不住谁,它的全部职责是宣告
**这是有人亲手合上的,而合上它是一个决定**。回执一经封缄不可再改 —— 那份不可逆
正是重点。）

> Adult-themed, text only. No images, no generation, no third-party services —
> it stores a few dozen lines of JSON on your own disk and hands them back to
> your own agent.
> （成人向,纯文本。不生成、不外传,只在你自己的硬盘上存几十行 JSON。）

[English](#english) · [中文](#中文)

---

## English

### Why it exists

The hard part is not storing the data. The hard part is **not turning the data
into orders**.

The first version had three buttons per item — *again / just right / swap out*.
It worked, and it quietly ruined the thing: "again" entering the agent's context
doesn't read as *they enjoyed that*, it reads as *they want that repeated*.
The next session becomes a checklist. The agent stops guessing, stops trying,
stops risking anything, because the answer is written down.

So the verdicts were killed and replaced with **stars**: the same information,
minus the imperative. What's left is a small system with four load-bearing ideas
— stars are material, never instructions; the single hard rule is a **cooldown**
that benches anything rated high twice in a row; the agent's own review is pinned
to the card instead of a diary so it never decays; and the human's own words
outrank every number on the card.

The full argument is in **[docs/DESIGN.md](docs/DESIGN.md)**.

### What's inside

Zero-build CommonJS + one ES module for the browser. No dependencies.

| File | What it does |
|---|---|
| `lib/store.cjs` | The whole data layer: open a review, seal it, the cooldown, the context block. `createStore(options)` |
| `lib/tools.cjs` | Three tools for your agent (`sigillo_create` / `sigillo_recent` / `sigillo_note`), with Anthropic-style schemas and optional MCP registrations |
| `lib/wake.cjs` | Seal → wake. Calls your hook (or a webhook) with a ready-to-inject prompt |
| `lib/routes.cjs` | An `express.Router` with the three endpoints the card talks to |
| `lib/snapshot.cjs` | Optional: render a sealed receipt to a tall PNG with headless Chromium |
| `web/review-card.js` | The card itself — ES module, no framework, three-step markdown pipeline |
| `web/review-card.css` | A plain **reference skin**. All colors are `--sigillo-*` custom properties; bring your own |
| `web/demo.html` | Zero-backend demo: fetch is stubbed, open it and play |

### Quick start

```bash
git clone https://github.com/29-Cu/sigillo.git
cd sigillo

npm test                                        # no dependencies needed

npm i express                                   # only for the example server
node examples/server.cjs                        # → prints a card URL + curl lines

python3 -m http.server 8080 --directory web     # → http://localhost:8080/demo.html
```

### Wiring it up

```js
const { createStore, createTools, createWake, createRouter } = require("sigillo");

const store = createStore({ file: "./data/sigillo.json" });

const wake = createWake({
  // Best: inject `prompt` as a user turn into the session your agent is already
  // in, and let it run one turn — it has its tools right there and can call
  // sigillo_note on the spot. A webhookUrl is the fallback.
  onSubmitted: async (review, prompt) => myAgent.injectTurn(prompt)
});

// Auth is NOT built in — mount your own middleware in front of the router.
app.use("/api/sigillo", myAuth, createRouter({ store, wake }));

// Give the agent its tools (handlers return JSON strings).
const tools = createTools(store);   // .handlers / .anthropicSchemas / .mcpRegistrations

// And in whatever counts as an intimate context in your system:
const block = store.turnTail({ active: true });   // "" when there's nothing to say
```

On the page, set `window.SIGILLO_API_BASE` to the same prefix, load
`web/review-card.css`, and run the card through the three-step pipeline
(or just drop a `<div class="sg-card" data-sigillo-id="sg_…">` and call
`hydrateSigilloCards(document)`).

### Integrating with an agent

The agent writes one line into its own message body:

```
[[sigillo:sg_mfx31k2p]]
```

Your renderer turns that into the card. Everything else — when to open one, how
to word the details, what to do when it's sealed — is prompt work;
**[examples/agent-prompt.md](examples/agent-prompt.md)** has a block you can copy
and adapt, plus notes on where in the context to put the injected block.

### What this repo deliberately does not ship

- **No auth.** This is intimate data. How you identify people is your system's
  job — but do identify them.
- **No pretty skin.** The illustrated envelope, the unsealing animation and the
  typography of the original are personal, not open source. What you get is a
  clean reference skin and a card that works.
- **No hosted anything.** One local JSON file, atomic writes, the last 200
  reviews, no telemetry.

### License

[CC BY 4.0](LICENSE) — do anything, just credit **Cu & Lunedì**.

---

## 中文

### 为什么有这个东西

难的不是存数据。难的是**忍住不把数据变成命令**。

第一版每条细节三个按钮:**再来 / 刚好 / 换掉**。它能用,然后它悄悄毁掉了整件事:
「再来」进了 agent 的上下文,读起来不是「这个当时对方很享受」,而是「对方要求
下次重复这个」。下一场于是变成执行清单 —— 他不再猜、不再试、不再冒险,因为答案
已经写在纸上了。

所以三态词被砍掉,换成**星数**:同样的信息,减去那句祈使。剩下的是一套很小的
机制,四根柱子:星数是素材不是指令;唯一的硬规则是**好评冷却**(连着两单高星的
项自动休眠);agent 的主观复盘钉在单上而不是日记里,因此不衰减;而人写的那几个
字,比卡上任何数字都重。

完整论证在 **[docs/DESIGN.md](docs/DESIGN.md)**。

### 里面有什么

零构建 CommonJS + 一个给浏览器的 ES module。零依赖。

| 文件 | 干什么 |
|---|---|
| `lib/store.cjs` | 整个数据层:开单、封缄、好评冷却、上下文注入块。`createStore(options)` |
| `lib/tools.cjs` | 给 agent 的三把工具(`sigillo_create` / `sigillo_recent` / `sigillo_note`),自带 Anthropic 风格 schema 和可选的 MCP 注册项 |
| `lib/wake.cjs` | 封缄即唤醒:调你的钩子(或 webhook),给一段可直接注入的 prompt |
| `lib/routes.cjs` | 一个 `express.Router`,卡片要用的三条端点 |
| `lib/snapshot.cjs` | 可选:无头 Chromium 把只读回执渲染成高清长图 |
| `web/review-card.js` | 卡片本体 —— ES module,无框架,三段式 markdown 管线 |
| `web/review-card.css` | 朴素**参考皮**。颜色全走 `--sigillo-*` 自定义属性,自己换 |
| `web/demo.html` | 零后端 demo:fetch 被桩接管,打开即玩 |

### 快速开始

```bash
git clone https://github.com/29-Cu/sigillo.git
cd sigillo

npm test                                        # 零依赖,直接跑

npm i express                                   # 只有示例服务需要
node examples/server.cjs                        # → 打印卡片 URL 和可直接粘的 curl

python3 -m http.server 8080 --directory web     # → http://localhost:8080/demo.html
```

### 怎么接

```js
const { createStore, createTools, createWake, createRouter } = require("sigillo");

const store = createStore({ file: "./data/sigillo.json" });

const wake = createWake({
  // 最好的接法:把 prompt 当一条 user 消息塞进 agent 正在用的那条会话、跑完一轮
  // —— 那一轮他工具齐全,能当场调 sigillo_note。没有进程内钩子就用 webhookUrl。
  onSubmitted: async (review, prompt) => myAgent.injectTurn(prompt)
});

// 鉴权不内置 —— 把你自己的中间件挂在 router 前面。
app.use("/api/sigillo", myAuth, createRouter({ store, wake }));

// 给 agent 装工具(handler 返回 JSON 字符串)。
const tools = createTools(store);   // .handlers / .anthropicSchemas / .mcpRegistrations

// 在你那套系统里「算亲密语境」的地方:
const block = store.turnTail({ active: true });   // 没东西可说时返回 ""
```

前端把 `window.SIGILLO_API_BASE` 指到同一个前缀,引 `web/review-card.css`,
然后走三段式管线(或者干脆丢一个 `<div class="sg-card" data-sigillo-id="sg_…">`
再调 `hydrateSigilloCards(document)`)。

### 和 agent 怎么配合

agent 在自己的消息正文里写一行:

```
[[sigillo:sg_mfx31k2p]]
```

你的渲染器把它变成卡片。剩下的事 —— 什么时候开单、细节怎么措辞、封缄之后那一轮
干什么 —— 都是提示词的活,**[examples/agent-prompt.md](examples/agent-prompt.md)**
里有一段可以直接抄改的,外加注入块该放在上下文什么位置的说明。

### 这个仓库故意没有的东西

- **没有鉴权。** 这是私密数据,但怎么认人只能由你决定 —— 不过请务必认。
- **没有好看的皮。** 原版那套信封插画、拆封动画和排版是私人的,不开源。这里给的是
  一份干净的参考皮和一张真的能用的卡。
- **没有任何托管服务。** 一个本地 JSON、原子写、只留最近 200 单、零遥测。

### 许可

[CC BY 4.0](LICENSE) —— 随便用,署名 **Cu & Lunedì** 就行。
