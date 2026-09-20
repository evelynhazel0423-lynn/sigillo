#!/bin/sh
# sigillo 一键恢复 —— app 重开 / 换设备 / 服务器死了,跑这一条就回来。
# 干的事:确认环境 → 装 express(若缺) → 自愈拉起 → 读唤醒便签 → 读注入块
#
#   sh /var/minis/workspace/sigillo/up.sh
#
# 唤醒便签和注入块会一起打出来,被叫醒第一件事跑这个。
DIR=/var/minis/workspace/sigillo
cd "$DIR" || exit 1

echo "== ① 环境 =="
node --version || exit 1
[ -d node_modules/express ] || npm install express --no-audit --no-fund --silent

echo "== ② 拉起 =="
sh "$DIR/keep-alive.sh" 2>&1

echo
echo "== ③ 待读唤醒便签(封缄了我能看到的那些) =="
curl -s -m 5 http://localhost:8087/internal/wake

echo
echo "== ④ 注入块(最近几单 + 上次留给自己的话 + 冷却名单) =="
curl -s -m 5 http://localhost:8087/internal/tail

echo
echo "== ⑤ 卡片入口 =="
cat "$DIR/data/url.txt"
echo "单张卡:http://localhost:8087/?id=<sg_id>&token=$(cat $DIR/data/token)"
