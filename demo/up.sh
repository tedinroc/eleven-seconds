#!/usr/bin/env bash
# Start the whole demo stack: 3 sentinels, driver, AI reporter, war room (and anvil in replay mode).
#
#   KEY_DIR=<dir with sentinel1..3.key, admin.key, approver.key> demo/up.sh testnet
#   demo/up.sh replay        # local anvil on 8545 with a fresh deployment (anvil's public test accounts)
#
# Logs and PIDs go to .demo/ (git-ignored). Stop everything with demo/down.sh (it only kills the PIDs it started).
# Options: LLM_DISABLE=0 to let the reporter use the local model (default 1 = templates only).
set -euo pipefail
MODE="${1:-testnet}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
D="$ROOT/.demo"; mkdir -p "$D"
export PATH="$HOME/.foundry/bin:$PATH" TZ=Asia/Shanghai
cd "$ROOT"

busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
for p in 8700 8701 8702 8703 8710 5173; do busy "$p" && { echo "port $p is already in use; run demo/down.sh first" >&2; exit 1; }; done
: > "$D/pids"
start() { # name, command...
  local name="$1"; shift
  nohup "$@" > "$D/$name.log" 2>&1 &
  echo "$! $name" >> "$D/pids"
}

case "$MODE" in
  replay)
    busy 8545 && { echo "port 8545 is already in use" >&2; exit 1; }
    start anvil anvil --network monad -b 0.3 --port 8545
    sleep 2
    RPC_URL=http://127.0.0.1:8545 bash script/deploy.sh > "$D/deploy.log" 2>&1 || { echo "deploy failed, see .demo/deploy.log" >&2; exit 1; }
    start sentinels sh sentinel/run.sh anvil
    (cd driver && start driver node server.mjs)
    URL="http://127.0.0.1:5173/?mode=replay" ;;
  testnet)
    : "${KEY_DIR:?set KEY_DIR to the folder holding sentinel1..3.key, admin.key and approver.key}"
    start sentinels env KEY_DIR="$KEY_DIR" sh sentinel/run.sh testnet
    (cd driver && start driver env DEPLOYMENT=10143 KEY_DIR="$KEY_DIR" DRIVER_BROADCAST=1 node server.mjs)
    URL="http://127.0.0.1:5173/?mode=testnet" ;;
  *) echo "usage: demo/up.sh testnet|replay" >&2; exit 1 ;;
esac
(cd reporter && start reporter env LLM_DISABLE="${LLM_DISABLE:-1}" npm start)
(cd web && start web npm run dev -- --host 127.0.0.1 --port 5173 --strictPort)

echo "waiting for services (TLS warm-up can take ~15 s on slow networks)..."
for i in $(seq 1 60); do
  ok=0
  for p in 8700 8701 8702 8703; do curl -s -m 2 "http://127.0.0.1:$p/health" | grep -q '"ok":true' && ok=$((ok+1)); done
  curl -s -m 2 -o /dev/null http://127.0.0.1:8710/health && ok=$((ok+1))
  curl -s -m 2 -o /dev/null http://127.0.0.1:5173/ && ok=$((ok+1))
  [ "$ok" = 6 ] && { echo "all 6 services ready after ${i}s"; break; }
  sleep 1
done
for p in 8701 8702 8703 8700 8710; do printf '%s ' "$p"; curl -s -m 3 "http://127.0.0.1:$p/health" | head -c 90; echo; done
echo "war room: $URL"
