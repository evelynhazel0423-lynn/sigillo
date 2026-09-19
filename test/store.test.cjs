'use strict';
/**
 * lib/store.cjs 单测。
 * 跑:node --test  (或 node --test test/store.test.cjs)
 *
 * 全程在 os.tmpdir() 里开临时库,跑完删目录。夹具数据都是现编的示例。
 *
 * 覆盖不到的几处(靠人工 review):
 *   - lib/routes.cjs 的三条路由(状态码映射见 e.code)以及 submit 成功后的唤醒挂钩;
 *   - lib/wake.cjs 的 HTTP 部分(纯函数 buildNote 在 wake.test.cjs 里测);
 *   - lib/tools.cjs 的 description 措辞与前端卡片渲染。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createStore } = require('../lib/store.cjs');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sigillo-store-test-'));
const TMP_FILE = path.join(TMP_DIR, 'sigillo.json');
const store = createStore({ file: TMP_FILE });

process.on('exit', () => {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { /* noop */ }
});

function reset() {
  try { fs.unlinkSync(TMP_FILE); } catch (_) { /* 不存在就算了 */ }
}

function seed(reviews) {
  fs.writeFileSync(TMP_FILE, JSON.stringify({ reviews: reviews }, null, 2), 'utf8');
}

// 造一张已封缄的单;items = [[dim, tag, star, note?], ...]。
// fixed 取整星/半星的干净值:80/90/60 → 4 / 4.5 / 3。
// 时间用 12:00Z:UTC±11 以内的时区跑出来都是同一天,mmdd 断言不会随机器飘。
function submitted(id, day, items, over) {
  return Object.assign({
    id: id,
    created_at: '2026-09-' + day + 'T11:00:00.000Z',
    status: 'submitted',
    submitted_at: '2026-09-' + day + 'T12:00:00.000Z',
    context: '',
    fixed: { foreplay: 80, process: 90, aftercare: 60 },
    items: items.map(([dim, tag, star, note]) => ({
      dim: dim,
      tag: tag,
      label: tag + '的具体描述',
      star: star,
      note: note || ''
    })),
    note: ''
  }, over || {});
}

// 更老的形状:items 只有三态判断词没有 star(星数改版之前落盘的单)。
function legacySubmitted(id, day, items, over) {
  return Object.assign({
    id: id,
    created_at: '2026-09-' + day + 'T11:00:00.000Z',
    status: 'submitted',
    submitted_at: '2026-09-' + day + 'T12:00:00.000Z',
    context: '',
    fixed: { foreplay: 80, process: 90, aftercare: 60 },
    items: items.map(([dim, tag, verdict]) => ({
      dim: dim, tag: tag, label: tag + '的具体描述', verdict: verdict
    })),
    note: ''
  }, over || {});
}

const OK_ITEMS = [
  { dim: '节奏', tag: '慢起', label: '开头很久什么都没发生' },
  { dim: '道具', tag: '冰块', label: '从杯子里拿的那块冰,含到化' }
];

// ── createReview 校验 ──

test('create:items 空 / 非数组 → 报错', () => {
  reset();
  assert.throws(() => store.createReview({ items: [] }), /不能为空/);
  assert.throws(() => store.createReview({}), /不能为空/);
});

test('create:超过 8 条 → 报错', () => {
  reset();
  const nine = Array.from({ length: 9 }, (_, i) => ({ dim: '节奏', tag: 't' + i, label: 'L' + i }));
  assert.throws(() => store.createReview({ items: nine }), /最多 8 条/);
});

test('create:dim 不在维度池 / tag 空 / tag 超 20 / label 空 / label 超 120 → 报错', () => {
  reset();
  assert.throws(() => store.createReview({ items: [{ dim: '飞天', tag: 'a', label: 'b' }] }), /不在维度池/);
  assert.throws(() => store.createReview({ items: [{ dim: '节奏', tag: '  ', label: 'b' }] }), /tag 不能为空/);
  assert.throws(() => store.createReview({ items: [{ dim: '节奏', tag: 'x'.repeat(21), label: 'b' }] }), /tag 超过 20 字/);
  assert.throws(() => store.createReview({ items: [{ dim: '节奏', tag: 'a', label: '' }] }), /label 不能为空/);
  assert.throws(() => store.createReview({ items: [{ dim: '节奏', tag: 'a', label: 'x'.repeat(121) }] }), /label 超过 120 字/);
});

test('create:正常开单 → pending 结构齐全(items 只有 star:null/note:""),落盘', () => {
  reset();
  const r = store.createReview({ items: OK_ITEMS, context: '周六下午' });
  assert.match(r.review.id, /^sg_[0-9a-z]+$/);
  assert.strictEqual(r.review.status, 'pending');
  assert.strictEqual(r.review.submitted_at, null);
  assert.strictEqual(r.review.context, '周六下午');
  assert.strictEqual(r.review.env_note, '');
  assert.strictEqual(r.review.sealed_note, '');
  assert.deepStrictEqual(r.review.fixed, { foreplay: null, process: null, aftercare: null });
  assert.strictEqual(r.review.note, '');
  assert.strictEqual(r.review.filled_by, undefined, '空白单不该带 filled_by');
  assert.strictEqual(r.review.items.length, 2);
  assert.deepStrictEqual(r.review.items[0],
    { dim: '节奏', tag: '慢起', label: '开头很久什么都没发生', star: null, note: '' });
  assert.deepStrictEqual(r.dropped, []);

  const onDisk = JSON.parse(fs.readFileSync(TMP_FILE, 'utf8'));
  assert.strictEqual(onDisk.reviews.length, 1);
  assert.strictEqual(onDisk.reviews[0].id, r.review.id);
});

test('create:最多留 200 单,超出裁最旧', () => {
  reset();
  const old = Array.from({ length: 200 }, (_, i) => ({
    id: 'sg_old' + i, created_at: '2026-01-01T00:00:00.000Z', status: 'pending',
    submitted_at: null, context: '', fixed: { foreplay: null, process: null, aftercare: null },
    items: [{ dim: '节奏', tag: 't', label: 'L', star: null, note: '' }], note: ''
  }));
  seed(old);
  store.createReview({ items: OK_ITEMS });
  const onDisk = JSON.parse(fs.readFileSync(TMP_FILE, 'utf8'));
  assert.strictEqual(onDisk.reviews.length, 200);
  assert.strictEqual(onDisk.reviews[0].id, 'sg_old1');   // sg_old0 被裁掉
});

test('create:maxReviews 等常量可通过 options 调', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigillo-opts-'));
  const small = createStore({ file: path.join(dir, 'db.json'), maxReviews: 2, maxItems: 1 });
  small.createReview({ items: [{ dim: '节奏', tag: 'a', label: 'A' }] });
  small.createReview({ items: [{ dim: '节奏', tag: 'b', label: 'B' }] });
  small.createReview({ items: [{ dim: '节奏', tag: 'c', label: 'C' }] });
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'));
  assert.strictEqual(onDisk.reviews.length, 2);
  assert.throws(() => small.createReview({
    items: [{ dim: '节奏', tag: 'a', label: 'A' }, { dim: '道具', tag: 'b', label: 'B' }]
  }), /最多 1 条/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('create:自定义维度池生效', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigillo-dims-'));
  const custom = createStore({ file: path.join(dir, 'db.json'), dims: ['pace', 'touch'] });
  assert.deepStrictEqual(custom.DIMS, ['pace', 'touch']);
  const r = custom.createReview({ items: [{ dim: 'pace', tag: 'slow', label: 'took our time' }] });
  assert.strictEqual(r.review.items[0].dim, 'pace');
  assert.throws(() => custom.createReview({ items: [{ dim: '节奏', tag: 'a', label: 'b' }] }), /不在维度池/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── createReview:env_note / sealed_note ──

test('create:env_note/sealed_note 存取,超 40 字报错,缺省为 ""', () => {
  reset();
  const r1 = store.createReview({ items: OK_ITEMS, env_note: '请查收呀', sealed_note: '已回执啦' });
  assert.strictEqual(r1.review.env_note, '请查收呀');
  assert.strictEqual(r1.review.sealed_note, '已回执啦');

  reset();
  const r2 = store.createReview({ items: OK_ITEMS });
  assert.strictEqual(r2.review.env_note, '');
  assert.strictEqual(r2.review.sealed_note, '');

  reset();
  const r3 = store.createReview({ items: OK_ITEMS, env_note: '  请查收。  ' });
  assert.strictEqual(r3.review.env_note, '请查收。'); // trim 后再存

  reset();
  assert.throws(() => store.createReview({ items: OK_ITEMS, env_note: 'x'.repeat(41) }), /env_note 超过 40 字/);
  reset();
  assert.throws(() => store.createReview({ items: OK_ITEMS, sealed_note: 'x'.repeat(41) }), /sealed_note 超过 40 字/);
  reset();
  assert.throws(() => store.createReview({ items: OK_ITEMS, env_note: 123 }), /env_note 必须是字符串/);
});

// ── 好评冷却(benchedNow / create 剔除)—— 吃裸星数,≥4 星算高星 ──

test('benchedNow:连两单同 (dim,tag) 都 ≥4 星 → 进冷却(半星 4.5 也算)', () => {
  reset();
  seed([
    submitted('sg_a', '17', [['节奏', '慢起', 4.5], ['道具', '冰块', 5]]),
    submitted('sg_b', '18', [['节奏', '慢起', 4], ['道具', '冰块', 3.5]])
  ]);
  assert.deepStrictEqual(store.benchedNow(), [{ dim: '节奏', tag: '慢起' }]);
});

test('benchedNow:只有一单 / 只高星一次 / 只出现一次 → 不冷却', () => {
  reset();
  assert.deepStrictEqual(store.benchedNow(), []);

  seed([submitted('sg_a', '18', [['节奏', '慢起', 5]])]);
  assert.deepStrictEqual(store.benchedNow(), []);

  seed([
    submitted('sg_a', '17', [['节奏', '慢起', 5]]),
    submitted('sg_b', '18', [['节奏', '慢起', 1]])
  ]);
  assert.deepStrictEqual(store.benchedNow(), []);

  seed([
    submitted('sg_a', '17', [['节奏', '慢起', 5]]),
    submitted('sg_b', '18', [['道具', '冰块', 5]])
  ]);
  assert.deepStrictEqual(store.benchedNow(), []);
});

test('benchedNow:3.5 星差半颗不算高星 → 不冷却', () => {
  reset();
  seed([
    submitted('sg_a', '17', [['节奏', '慢起', 4]]),
    submitted('sg_b', '18', [['节奏', '慢起', 3.5]])
  ]);
  assert.deepStrictEqual(store.benchedNow(), []);
});

test('benchedNow:老形状数据(只有判断词无 star)兼容兜底仍认 again', () => {
  reset();
  seed([
    legacySubmitted('sg_a', '17', [['节奏', '慢起', 'again']]),
    legacySubmitted('sg_b', '18', [['节奏', '慢起', 'again']])
  ]);
  assert.deepStrictEqual(store.benchedNow(), [{ dim: '节奏', tag: '慢起' }]);

  // 有 star 时以 star 为准,不再回头看判断词(老单被重打成低星就该解冻)
  reset();
  seed([
    submitted('sg_a', '17', [['节奏', '慢起', 2]], {}),
    legacySubmitted('sg_b', '18', [['节奏', '慢起', 'again']])
  ]);
  assert.deepStrictEqual(store.benchedNow(), []);
});

test('create:冷却项被剔除,dropped 里报出来', () => {
  reset();
  seed([
    submitted('sg_a', '17', [['节奏', '慢起', 5]]),
    submitted('sg_b', '18', [['节奏', '慢起', 4]])
  ]);
  const r = store.createReview({ items: OK_ITEMS });
  assert.deepStrictEqual(r.dropped, [{ dim: '节奏', tag: '慢起' }]);
  assert.strictEqual(r.review.items.length, 1);
  assert.strictEqual(r.review.items[0].tag, '冰块');
});

test('create:全被冷却 → 报错「全被冷却了,换新花样再开单」', () => {
  reset();
  seed([
    submitted('sg_a', '17', [['节奏', '慢起', 5], ['道具', '冰块', 4]]),
    submitted('sg_b', '18', [['节奏', '慢起', 4], ['道具', '冰块', 5]])
  ]);
  assert.throws(() => store.createReview({ items: OK_ITEMS }), /全被冷却了,换新花样再开单/);
});

test('benchedNow:只看最近两单,更早的不算', () => {
  reset();
  seed([
    submitted('sg_a', '10', [['节奏', '慢起', 5]]),
    submitted('sg_b', '11', [['节奏', '慢起', 5]]),
    submitted('sg_c', '12', [['声音', '耳语', 3]]),
    submitted('sg_d', '13', [['声音', '耳语', 3]])
  ]);
  assert.deepStrictEqual(store.benchedNow(), []);
});

test('benchedNow:benchWindow / highStar 可调', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigillo-bench-'));
  const file = path.join(dir, 'db.json');
  const loose = createStore({ file: file, benchWindow: 1, highStar: 3 });
  fs.writeFileSync(file, JSON.stringify({
    reviews: [submitted('sg_a', '18', [['节奏', '慢起', 3]])]
  }), 'utf8');
  assert.deepStrictEqual(loose.benchedNow(), [{ dim: '节奏', tag: '慢起' }]);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── 好评冷却:端到端走真实 submitReview(stars) ──

test('冷却端到端:连两单 4.5 星 + 4 星 → 第三张 create 剔除该项', () => {
  reset();
  const solo = [{ dim: '节奏', tag: '慢起', label: 'A' }];
  const good = { foreplay: 80, process: 80, aftercare: 80 };

  const r1 = store.createReview({ items: solo });
  store.submitReview(r1.review.id, { fixed: good, stars: [4.5] });
  const r2 = store.createReview({ items: solo });
  store.submitReview(r2.review.id, { fixed: good, stars: [4] });

  const r3 = store.createReview({ items: OK_ITEMS }); // 含 节奏·慢起 + 道具·冰块
  assert.deepStrictEqual(r3.dropped, [{ dim: '节奏', tag: '慢起' }]);
  assert.strictEqual(r3.review.items.length, 1);
  assert.strictEqual(r3.review.items[0].tag, '冰块');
});

test('冷却端到端:4 星 + 3.5 星 → 不冷却,不剔除', () => {
  reset();
  const solo = [{ dim: '节奏', tag: '慢起', label: 'A' }];
  const good = { foreplay: 80, process: 80, aftercare: 80 };

  const r1 = store.createReview({ items: solo });
  store.submitReview(r1.review.id, { fixed: good, stars: [4] });
  const r2 = store.createReview({ items: solo });
  store.submitReview(r2.review.id, { fixed: good, stars: [3.5] });

  const r3 = store.createReview({ items: OK_ITEMS });
  assert.deepStrictEqual(r3.dropped, []);
  assert.strictEqual(r3.review.items.length, 2);
});

// ── submitReview ──

function fresh() {
  reset();
  return store.createReview({ items: OK_ITEMS }).review;
}

const GOOD_SUBMIT = {
  fixed: { foreplay: 80, process: 90, aftercare: 60 },
  stars: [5, 2],
  notes: ['这个留着', ''],
  suggest: '整体很好'
};

test('submit:正常提交 → star/note/状态/时间戳都写进去,review.note=suggest', () => {
  const rev = fresh();
  const out = store.submitReview(rev.id, GOOD_SUBMIT);
  assert.strictEqual(out.status, 'submitted');
  assert.ok(out.submitted_at);
  assert.deepStrictEqual(out.fixed, { foreplay: 80, process: 90, aftercare: 60 });
  assert.strictEqual(out.items[0].star, 5);
  assert.strictEqual(out.items[0].note, '这个留着');
  assert.strictEqual(out.items[1].star, 2);
  assert.strictEqual(out.items[1].note, '');
  assert.strictEqual(out.note, '整体很好');

  const reread = store.getReview(rev.id);
  assert.strictEqual(reread.status, 'submitted');
  assert.strictEqual(reread.items[1].star, 2);
});

test('submit:不派生三态判断词,items 里没有 verdict 字段', () => {
  const rev = fresh();
  const out = store.submitReview(rev.id, GOOD_SUBMIT);
  for (const it of out.items) {
    assert.ok(it.verdict === undefined || it.verdict === null, 'verdict 不该被写:' + it.verdict);
  }
  const onDisk = JSON.parse(fs.readFileSync(TMP_FILE, 'utf8'));
  assert.ok(!JSON.stringify(onDisk).includes('verdict'), '落盘 JSON 里不该出现 verdict');
});

test('submit:半星全阶梯原样落盘(1~5,0.5 步进)', () => {
  const good = { foreplay: 1, process: 1, aftercare: 1 };
  for (const star of [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5]) {
    reset();
    const rev = store.createReview({ items: [{ dim: '节奏', tag: 't', label: 'L' }] }).review;
    const out = store.submitReview(rev.id, { fixed: good, stars: [star] });
    assert.strictEqual(out.items[0].star, star, 'star=' + star + ' 应原样落盘');
  }
});

test('submit:fixed 缺键 / 非整数 / 越界 → 报错', () => {
  const rev = fresh();
  const bad = f => () => store.submitReview(rev.id, Object.assign({}, GOOD_SUBMIT, { fixed: f }));
  assert.throws(bad({ foreplay: 80, process: 80 }), /fixed\.aftercare/);
  assert.throws(bad({ foreplay: 80.5, process: 80, aftercare: 80 }), /fixed\.foreplay/);
  assert.throws(bad({ foreplay: -1, process: 80, aftercare: 80 }), /fixed\.foreplay/);
  assert.throws(bad({ foreplay: 101, process: 80, aftercare: 80 }), /fixed\.foreplay/);
  assert.throws(bad({ foreplay: 'abc', process: 80, aftercare: 80 }), /fixed\.foreplay/);
  assert.throws(() => store.submitReview(rev.id, {}), /fixed\.foreplay/); // 压根没给 fixed
  // 报错后不落盘,单子还是 pending
  assert.strictEqual(store.getReview(rev.id).status, 'pending');
});

test('submit:stars 长度不符 / 值非法 → 报错;半星 2.5 合法、0.25 步不合法', () => {
  const rev = fresh();
  assert.throws(() => store.submitReview(rev.id, Object.assign({}, GOOD_SUBMIT, { stars: [5] })), /一样长/);
  assert.throws(() => store.submitReview(rev.id, Object.assign({}, GOOD_SUBMIT, { stars: 'ok' })), /一样长/);
  assert.throws(() => store.submitReview(rev.id, Object.assign({}, GOOD_SUBMIT, { stars: [5, 0] })), /第 2 条 star/);
  assert.throws(() => store.submitReview(rev.id, Object.assign({}, GOOD_SUBMIT, { stars: [5, 0.5] })), /第 2 条 star/);
  assert.throws(() => store.submitReview(rev.id, Object.assign({}, GOOD_SUBMIT, { stars: [5, 6] })), /第 2 条 star/);
  assert.throws(() => store.submitReview(rev.id, Object.assign({}, GOOD_SUBMIT, { stars: [5, 5.5] })), /第 2 条 star/);
  assert.throws(() => store.submitReview(rev.id, Object.assign({}, GOOD_SUBMIT, { stars: [5, 2.25] })), /第 2 条 star/);
  assert.throws(() => store.submitReview(rev.id, Object.assign({}, GOOD_SUBMIT, { stars: [5, '3.5'] })), /第 2 条 star/);
  // 报错后不落盘,单子还是 pending
  assert.strictEqual(store.getReview(rev.id).status, 'pending');
  // 半星合法值正常提交
  const out = store.submitReview(rev.id, Object.assign({}, GOOD_SUBMIT, { stars: [4.5, 2.5] }));
  assert.strictEqual(out.items[0].star, 4.5);
  assert.strictEqual(out.items[1].star, 2.5);
});

test('submit:notes 长度不符 / 单条超 500 字 / 非字符串 → 报错;省略 notes → 每条空串', () => {
  let rev = fresh();
  assert.throws(() => store.submitReview(rev.id, Object.assign({}, GOOD_SUBMIT, { notes: ['只一条'] })), /notes 要和 items 一样长/);
  rev = fresh();
  assert.throws(() => store.submitReview(rev.id, Object.assign({}, GOOD_SUBMIT, { notes: 'nope' })), /notes 要和 items 一样长/);
  rev = fresh();
  assert.throws(() => store.submitReview(rev.id, Object.assign({}, GOOD_SUBMIT, { notes: ['x'.repeat(501), ''] })), /第 1 条 note 超过 500 字/);
  rev = fresh();
  assert.throws(() => store.submitReview(rev.id, Object.assign({}, GOOD_SUBMIT, { notes: [123, ''] })), /第 1 条 note 必须是字符串/);

  rev = fresh();
  const out = store.submitReview(rev.id, { fixed: GOOD_SUBMIT.fixed, stars: [5, 3] }); // 省略 notes
  assert.strictEqual(out.items[0].note, '');
  assert.strictEqual(out.items[1].note, '');
});

test('submit:suggest 非字符串 / 超 2000 字 → 报错;省略 suggest → 空串', () => {
  let rev = fresh();
  assert.throws(() => store.submitReview(rev.id, Object.assign({}, GOOD_SUBMIT, { suggest: 123 })), /suggest 必须是字符串/);
  assert.throws(() => store.submitReview(rev.id, Object.assign({}, GOOD_SUBMIT, { suggest: 'x'.repeat(2001) })), /suggest 超过 2000 字/);

  rev = fresh();
  const out = store.submitReview(rev.id, { fixed: GOOD_SUBMIT.fixed, stars: [5, 3] });
  assert.strictEqual(out.note, '');
});

test('submit:载荷里的未知字段 —— 传了也不落盘,不报错', () => {
  const rev = fresh();
  const out = store.submitReview(rev.id, Object.assign({}, GOOD_SUBMIT, { whatever: '不认识的字段' }));
  assert.strictEqual(out.whatever, undefined);
  assert.strictEqual(store.getReview(rev.id).whatever, undefined);
});

test('submit:重复提交 → code=already_submitted(路由映射 409)', () => {
  const rev = fresh();
  store.submitReview(rev.id, GOOD_SUBMIT);
  assert.throws(() => store.submitReview(rev.id, GOOD_SUBMIT), e => {
    assert.strictEqual(e.code, 'already_submitted');
    return true;
  });
});

test('submit:id 不存在 → code=not_found(路由映射 404);getReview → null', () => {
  reset();
  assert.throws(() => store.submitReview('sg_nope', GOOD_SUBMIT), e => {
    assert.strictEqual(e.code, 'not_found');
    return true;
  });
  assert.strictEqual(store.getReview('sg_nope'), null);
});

// ── setAgentNote(agent 写给下次自己的话) ──

test('setAgentNote:单不存在 → code=not_found', () => {
  reset();
  assert.throws(() => store.setAgentNote('sg_nope', '随便写点'), e => {
    assert.strictEqual(e.code, 'not_found');
    return true;
  });
});

test('setAgentNote:单还没封缄(pending)→ 报错,不落盘', () => {
  const rev = fresh();
  assert.throws(() => store.setAgentNote(rev.id, '想先写'), /这单还没封缄/);
  assert.strictEqual(store.getReview(rev.id).agent_note, undefined);
});

test('setAgentNote:note 非字符串 / 空 / 纯空白 / 超 500 字 → 报错', () => {
  const rev = fresh();
  store.submitReview(rev.id, GOOD_SUBMIT);
  assert.throws(() => store.setAgentNote(rev.id, 123), /note 必须是字符串/);
  assert.throws(() => store.setAgentNote(rev.id, ''), /note 不能为空/);
  assert.throws(() => store.setAgentNote(rev.id, '   \n  '), /note 不能为空/);
  assert.throws(() => store.setAgentNote(rev.id, '喵'.repeat(501)), /note 超过 500 字/);
  assert.strictEqual(store.getReview(rev.id).agent_note, undefined);
  // 正好 500 合法
  store.setAgentNote(rev.id, '喵'.repeat(500));
  assert.strictEqual(store.getReview(rev.id).agent_note.length, 500);
});

test('setAgentNote:正常写入(trim + agent_note_at)+ 重写覆盖', () => {
  const rev = fresh();
  store.submitReview(rev.id, GOOD_SUBMIT);
  const out = store.setAgentNote(rev.id, '  第三条那里其实是到了的,嘴上没承认  ');
  assert.strictEqual(out.agent_note, '第三条那里其实是到了的,嘴上没承认');
  assert.match(out.agent_note_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.strictEqual(store.getReview(rev.id).agent_note, '第三条那里其实是到了的,嘴上没承认');

  const again = store.setAgentNote(rev.id, '改主意了:下次先把灯关掉');
  assert.strictEqual(again.agent_note, '改主意了:下次先把灯关掉');
  assert.strictEqual(store.getReview(rev.id).agent_note, '改主意了:下次先把灯关掉');
});

// ── turnTail 注入块 ──

const HEADER = '[sigillo · 最近几单](人类伴侣亲手填的回执。星数和原话是素材,怎么解读、下一场怎么走是你的事;唯一硬规则:别复读冷却名单里的项)';

test('turnTail:active 门 —— 非 true 一律空串', () => {
  reset();
  seed([submitted('sg_a', '18', [['节奏', '慢起', 5]])]);
  assert.strictEqual(store.turnTail({ active: false }), '');
  assert.strictEqual(store.turnTail({}), '');
  assert.strictEqual(store.turnTail({ active: 'yes' }), '');
  assert.strictEqual(store.turnTail(), '');
});

test('turnTail:没有已封缄的单且无冷却 → 空串(pending 单不算)', () => {
  reset();
  assert.strictEqual(store.turnTail({ active: true }), '');
  store.createReview({ items: OK_ITEMS });
  assert.strictEqual(store.turnTail({ active: true }), '');
});

test('turnTail:头行是中性口径(素材不是指令,只留冷却硬规则)', () => {
  reset();
  seed([submitted('sg_a', '18', [['节奏', '慢起', 5]])]);
  const all = store.turnTail({ active: true });
  assert.strictEqual(all.split('\n')[0], HEADER);
  // 三态判断词一个都不许出现
  for (const word of ['再来', '换掉', '刚好', '还行']) {
    assert.ok(!all.includes(word), '注入块不该出现三态词:' + word);
  }
});

test('turnTail:每单一行中性事实 —— 全条目照列 + ★星数,空段落省略', () => {
  reset();
  seed([
    submitted('sg_a', '18', [['场景空间', '窗边', 5, '这个可以留着'], ['节奏', '慢起', 3], ['道具', '冰块', 1.5]],
      { note: '下次别急' }),
    submitted('sg_b', '17', [['声音', '耳语', 3]])
  ]);
  const lines = store.turnTail({ active: true }).split('\n');
  // 新在前:18 号那单先出;fixed 80/90/60 → 4 / 4.5 / 3
  assert.strictEqual(lines[1],
    '09-18 前戏4/过程4.5/事后3 | 场景空间·窗边★5「这个可以留着」,节奏·慢起★3,道具·冰块★1.5 | 建议:「下次别急」');
  // 没建议的整段省略
  assert.strictEqual(lines[2], '09-17 前戏4/过程4.5/事后3 | 声音·耳语★3');
  assert.strictEqual(lines.length, 3); // 无冷却 → 没有冷却行
});

test('turnTail:fixed 没打分显示 -,老形状 item 无 star 显示 ★-', () => {
  reset();
  seed([legacySubmitted('sg_a', '18', [['节奏', '慢起', 'again']],
    { fixed: { foreplay: null, process: null, aftercare: null } })]);
  const lines = store.turnTail({ active: true }).split('\n');
  assert.strictEqual(lines[1], '09-18 前戏-/过程-/事后- | 节奏·慢起★-');
});

test('turnTail:item 有备注则在 dim·tag★星 后追加「截 30 字」', () => {
  reset();
  seed([
    submitted('sg_a', '18', [
      ['节奏', '慢起', 5, 'x'.repeat(50)],
      ['道具', '冰块', 1, '有点太冷了,下次换温的']
    ])
  ]);
  const lines = store.turnTail({ active: true }).split('\n');
  assert.match(lines[1], /节奏·慢起★5「x{30}」/);
  assert.ok(!lines[1].includes('x'.repeat(31)));
  assert.match(lines[1], /道具·冰块★1「有点太冷了,下次换温的」/); // 未超 30 字,原样带上
});

test('turnTail:最多 3 单,整单建议截 80 字', () => {
  reset();
  seed([
    submitted('sg_a', '15', [['声音', '耳语', 3]]),
    submitted('sg_b', '16', [['声音', '耳语', 3]]),
    submitted('sg_c', '17', [['声音', '耳语', 3]]),
    submitted('sg_d', '18', [['声音', '耳语', 3]], { note: '啰'.repeat(200) })
  ]);
  const lines = store.turnTail({ active: true }).split('\n');
  assert.strictEqual(lines.length, 4); // 表头 + 3 单
  assert.ok(lines[1].endsWith('建议:「' + '啰'.repeat(80) + '」'));
});

test('turnTail:有冷却项时追一行冷却提示(文案吃裸星数)', () => {
  reset();
  seed([
    submitted('sg_a', '17', [['节奏', '慢起', 5]]),
    submitted('sg_b', '18', [['节奏', '慢起', 4]])
  ]);
  const lines = store.turnTail({ active: true }).split('\n');
  assert.strictEqual(lines[lines.length - 1],
    '冷却中(连 2 单≥4 星自动休眠,换个新花样):节奏·慢起');
});

// ── turnTail:agent 自己的留言(agent_note)注回 ──

test('turnTail:注最新一张带 agent_note 的单,旧的不翻', () => {
  reset();
  seed([
    submitted('sg_a', '16', [['声音', '耳语', 3]], { agent_note: '很旧的一条,不该出现' }),
    submitted('sg_b', '17', [['声音', '耳语', 3]], { agent_note: '说够了的时候其实还想要' }),
    submitted('sg_c', '18', [['节奏', '慢起', 5]])   // 最新这单他还没写
  ]);
  const out = store.turnTail({ active: true });
  const line = out.split('\n').find(l => l.startsWith('你上次留给自己的'));
  assert.strictEqual(line, '你上次留给自己的(09-17):「说够了的时候其实还想要」');
  assert.ok(!out.includes('很旧的一条'), '只注最新那条');
});

test('turnTail:一条 agent_note 都没有 → 没有这行', () => {
  reset();
  seed([submitted('sg_a', '18', [['节奏', '慢起', 5]])]);
  assert.ok(!store.turnTail({ active: true }).includes('你上次留给自己的'));

  // 空白字符串也当没写
  reset();
  seed([submitted('sg_b', '18', [['节奏', '慢起', 5]], { agent_note: '   ' })]);
  assert.ok(!store.turnTail({ active: true }).includes('你上次留给自己的'));
});

test('turnTail:agent_note 折行压平 + 截 300 字', () => {
  reset();
  seed([submitted('sg_a', '18', [['节奏', '慢起', 5]], { agent_note: '第一句\n\n第二句' })]);
  let line = store.turnTail({ active: true }).split('\n').find(l => l.startsWith('你上次留给自己的'));
  assert.strictEqual(line, '你上次留给自己的(09-18):「第一句 第二句」');

  reset();
  seed([submitted('sg_b', '18', [['节奏', '慢起', 5]], { agent_note: '喵'.repeat(400) })]);
  line = store.turnTail({ active: true }).split('\n').find(l => l.startsWith('你上次留给自己的'));
  assert.ok(line.includes('喵'.repeat(300) + '」'));
  assert.ok(!line.includes('喵'.repeat(301)));
});

test('turnTail:agent_note 端到端 —— submit + setAgentNote 之后注得回来', () => {
  reset();
  const rev = store.createReview({ items: OK_ITEMS }).review;
  store.submitReview(rev.id, GOOD_SUBMIT);
  assert.ok(!store.turnTail({ active: true }).includes('你上次留给自己的'));
  store.setAgentNote(rev.id, '冰块那条明显走神了');
  assert.ok(store.turnTail({ active: true }).includes('「冰块那条明显走神了」'));
});

test('turnTail:tailRecent 可调', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigillo-tail-'));
  const file = path.join(dir, 'db.json');
  const one = createStore({ file: file, tailRecent: 1 });
  fs.writeFileSync(file, JSON.stringify({
    reviews: [
      submitted('sg_a', '17', [['声音', '耳语', 3]]),
      submitted('sg_b', '18', [['声音', '耳语', 3]])
    ]
  }), 'utf8');
  assert.strictEqual(one.turnTail({ active: true }).split('\n').length, 2); // 表头 + 1 单
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── 兼容:旧形状数据(items 只有判断词,没有 star/note 字段) ──

test('兼容:旧形状数据(items 只有 verdict 无 star/note)读不炸,getReview 正常返回', () => {
  reset();
  seed([{
    id: 'sg_legacy1',
    created_at: '2026-09-18T19:36:21.487Z',
    status: 'pending',
    submitted_at: null,
    context: '周五很晚,雨一直没停',
    fixed: { foreplay: null, process: null, aftercare: null },
    items: [
      { dim: '节奏', tag: '慢起', label: '第一轮从很慢的那段开始', verdict: null },
      { dim: '声音', tag: '耳语', label: '一直压着嗓子说话', verdict: null }
    ],
    note: ''
  }]);

  const found = store.getReview('sg_legacy1');
  assert.ok(found);
  assert.strictEqual(found.status, 'pending');
  assert.strictEqual(found.items.length, 2);
  assert.strictEqual(found.items[0].star, undefined); // 旧形状确实没这个字段,读不炸就行

  // 其余读路径也不该炸(这张单是 pending,所以都是空结果)
  assert.deepStrictEqual(store.benchedNow(), []);
  assert.strictEqual(store.turnTail({ active: true }), '');
  assert.deepStrictEqual(store.recentSubmitted(3), []);
});

test('兼容:老库里残留的未知字段 → 直接无视,不注入不报错', () => {
  reset();
  seed([submitted('sg_a', '18', [['节奏', '慢起', 5]], { legacy_field: '早就拆掉的东西' })]);
  const out = store.turnTail({ active: true });
  assert.ok(!out.includes('早就拆掉的东西'));
  assert.ok(out.includes('节奏·慢起★5'));
});

// ── 损坏文件容错 ──

test('损坏/半截 JSON:读全部容错为空库,turnTail 不炸', () => {
  reset();
  fs.writeFileSync(TMP_FILE, '{"reviews":[{"id":"sg_a"', 'utf8');
  assert.strictEqual(store.getReview('sg_a'), null);
  assert.deepStrictEqual(store.benchedNow(), []);
  assert.strictEqual(store.turnTail({ active: true }), '');
  assert.deepStrictEqual(store.recentSubmitted(3), []);
  assert.throws(() => store.submitReview('sg_a', GOOD_SUBMIT), e => e.code === 'not_found');
  assert.throws(() => store.setAgentNote('sg_a', '写点什么'), e => e.code === 'not_found');
  // 覆盖式重建:开新单照常成功
  const r = store.createReview({ items: OK_ITEMS });
  assert.strictEqual(store.getReview(r.review.id).items.length, 2);
});

test('reviews 不是数组 / 顶层不是对象 → 空库', () => {
  reset();
  fs.writeFileSync(TMP_FILE, '{"reviews":"nope"}', 'utf8');
  assert.deepStrictEqual(store.recentSubmitted(3), []);
  fs.writeFileSync(TMP_FILE, '[]', 'utf8');
  assert.deepStrictEqual(store.recentSubmitted(3), []);
  reset(); // 文件根本不存在
  assert.deepStrictEqual(store.recentSubmitted(3), []);
});

// ── 反向回执(report 模式)──
// agent 开单时把星和评语直接填好,单出生即 submitted + filled_by:"agent",人类只读。

const REPORT_ITEMS = [
  { dim: '节奏', tag: '慢起', label: '开头那段拖得很长', star: 4.5, note: '这里撑住了' },
  { dim: '声音', tag: '耳语', label: '贴着耳朵数呼吸', star: 5 }
];
const REPORT_FIXED = { foreplay: 4, process: 4.5, aftercare: 5 };

test('report:全预填 → 出生即 submitted + filled_by:agent,fixed=星×20,star/note 原样,dropped 空', () => {
  reset();
  const r = store.createReview({ items: REPORT_ITEMS, fixed: REPORT_FIXED, note: '整体评语', context: '今晚' });
  assert.strictEqual(r.review.status, 'submitted');
  assert.ok(r.review.submitted_at);
  assert.strictEqual(r.review.filled_by, 'agent');
  assert.deepStrictEqual(r.review.fixed, { foreplay: 80, process: 90, aftercare: 100 });
  assert.strictEqual(r.review.items[0].star, 4.5);
  assert.strictEqual(r.review.items[0].note, '这里撑住了');
  assert.strictEqual(r.review.items[1].star, 5);
  assert.strictEqual(r.review.items[1].note, '');
  assert.strictEqual(r.review.note, '整体评语');
  assert.deepStrictEqual(r.dropped, []);
  const back = store.getReview(r.review.id);
  assert.strictEqual(back.filled_by, 'agent');
  assert.strictEqual(back.status, 'submitted');
});

test('report:填不完整/非法 → 报错,一张不落盘', () => {
  reset();
  const bare = REPORT_ITEMS.map(it => ({ dim: it.dim, tag: it.tag, label: it.label }));
  // 有 star 没 fixed / 只给整单 note 没 fixed → 进 report 模式即要求 fixed 每项
  assert.throws(() => store.createReview({ items: REPORT_ITEMS }), /fixed\.foreplay/);
  assert.throws(() => store.createReview({ items: bare, note: '只有评语' }), /fixed\.foreplay/);
  // fixed 缺键 / 星越界 / 0.25 步
  assert.throws(() => store.createReview({ items: REPORT_ITEMS, fixed: { foreplay: 4, process: 4.5 } }), /fixed\.aftercare/);
  assert.throws(() => store.createReview({ items: REPORT_ITEMS, fixed: { foreplay: 4, process: 4.5, aftercare: 5.5 } }), /fixed\.aftercare/);
  assert.throws(() => store.createReview({ items: REPORT_ITEMS, fixed: { foreplay: 4.25, process: 4.5, aftercare: 5 } }), /fixed\.foreplay/);
  // 条目星缺一条 / 星非法
  const halfStars = [REPORT_ITEMS[0], { dim: '声音', tag: '耳语', label: 'x' }];
  assert.throws(() => store.createReview({ items: halfStars, fixed: REPORT_FIXED }), /第 2 条 star/);
  const badStar = [Object.assign({}, REPORT_ITEMS[0], { star: 3.25 }), REPORT_ITEMS[1]];
  assert.throws(() => store.createReview({ items: badStar, fixed: REPORT_FIXED }), /第 1 条 star/);
  // note 超限
  const longNote = [Object.assign({}, REPORT_ITEMS[0], { note: 'x'.repeat(501) }), REPORT_ITEMS[1]];
  assert.throws(() => store.createReview({ items: longNote, fixed: REPORT_FIXED }), /第 1 条 note 超过 500 字/);
  assert.throws(() => store.createReview({ items: REPORT_ITEMS, fixed: REPORT_FIXED, note: 'x'.repeat(2001) }), /note 超过 2000 字/);
  // 全程一张都没落盘
  assert.deepStrictEqual(store.recentSubmitted(10), []);
});

test('report:不产生好评冷却 —— agent 填的连两单高星不入冷却,人类填的照旧', () => {
  reset();
  seed([
    submitted('sg_m1', '10', [['节奏', '慢起', 5]], { filled_by: 'agent' }),
    submitted('sg_m2', '11', [['节奏', '慢起', 4.5]], { filled_by: 'agent' })
  ]);
  assert.deepStrictEqual(store.benchedNow(), []);
  seed([
    submitted('sg_c1', '10', [['节奏', '慢起', 5]]),
    submitted('sg_c2', '11', [['节奏', '慢起', 4.5]]),
    submitted('sg_m3', '12', [['道具', '冰块', 5]], { filled_by: 'agent' })
  ]);
  // agent 的单也不占人类的冷却窗口:sg_m3 插在最近,冷却仍看 sg_c1/sg_c2
  assert.deepStrictEqual(store.benchedNow(), [{ dim: '节奏', tag: '慢起' }]);
});

test('report:开单不剔冷却项(记录真实发生的事);普通开单照剔', () => {
  reset();
  seed([
    submitted('sg_c1', '10', [['节奏', '慢起', 5]]),
    submitted('sg_c2', '11', [['节奏', '慢起', 4.5]])
  ]);
  const rep = store.createReview({
    items: [{ dim: '节奏', tag: '慢起', label: '还是那样拖着', star: 4 }],
    fixed: REPORT_FIXED
  });
  assert.strictEqual(rep.review.items.length, 1);
  assert.deepStrictEqual(rep.dropped, []);
  const norm = store.createReview({
    items: [
      { dim: '节奏', tag: '慢起', label: '再来一次' },
      { dim: '道具', tag: '冰块', label: '含到化' }
    ]
  });
  assert.deepStrictEqual(norm.dropped, [{ dim: '节奏', tag: '慢起' }]);
});

test('report:turnTail 不把 agent 填的单当人类的回执,人类的单照注', () => {
  reset();
  seed([
    submitted('sg_c1', '10', [['节奏', '慢起', 4]]),
    submitted('sg_m1', '12', [['道具', '冰块', 5]], { filled_by: 'agent', note: '他的评语' })
  ]);
  const tail = store.turnTail({ active: true });
  assert.ok(tail.includes('节奏·慢起'));
  assert.ok(!tail.includes('冰块'));
  assert.ok(!tail.includes('他的评语'));
  // 只有 agent 填的单、没冷却 → 整块不注
  seed([submitted('sg_m9', '12', [['道具', '冰块', 5]], { filled_by: 'agent' })]);
  assert.strictEqual(store.turnTail({ active: true }), '');
});

test('report:人类 submit 不了(already_submitted),agent 仍可 setAgentNote', () => {
  reset();
  const r = store.createReview({ items: REPORT_ITEMS, fixed: REPORT_FIXED });
  assert.throws(() => store.submitReview(r.review.id, {}), (e) => e.code === 'already_submitted');
  const noted = store.setAgentNote(r.review.id, '下次多数几拍再放手');
  assert.strictEqual(noted.agent_note, '下次多数几拍再放手');
});

// ── recentSubmitted ──

test('recentSubmitted:新在前,n 生效,pending 不算', () => {
  reset();
  seed([
    submitted('sg_a', '16', [['声音', '耳语', 3]]),
    submitted('sg_b', '18', [['声音', '耳语', 3]]),
    submitted('sg_c', '17', [['声音', '耳语', 3]])
  ]);
  assert.deepStrictEqual(store.recentSubmitted(2).map(r => r.id), ['sg_b', 'sg_c']);
  assert.deepStrictEqual(store.recentSubmitted(0), []);
  store.createReview({ items: OK_ITEMS });
  assert.strictEqual(store.recentSubmitted(10).length, 3);
});
