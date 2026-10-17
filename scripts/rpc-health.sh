#!/usr/bin/env bash
# RPC health check: eth_chainId + eth_blockNumber against each endpoint, with latency.
# Usage: scripts/rpc-health.sh [url ...]     (defaults to the Monad testnet list below)
#        EXPECT_CHAIN_ID=10143 scripts/rpc-health.sh
set -uo pipefail

EXPECT_CHAIN_ID="${EXPECT_CHAIN_ID:-10143}"
if [ "$#" -gt 0 ]; then
  URLS=("$@")
else
  URLS=(
    https://testnet-rpc.monad.xyz
    https://rpc-testnet.monadinfra.com
    https://rpc.ankr.com/monad_testnet
    https://monad-testnet.drpc.org
    https://10143.rpc.thirdweb.com
    https://monad-testnet-rpc.huginn.tech
  )
fi

rpc() { # url method -> "http_code time_s body"
  curl -sS -m 6 -o /dev/stdout -w '\n%{http_code} %{time_total}' \
    -H 'content-type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$2\",\"params\":[]}" "$1" 2>&1
}

hex2dec() { printf '%d' "$1" 2>/dev/null || echo "?"; }

printf '%-42s %-6s %-9s %-12s %-8s %s\n' URL HTTP CHAIN BLOCK MS STATUS
ok_count=0
for u in "${URLS[@]}"; do
  out_c=$(rpc "$u" eth_chainId); meta_c=$(tail -n1 <<<"$out_c"); body_c=$(sed '$d' <<<"$out_c")
  out_b=$(rpc "$u" eth_blockNumber); meta_b=$(tail -n1 <<<"$out_b"); body_b=$(sed '$d' <<<"$out_b")
  code=${meta_b%% *}; secs=${meta_b##* }
  cid_hex=$(grep -o '"result":"0x[0-9a-fA-F]*"' <<<"$body_c" | cut -d'"' -f4)
  blk_hex=$(grep -o '"result":"0x[0-9a-fA-F]*"' <<<"$body_b" | cut -d'"' -f4)
  cid=$([ -n "$cid_hex" ] && hex2dec "$cid_hex" || echo "-")
  blk=$([ -n "$blk_hex" ] && hex2dec "$blk_hex" || echo "-")
  ms=$(awk -v s="$secs" 'BEGIN{printf "%d", s*1000}')
  status=OK
  if [ "$cid" != "$EXPECT_CHAIN_ID" ] || [ "$blk" = "-" ]; then
    status="FAIL $(grep -o '"message":"[^"]*"' <<<"$body_b$body_c" | head -n1)"
  else
    ok_count=$((ok_count + 1))
  fi
  printf '%-42s %-6s %-9s %-12s %-8s %s\n' "$u" "$code" "$cid" "$blk" "$ms" "$status"
done
echo "healthy: $ok_count/${#URLS[@]}"
[ "$ok_count" -gt 0 ]
