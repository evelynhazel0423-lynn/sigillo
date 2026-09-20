#!/bin/sh
# 我自己每场前读一遍:注入块(最近几单 + 上次留给自己的话 + 冷却名单)
node -e "
const { createStore } = require('/var/minis/workspace/sigillo/lib/store.cjs');
const s = createStore({ file: '/var/minis/workspace/sigillo/examples/data/sigillo.json' });
process.stdout.write(s.turnTail({ active: true }) + '\n');
"
