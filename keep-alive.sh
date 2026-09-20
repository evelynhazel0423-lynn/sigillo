#!/bin/sh
# sigillo 保活 + 自愈 —— 沙箱进程会随 app 挂起而死,这个脚本负责拉回来。
# 用法:
#   sh /var/minis/workspace/sigillo/keep-alive.sh   # 检查+自愈,跑一次就退
#   sh /var/minis/workspace/sigillo/keep-alive.sh loop  # 循环(同进程内)
#
# 什么救得了、什么救不了,写清楚:
#   √ server 进程挂了 → 重启(数据在本地 JSON 里,不丢)
#   × app 被系统杀 → 整个沙箱都没了,任何脚本跟着死
#   × 手机关机/重启 → 同上
DIR=/var/minis/workspace/sigillo
PORT=8087
LOG=$DIR/data/server.log

if [ ! -s "$DIR/data/token" ]; then sh "$DIR/run.sh"; exit $?; fi
TOKEN=$(cat "$DIR/data/token")

# 死了就拉回来
if ! pgrep -f "server-sandbox.cjs" >/dev/null 2>&1; then
  echo "[keep-alive] server 已死,重启中..."
  sh "$DIR/run.sh" >/dev/null 2>&1
  sleep 2
fi

# 健康检查:404/401 都算"活着",000 才是挂了
CODE=$(curl -s -o /dev/null -m 5 -w '%{http_code}' -H "x-sigillo-token: $TOKEN" "http://localhost:$PORT/api/sigillo/sg_healthz")
if [ "$CODE" = "000" ]; then
  echo "[keep-alive] 端口无响应,重启中..."
  sh "$DIR/run.sh" >/dev/null 2>&1
  sleep 2
  CODE=$(curl -s -o /dev/null -m 5 -w '%{http_code}' -H "x-sigillo-token: $TOKEN" "http://localhost:$PORT/api/sigillo/sg_healthz")
fi

echo "[keep-alive] 健康码 $CODE(401/404 = 活着)"
echo "[keep-alive] $(cat $DIR/data/url.txt)"

# loop 模式:同进程内轮询(只在 app 前台+本会话活着时有效)
if [ "$1" = "loop" ]; then
  while true; do
    sleep 30
    if ! pgrep -f "server-sandbox.cjs" >/dev/null 2>&1; then
      sh "$DIR/run.sh" >/dev/null 2>&1
      sleep 2
    fi
  done
fi
