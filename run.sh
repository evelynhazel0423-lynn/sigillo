#!/bin/sh
# sigillo 启动器 —— setsid nohup,app 活着就在
DIR=/var/minis/workspace/sigillo
PORT=8087
TOKEN_FILE=$DIR/data/token
LOG=$DIR/data/server.log
PID=$DIR/data/server.pid

mkdir -p "$DIR/data"

if [ ! -s "$TOKEN_FILE" ]; then
  T=$(openssl rand -hex 24 2>/dev/null || head -c 32 /dev/urandom | base64 | tr -d '+/=' | head -c 32)
  printf '%s' "$T" > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
fi
TOKEN=$(cat "$TOKEN_FILE")

# 杀旧进程(pidfile + 按端口)
if [ -f "$PID" ]; then kill "$(cat "$PID")" 2>/dev/null; fi
pkill -f "examples/server.cjs" 2>/dev/null

cd "$DIR" || exit 1
setsid nohup env PORT=$PORT SIGILLO_TOKEN=$TOKEN node server-sandbox.cjs >> "$LOG" 2>&1 &
echo $! > "$PID"
sleep 2

# 健康检查
CODE=$(curl -s -o /dev/null -m 5 -w '%{http_code}' -H "x-sigillo-token: $TOKEN" "http://localhost:$PORT/api/sigillo/sg_healthz")
echo "pid=$(cat "$PID") port=$PORT healthz=$CODE(unauthorized=401 说明活着)"
printf 'http://localhost:%s/?token=%s\n' "$PORT" "$TOKEN" > "$DIR/data/url.txt"
cat "$DIR/data/url.txt"
