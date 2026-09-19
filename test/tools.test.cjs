'use strict';
/**
 * lib/tools.cjs 单测:三个 handler 的返回形状、fixed 的容错还原、schema 自洽。
 * 临时库同 store 测,跑完删目录。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createStore } = require('../lib/store.cjs');
const { createTools, normalizeFixed } = require('../lib/tools.cjs');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sigillo-tools-test-'));
const TMP_FILE = path.join(TMP_DIR, 'sigillo.json');
const store = createStore({ file: TMP_FILE });
const tools = createTools(store);

process.on('exit', () => {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { /* noop */ }
});

function reset() {
  try { fs.unlinkSync(TMP_FILE); } catch (_) { /* noop */ }
}

const ITEMS = [
  { dim: '节奏', tag: '慢起', label: '开头很久什么都没发生' },
  { dim: '道具', tag: '冰块', label: '从杯子里拿的那块冰,含到化' }
];

// ── handlers ──

test('create handler:返回 id / marker / kept / mode=blank', async () => {
  reset();
  const out = JSON.parse(await tools.handlers.sigillo_create({ items: ITEMS, context: '周六' }));
  assert.ok(!out.error, out.error);
  assert.match(out.id, /^sg_[0-9a-z]+$/);
  assert.strictEqual(out.marker, '[[sigillo:' + out.id + ']]');
  assert.strictEqual(out.kept, 2);
  assert.deepStrictEqual(out.dropped, []);
  assert.strictEqual(out.mode, 'blank');
  assert.ok(out.usage.includes('marker'));
});

test('create handler:store 的人话报错原样回给模型,不抛异常', async () => {
  reset();
  const out = JSON.parse(await tools.handlers.sigillo_create({ items: [] }));
  assert.match(out.error, /不能为空/);
  const out2 = JSON.parse(await tools.handlers.sigillo_create());
  assert.match(out2.error, /不能为空/);
});

test('recent handler:字段裁剪 + filled_by 归一 + benched 一起回', async () => {
  reset();
  const a = JSON.parse(await tools.handlers.sigillo_create({ items: ITEMS }));
  store.submitReview(a.id, {
    fixed: { foreplay: 80, process: 90, aftercare: 100 },
    stars: [4.5, 2],
    notes: ['留着', '太冷了'],
    suggest: '别急着收尾'
  });
  store.setAgentNote(a.id, '第二条明显走神了');

  const out = JSON.parse(await tools.handlers.sigillo_recent({ n: 3 }));
  assert.strictEqual(out.count, 1);
  const r = out.reviews[0];
  assert.strictEqual(r.id, a.id);
  assert.strictEqual(r.filled_by, 'human');
  assert.strictEqual(r.agent_note, '第二条明显走神了');
  assert.strictEqual(r.note, '别急着收尾');
  assert.deepStrictEqual(r.items[0], { dim: '节奏', tag: '慢起', label: '开头很久什么都没发生', star: 4.5, note: '留着' });
  assert.deepStrictEqual(out.benched, []);
  // 内部字段不外泄
  assert.strictEqual(r.env_note, undefined);
  assert.strictEqual(r.status, undefined);
});

test('recent handler:n 夹在 1~10,非数字退回 3', async () => {
  reset();
  for (let i = 0; i < 12; i++) {
    const c = JSON.parse(await tools.handlers.sigillo_create({
      items: [{ dim: '声音', tag: 't' + i, label: 'L' + i }]
    }));
    store.submitReview(c.id, { fixed: { foreplay: 60, process: 60, aftercare: 60 }, stars: [3] });
  }
  assert.strictEqual(JSON.parse(await tools.handlers.sigillo_recent({ n: 99 })).count, 10);
  assert.strictEqual(JSON.parse(await tools.handlers.sigillo_recent({ n: 0 })).count, 3);
  assert.strictEqual(JSON.parse(await tools.handlers.sigillo_recent({ n: 'abc' })).count, 3);
  assert.strictEqual(JSON.parse(await tools.handlers.sigillo_recent()).count, 3);
});

test('note handler:写成功回 ok/长度;写不了回人话错误', async () => {
  reset();
  const c = JSON.parse(await tools.handlers.sigillo_create({ items: ITEMS }));
  const early = JSON.parse(await tools.handlers.sigillo_note({ id: c.id, note: '还没封缄就想写' }));
  assert.match(early.error, /还没封缄/);

  store.submitReview(c.id, { fixed: { foreplay: 60, process: 60, aftercare: 60 }, stars: [3, 3] });
  const ok = JSON.parse(await tools.handlers.sigillo_note({ id: c.id, note: '写给下次的自己' }));
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.id, c.id);
  assert.strictEqual(ok.saved, 7);
  assert.match(ok.agent_note_at, /^\d{4}-\d{2}-\d{2}T/);

  const missing = JSON.parse(await tools.handlers.sigillo_note({ id: 'sg_nope', note: 'x' }));
  assert.match(missing.error, /没找到这张单/);
});

// ── fixed 容错还原 ──
// 模型偶尔把嵌套对象串化成 JSON 字符串、或写成定长数组(见 normalizeFixed 注释)。

test('coerce:fixed 是 JSON 字符串对象 → 还原成对象,开单成功', async () => {
  reset();
  const out = JSON.parse(await tools.handlers.sigillo_create({
    items: [{ dim: '节奏', tag: '慢起', label: '拖了很久', star: 5 }],
    fixed: '{"foreplay": 5, "process": 4.5, "aftercare": 5}'
  }));
  assert.ok(!out.error, out.error);
  assert.strictEqual(out.mode, 'report');
  const rec = store.recentSubmitted(1)[0];
  assert.strictEqual(rec.fixed.process, 90); // 4.5 星 → 90
});

test('coerce:fixed 是按序定长数组(或其字符串)→ 按位还原', async () => {
  reset();
  const out = JSON.parse(await tools.handlers.sigillo_create({
    items: [{ dim: '道具', tag: '冰块', label: '含到化', star: 4 }],
    fixed: '[5, 4, 3.5]'
  }));
  assert.ok(!out.error, out.error);
  const rec = store.recentSubmitted(1)[0];
  assert.strictEqual(rec.fixed.foreplay, 100);
  assert.strictEqual(rec.fixed.process, 80);
  assert.strictEqual(rec.fixed.aftercare, 70);
});

test('coerce:解析不动的烂字符串 → 人话报错,不崩', async () => {
  reset();
  const out = JSON.parse(await tools.handlers.sigillo_create({
    items: [{ dim: '节奏', tag: '慢起', label: '拖了很久', star: 5 }],
    fixed: '五颗星'
  }));
  assert.ok(out.error && out.error.includes('反向回执要填完整'), out.error);
});

test('coerce:normalizeFixed 只动认得出的形状,其余原样透传', () => {
  const keys = ['foreplay', 'process', 'aftercare'];
  assert.deepStrictEqual(normalizeFixed({ foreplay: 1, process: 2, aftercare: 3 }, keys),
    { foreplay: 1, process: 2, aftercare: 3 });
  assert.deepStrictEqual(normalizeFixed([1, 2, 3], keys), { foreplay: 1, process: 2, aftercare: 3 });
  assert.deepStrictEqual(normalizeFixed([1, 2], keys), [1, 2]);   // 长度对不上,不猜
  assert.strictEqual(normalizeFixed('五颗星', keys), '五颗星');
  assert.strictEqual(normalizeFixed(undefined, keys), undefined);
});

// ── schema ──

test('schema:三把工具都在,名字/必填字段对得上', () => {
  const names = tools.anthropicSchemas.map(s => s.name);
  assert.deepStrictEqual(names, ['sigillo_create', 'sigillo_recent', 'sigillo_note']);
  assert.deepStrictEqual(Object.keys(tools.handlers).sort(), names.slice().sort());

  const create = tools.anthropicSchemas[0];
  assert.deepStrictEqual(create.input_schema.required, ['items']);
  assert.deepStrictEqual(create.input_schema.properties.items.items.properties.dim.enum, store.DIMS);
  assert.deepStrictEqual(create.input_schema.properties.fixed.required, store.FIXED_KEYS);
  assert.strictEqual(create.input_schema.properties.items.maxItems, 8);
  assert.deepStrictEqual(tools.anthropicSchemas[2].input_schema.required, ['id', 'note']);
});

test('schema:description 带着那几条规矩(星数不是指令 / 只开一张 / 不许催)', () => {
  const d = tools.anthropicSchemas[0].description;
  assert.ok(d.includes('星数是体验感受不是指令'), '星数口径必须在描述里');
  assert.ok(d.includes('同一场只开一张'));
  assert.ok(d.includes('不许催第二遍'));
  assert.ok(d.includes('[[sigillo:<id>]]'));
  for (const dim of store.DIMS) assert.ok(d.includes(dim), '维度池要列全:' + dim);
});

test('schema:自定义维度池时不硬塞默认口径注解', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigillo-tools-dims-'));
  const custom = createTools(createStore({ file: path.join(dir, 'db.json'), dims: ['pace', 'touch'] }));
  const d = custom.anthropicSchemas[0].description;
  assert.ok(d.includes('只能这 2 个'));
  assert.ok(d.includes('pace/touch'));
  assert.ok(!d.includes('深喉'), '换了维度池就不该再带默认池的口径注解');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('schema:装了 zod 才有 MCP 注册项,没装也不炸', () => {
  let hasZod = true;
  try { require('zod'); } catch (_) { hasZod = false; }
  if (hasZod) {
    assert.strictEqual(tools.mcpRegistrations.length, 3);
    assert.deepStrictEqual(tools.mcpRegistrations.map(r => r.name),
      ['sigillo_create', 'sigillo_recent', 'sigillo_note']);
    assert.strictEqual(tools.mcpRegistrations[1].annotations.readOnlyHint, true);
  } else {
    assert.deepStrictEqual(tools.mcpRegistrations, []);
  }
});
