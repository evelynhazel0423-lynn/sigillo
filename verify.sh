#!/bin/sh
# 验收 A:开单(agent 工具)→ 封缄(HTTP)→ 唤醒落盘 → 复盘钉单 → turnTail
#         → 冷却触发(连两单高星)
DIR=/var/minis/workspace/sigillo
TOKEN=$(cat $DIR/data/token)
BASE=http://localhost:8087

node -e "
const { createStore } = require('$DIR/lib/store.cjs');
const { createTools } = require('$DIR/lib/tools.cjs');
const S = () => createStore({ file: '$DIR/data/sigillo.json' });
const T = () => createTools(S());

(async () => {
  // ---- 第一单 ----
  console.log('== 1) 开单(sigillo_create) ==');
  const a = JSON.parse(await T().handlers.sigillo_create({
    context: '验收A·第一单',
    env_note: '请查收。',
    sealed_note: '已回执。',
    items: [
      { dim:'节奏', tag:'慢起', label:'开头什么都没做,先让人把气喘匀' },
      { dim:'声音', tag:'耳语', label:'说话音量一直压得很低' },
      { dim:'新尝试', tag:'蒙眼', label:'第一次蒙眼,手一直握着我的手腕' },
      { dim:'事后', tag:'毯子', label:'结束后先递水再盖毯子' },
      { dim:'高潮管制', tag:'边缘', label:'三次带到门口才让落地' }
    ]
  }));
  console.log(JSON.stringify(a));
  const ID = a.id;

  // ---- 封缄(人类走 HTTP 卡片) ----
  console.log('\n== 2) 封缄(你打星,HTTP) ==');
  const { execSync } = require('child_process');
  const sub = execSync('curl -s -m 10 -X POST -H \"x-sigillo-token: $TOKEN\" -H \'content-type: application/json\' ' +
    '-d \'{\"fixed\":{\"foreplay\":90,\"process\":95,\"aftercare\":100},\"stars\":[5,4.5,5,5,4],\"notes\":[\"\",\"\",\"\",\"\",\"手抓紧的时候我才停\"],\"suggest\":\"别急着收尾\"}\' ' +
    '$BASE/api/sigillo/' + ID + '/submit').toString();
  const r = JSON.parse(sub).review;
  console.log('status:', r.status, '| stars:', r.items.map(i => i.dim + '★' + i.star).join(' '));

  // ---- 唤醒落盘 ----
  console.log('\n== 3) 唤醒落盘(我从 /internal/wake 取) ==');
  await new Promise(res => setTimeout(res, 400));
  const w = JSON.parse(execSync('curl -s -m 5 $BASE/internal/wake').toString());
  console.log('pending:', w.pending);
  console.log(w.notes[0].prompt);

  // ---- 复盘钉单 ----
  console.log('\n== 4) 复盘钉单(sigillo_note) ==');
  console.log(JSON.parse(await T().handlers.sigillo_note({
    id: ID,
    note: '蒙眼那次她手一直在找我的手腕——那不是害怕,是需要确认我在。下次先把手放到她能握住的地方再开始。'
  })));

  // ---- 第二单:复读高星项,触发冷却 ----
  console.log('\n== 5) 第二单(故意复读,看冷却) ==');
  const b = JSON.parse(await T().handlers.sigillo_create({
    context: '验收A·第二单',
    items: [
      { dim:'节奏', tag:'慢起', label:'又来,看剔不剔' },
      { dim:'声音', tag:'耳语', label:'也再来' },
      { dim:'新尝试', tag:'蒙眼', label:'也再来' },
      { dim:'入口', tag:'咬', label:'新花样' }
    ]
  }));
  console.log('第二单:', b.id, 'dropped:', JSON.stringify(b.dropped));
  execSync('curl -s -m 10 -X POST -H \"x-sigillo-token: $TOKEN\" -H \'content-type: application/json\' ' +
    '-d \'{\"fixed\":{\"foreplay\":80,\"process\":85,\"aftercare\":90},\"stars\":[5,4.5,5,3],\"notes\":[\"\",\"\",\"\",\"\"],\"suggest\":\"\"}\' ' +
    '$BASE/api/sigillo/' + b.id + '/submit > /dev/null');

  // ---- turnTail ----
  console.log('\n== 6) turnTail(下一场注回给我的素材块) ==');
  console.log(S().turnTail({ active: true }));

  // ---- 第三单:验证冷却真的剔项 ----
  console.log('\n== 7) 第三单(冷却名单里的项该被剔) ==');
  const c = JSON.parse(await T().handlers.sigillo_create({
    context: '验收A·第三单',
    items: [
      { dim:'节奏', tag:'慢起', label:'第三次,该被剔' },
      { dim:'声音', tag:'耳语', label:'该被剔' },
      { dim:'新尝试', tag:'蒙眼', label:'该被剔' },
      { dim:'道具', tag:'丝带', label:'新花样' }
    ]
  }));
  console.log('kept:', c.kept, 'dropped:', JSON.stringify(c.dropped));
})();
" 2>&1