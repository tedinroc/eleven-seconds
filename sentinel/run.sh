#!/bin/sh
# Start the three sentinel processes (one key, one primary RPC and one SSE port each).
#
#   sh sentinel/run.sh anvil      # local replay: anvil's public test accounts 2/3/4, RPC 127.0.0.1:8545
#   sh sentinel/run.sh testnet    # Monad testnet 10143: keys from files named by env vars (see below)
#
# Common overrides (environment): DEPLOYMENTS, RPC_URL (anvil), BASE_PORT (default 8701), STRICT=1,
# SIM_TIMEOUT_MS, SIM_BUDGET_MS, DRY_RUN=1 (sign but never broadcast), ONLY=1,3 (start a subset).
# Testnet keys: KEY_DIR=<dir> (uses <dir>/sentinel1.key ...) or SENTINEL1_KEY_FILE..SENTINEL3_KEY_FILE.
# Key files hold one hex private key; they are read at run time and never printed.
set -eu
cd "$(dirname "$0")"
NET="${1:-anvil}"
BASE_PORT="${BASE_PORT:-8701}"
ONLY="${ONLY:-1,2,3}"

if [ ! -e node_modules/viem/package.json ]; then
  npm install --offline --no-audit --no-fund >/dev/null 2>&1 || {
    rm -rf node_modules
    ln -s ../scripts/node_modules node_modules
  }
fi

PIDS=""
cleanup() { for p in $PIDS; do kill "$p" 2>/dev/null || true; done; }
trap cleanup INT TERM EXIT

start() { # <index> then env assignments
  i="$1"; shift
  case ",$ONLY," in *",$i,"*) ;; *) return 0 ;; esac
  env SENTINEL_INDEX="$i" SSE_PORT="$((BASE_PORT + i - 1))" "$@" node src/main.mjs &
  PIDS="$PIDS $!"
}

case "$NET" in
  anvil)
    RPC="${RPC_URL:-http://127.0.0.1:8545}"
    for i in 1 2 3; do
      start "$i" NETWORK=anvil RPC_URL="$RPC" ANVIL_ACCOUNT="$((i + 1))"
    done
    ;;
  testnet)
    key() {
      eval "f=\${SENTINEL$1_KEY_FILE:-}"
      if [ -z "$f" ] && [ -n "${KEY_DIR:-}" ]; then f="$KEY_DIR/sentinel$1.key"; fi
      [ -n "$f" ] || { echo "set KEY_DIR or SENTINEL$1_KEY_FILE" >&2; exit 1; }
      [ -r "$f" ] || { echo "SENTINEL$1 key file is not readable" >&2; exit 1; }
      echo "$f"
    }
    K1="$(key 1)"; K2="$(key 2)"; K3="$(key 3)"
    SIM_OFFICIAL=https://testnet-rpc.monad.xyz
    SIM_THIRDWEB=https://10143.rpc.thirdweb.com
    # getLogs / heartbeat RPCs alternate between monadinfra and ankr (never the simulation RPCs);
    # WS only on the two providers that have it; simulation primary rotates official/thirdweb/official.
    start 1 NETWORK=testnet KEY_FILE="$K1" RPC_URL=https://rpc-testnet.monadinfra.com WS_URL=wss://rpc-testnet.monadinfra.com SIM_RPCS="$SIM_OFFICIAL,$SIM_THIRDWEB"
    start 2 NETWORK=testnet KEY_FILE="$K2" RPC_URL=https://rpc.ankr.com/monad_testnet WS_URL=wss://testnet-rpc.monad.xyz SIM_RPCS="$SIM_OFFICIAL,$SIM_THIRDWEB"
    start 3 NETWORK=testnet KEY_FILE="$K3" RPC_URL=https://rpc-testnet.monadinfra.com WS_URL=wss://rpc-testnet.monadinfra.com SIM_RPCS="$SIM_OFFICIAL,$SIM_THIRDWEB" POLL_OFFSET_MS=150
    ;;
  *)
    echo "usage: sh run.sh anvil|testnet" >&2
    exit 2
    ;;
esac
wait
