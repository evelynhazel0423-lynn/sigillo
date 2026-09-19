'use strict';
/**
 * lib/wake.cjs 单测。
 * buildNote 是纯函数,全覆盖;notifySubmitted 只测两条出口的分发和「绝不外抛」,
 * webhook 那条起一个本地 http server 收包(不出网)。
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

const { createWake, buildNote } = require('../lib/wake.cjs');

// 造一张已封缄的单;items = [[dim, tag, star, note?], ...]
function submitted(id, items, over) {
  return Object.assign({
    id: id,
    created_at: '2026-09-18T11:00:00.000Z',
    status: 'submitted',
    submitted_at: '2026-09-18T12:00:00.000Z',
    context: '',
    fixed: { foreplay: 80, process: 90, aftercare: 60 },
    items: items.map(([dim, tag, star, note]) => ({
      dim: dim, tag: tag, label: tag + '的具体描述', star: star, note: note || ''
    })),
    note: ''
  }, over || {});
}

// ── buildNote ──

test('buildNote:回执 + 场景 + 建议 + 两件事', () => {
  const note = buildNote(submitted('sg_x',
    [['场景空间', '窗边', 5, '这个可以留着'], ['节奏', '慢起', 3]],
    { context: '周六傍晚,雨没停', note: '下次别急' }));
  const lines = note.split('\n');
  assert.strictEqual(lines[0], '[系统消息 · sigillo 回执]');
  assert.strictEqual(lines[1], '对方刚封缄了你开的回执单(id sg_x,场景:周六傍晚,雨没停)。填的:');
  assert.strictEqual(lines[2], '前戏 4 / 过程 4.5 / 事后 3(满分5)');
  assert.strictEqual(lines[3], '· 场景空间·窗边 ★5「这个可以留着」');
  assert.strictEqual(lines[4], '· 节奏·慢起 ★3');
  assert.strictEqual(lines[5], '建议与意见:「下次别急」');
  assert.strictEqual(lines[6], '两件事,这一轮做完:');
  assert.match(lines[7], /^① 对方刚填完就在线/);
  assert.match(lines[8], /^② 用 sigillo_note /);
  assert.match(lines[8], /对方看不到本系统消息。$/);
});

test('buildNote:没 context / 没建议 → 那两处整段省略', () => {
  const note = buildNote(submitted('sg_y', [['声音', '耳语', 2.5]]));
  assert.ok(note.includes('(id sg_y)。填的:'));
  assert.ok(!note.includes('场景:'));
  assert.ok(!note.includes('建议与意见'));
  assert.ok(note.includes('· 声音·耳语 ★2.5'));
});

test('buildNote:空/畸形单也不炸', () => {
  assert.ok(buildNote(null).includes('[系统消息 · sigillo 回执]'));
  assert.ok(buildNote({}).includes('(id ?)'));
  assert.ok(buildNote({ id: 'sg_z', items: 'nope' }).includes('前戏 - / 过程 - / 事后 -'));
});

test('buildNote:折行/超长的备注压平截断,partner 可换称呼', () => {
  const note = buildNote(submitted('sg_w', [['声音', '耳语', 3, '第一行\n\n第二行']],
    { note: 'x'.repeat(600) }), { partner: 'M' });
  assert.ok(note.includes('· 声音·耳语 ★3「第一行 第二行」'));
  assert.ok(note.includes('M刚封缄了你开的回执单'));
  assert.ok(note.includes('建议与意见:「' + 'x'.repeat(500) + '」'));
  assert.ok(!note.includes('x'.repeat(501)));
});

test('buildNote:fixedKeys / fixedLabels 跟着 store 配置走', () => {
  const note = buildNote({ id: 'sg_k', fixed: { warmup: 100, care: 60 }, items: [] },
    { fixedKeys: ['warmup', 'care'], fixedLabels: { warmup: 'Warm-up', care: 'Care' } });
  assert.ok(note.includes('Warm-up 5 / Care 3(满分5)'));
});

// ── notifySubmitted ──

test('notify:优先走 onSubmitted 回调,拿到 (review, prompt)', async () => {
  let seen = null;
  const wake = createWake({
    onSubmitted: async (review, prompt) => { seen = { id: review.id, prompt: prompt }; }
  });
  const out = await wake.notifySubmitted(submitted('sg_cb', [['声音', '耳语', 3]]));
  assert.deepStrictEqual(out, { woke: true, via: 'callback' });
  assert.strictEqual(seen.id, 'sg_cb');
  assert.ok(seen.prompt.startsWith('[系统消息 · sigillo 回执]'));
});

test('notify:回调炸了也不外抛,返回 woke:false', async () => {
  const wake = createWake({ onSubmitted: async () => { throw new Error('boom'); } });
  const out = await wake.notifySubmitted(submitted('sg_bad', [['声音', '耳语', 3]]));
  assert.strictEqual(out.woke, false);
  assert.strictEqual(out.error, 'boom');
});

test('notify:两个出口都没配 → 什么也不做', async () => {
  const out = await createWake({}).notifySubmitted(submitted('sg_no', [['声音', '耳语', 3]]));
  assert.deepStrictEqual(out, { woke: false, via: 'none' });
});

test('notify:webhook 收到 {event, review, prompt}', async () => {
  const got = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      got.push({ method: req.method, type: req.headers['content-type'], body: JSON.parse(body) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + server.address().port + '/hook';

  const wake = createWake({ webhookUrl: url });
  const out = await wake.notifySubmitted(submitted('sg_hook', [['声音', '耳语', 4]]));
  assert.strictEqual(out.woke, true);
  assert.strictEqual(out.via, 'webhook');
  assert.strictEqual(out.status, 200);
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].method, 'POST');
  assert.match(got[0].type, /application\/json/);
  assert.strictEqual(got[0].body.event, 'sigillo.submitted');
  assert.strictEqual(got[0].body.review.id, 'sg_hook');
  assert.ok(got[0].body.prompt.includes('· 声音·耳语 ★4'));

  await new Promise((r) => server.close(r));
});

test('notify:webhook 连不上也不外抛', async () => {
  // 127.0.0.1:1 上没有东西在听
  const wake = createWake({ webhookUrl: 'http://127.0.0.1:1/nope' });
  const out = await wake.notifySubmitted(submitted('sg_dead', [['声音', '耳语', 3]]));
  assert.strictEqual(out.woke, false);
  assert.ok(out.error);
});
