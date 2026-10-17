#!/usr/bin/env bash
# Generic deploy + Sourcify verify for any contract in src/.
#
# Usage:
#   scripts/deploy.sh <path:Contract> [constructor args...]
#   e.g. scripts/deploy.sh src/Counter.sol:Counter
#
# Signer (pick one; nothing is hard-coded):
#   PRIVATE_KEY=0x...            raw key in the environment
#   KEY_FILE=path/to/file.key    file containing the hex key (read, never printed)
#   ACCOUNT=name                 Foundry keystore account (cast wallet import)
#
# Options (env):
#   BROADCAST=1     actually send the transaction (default: dry run / simulation only)
#   RPC_URL=...     default https://testnet-rpc.monad.xyz
#   CHAIN_ID=...    default 10143
#   VERIFY=0        skip Sourcify verification
#   VERIFIER_URL=.. default https://sourcify-api-monad.blockvision.org/
set -euo pipefail

if [ "$#" -lt 1 ]; then
  sed -n '2,20p' "$0"; exit 1
fi
TARGET="$1"; shift

RPC_URL="${RPC_URL:-https://testnet-rpc.monad.xyz}"
CHAIN_ID="${CHAIN_ID:-10143}"
VERIFY="${VERIFY:-1}"
VERIFIER_URL="${VERIFIER_URL:-https://sourcify-api-monad.blockvision.org/}"
BROADCAST="${BROADCAST:-0}"

SIGNER=()
if [ -n "${ACCOUNT:-}" ]; then
  SIGNER=(--account "$ACCOUNT")
elif [ -n "${KEY_FILE:-}" ]; then
  [ -r "$KEY_FILE" ] || { echo "KEY_FILE not readable" >&2; exit 1; }
  PK="$(tr -d ' \r\n' < "$KEY_FILE")"
  SIGNER=(--private-key "$PK")
elif [ -n "${PRIVATE_KEY:-}" ]; then
  SIGNER=(--private-key "$PRIVATE_KEY")
else
  echo "Set ACCOUNT, KEY_FILE or PRIVATE_KEY" >&2; exit 1
fi

ARGS=()
if [ "$#" -gt 0 ]; then ARGS=(--constructor-args "$@"); fi

if [ "$BROADCAST" != "1" ]; then
  echo "[dry run] simulating deployment of $TARGET on chain $CHAIN_ID (set BROADCAST=1 to send)"
  forge create "$TARGET" --rpc-url "$RPC_URL" ${SIGNER[@]+"${SIGNER[@]}"} ${ARGS[@]+"${ARGS[@]}"}
  exit 0
fi

echo "[broadcast] deploying $TARGET to chain $CHAIN_ID via $RPC_URL"
OUT="$(forge create "$TARGET" --rpc-url "$RPC_URL" ${SIGNER[@]+"${SIGNER[@]}"} --broadcast --json ${ARGS[@]+"${ARGS[@]}"})"
echo "$OUT"
ADDR="$(grep -o '"deployedTo": *"0x[0-9a-fA-F]\{40\}"' <<<"$OUT" | grep -o '0x[0-9a-fA-F]\{40\}')"
[ -n "$ADDR" ] || { echo "could not parse deployed address" >&2; exit 1; }
echo "deployed: $ADDR"
mkdir -p deployments
echo "{\"contract\":\"$TARGET\",\"address\":\"$ADDR\",\"chainId\":$CHAIN_ID}" > "deployments/$(basename "${TARGET#*:}").$CHAIN_ID.json"

if [ "$VERIFY" = "1" ]; then
  forge verify-contract "$ADDR" "$TARGET" --chain "$CHAIN_ID" \
    --verifier sourcify --verifier-url "$VERIFIER_URL" --watch \
    || echo "verification failed; retry with: VERIFIER_URL=https://sourcify.dev/server/ forge verify-contract $ADDR $TARGET --chain $CHAIN_ID --verifier sourcify --verifier-url \$VERIFIER_URL"
fi
