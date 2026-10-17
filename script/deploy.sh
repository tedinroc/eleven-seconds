#!/usr/bin/env bash
# Deploy the whole demo (script/Deploy.s.sol) and write shared/deployments/<anvil|chainId>.json.
#
#   RPC_URL=http://127.0.0.1:8545 script/deploy.sh          # anvil: broadcasts with anvil test accounts
#   RPC_URL=https://testnet-rpc.monad.xyz script/deploy.sh  # 10143: DRY RUN (simulation only)
#   RPC_URL=https://testnet-rpc.monad.xyz BROADCAST=1 script/deploy.sh   # 10143: really send
#
# Non-anvil chains read keys at run time from files named by environment variables (never printed):
#   DEPLOYER_KEY_FILE, ADMIN_KEY_FILE                      signers (hex private key, one line)
#   SENTINEL1_KEY_FILE..SENTINEL3_KEY_FILE, APPROVER_KEY_FILE   only to derive the role addresses;
#     alternatively pass SENTINEL1_ADDR..SENTINEL3_ADDR, APPROVER_ADDR directly.
#   KEY_DIR=dir   shorthand: any *_KEY_FILE not set defaults to $KEY_DIR/<label>.key
#                 (labels: deployer admin sentinel1 sentinel2 sentinel3 approver)
# Optional: HOLDERS=0xA,0xB,0xC (default: 3 keyless addresses), DELAY_BLOCKS (default 30).
set -euo pipefail
cd "$(dirname "$0")/.."

RPC_URL="${RPC_URL:-http://127.0.0.1:8545}"
CHAIN_ID="$(cast chain-id --rpc-url "$RPC_URL")"

if [ "$CHAIN_ID" = "31337" ]; then
  NAME=anvil
  BROADCAST="${BROADCAST:-1}"
else
  NAME="$CHAIN_ID"
  BROADCAST="${BROADCAST:-0}"
  read_key() { # <ENV_PREFIX> <label>  -> exports <ENV_PREFIX>_PK from the key file
    local var="$1_KEY_FILE" file
    file="${!var:-}"
    if [ -z "$file" ] && [ -n "${KEY_DIR:-}" ]; then file="$KEY_DIR/$2.key"; fi
    [ -n "$file" ] || return 1
    [ -r "$file" ] || { echo "$var is not readable" >&2; exit 1; }
    local pk
    pk="$(tr -d ' \r\n' < "$file")"
    case "$pk" in 0x*) ;; *) pk="0x$pk" ;; esac
    export "$1_PK=$pk"
  }
  read_key DEPLOYER deployer || { echo "set DEPLOYER_KEY_FILE (or KEY_DIR)" >&2; exit 1; }
  read_key ADMIN admin || { echo "set ADMIN_KEY_FILE (or KEY_DIR)" >&2; exit 1; }
  for r in SENTINEL1:sentinel1 SENTINEL2:sentinel2 SENTINEL3:sentinel3 APPROVER:approver; do
    p="${r%%:*}"; l="${r##*:}"; a="${p}_ADDR"
    if [ -z "${!a:-}" ]; then read_key "$p" "$l" || { echo "set ${p}_ADDR or ${p}_KEY_FILE" >&2; exit 1; }; fi
  done
fi

FLAGS=(--rpc-url "$RPC_URL" --offline)
if [ "$BROADCAST" = "1" ]; then
  OUT="${OUT_JSON:-shared/deployments/$NAME.json}"
  FLAGS+=(--broadcast --slow)
  echo "[broadcast] chain $CHAIN_ID -> $OUT"
else
  OUT="cache/deployment.$NAME.dryrun.json"
  echo "[dry run] chain $CHAIN_ID (simulation only; BROADCAST=1 to send) -> $OUT"
fi

OUT_JSON="$OUT" forge script script/Deploy.s.sol:Deploy "${FLAGS[@]}"

if [ "$BROADCAST" = "1" ]; then
  RUN="broadcast/Deploy.s.sol/$CHAIN_ID/run-latest.json"
  # Real deploy block = earliest receipt block of this run.
  BLOCK="$(node -e 'const r=require(process.argv[1]).receipts;console.log(Math.min(...r.map(x=>Number(BigInt(x.blockNumber)))))' "$PWD/$RUN")"
  tmp="$(mktemp)"
  jq --argjson b "$BLOCK" '.deployBlock = $b' "$OUT" > "$tmp" && mv "$tmp" "$OUT"
  echo "deployBlock = $BLOCK"
  # codehashes = keccak256 of the deployed runtime code (what extcodehash / Proposed.codehash report)
  for k in v1 v2 evilMint evilOwner evilFee paused; do
    a="$(jq -r ".impls.$k" "$OUT")"
    code="0x"; for _ in 1 2 3 4 5; do code="$(cast code "$a" --rpc-url "$RPC_URL" 2>/dev/null || echo 0x)"; [ "$code" != "0x" ] && break; sleep 1; done
    [ "$code" != "0x" ] || { echo "could not read code for $k at $a" >&2; exit 1; }
    h="$(cast keccak "$code")"
    tmp="$(mktemp)"; jq --arg k "$k" --arg h "$h" '.codehashes[$k] = $h' "$OUT" > "$tmp" && mv "$tmp" "$OUT"
  done
  echo "codehashes recomputed from on-chain code"
  cat "$OUT"
fi

if [ "$BROADCAST" = "1" ] && [ "$NAME" != "anvil" ]; then
  GA="$(jq -r .guardedAdmin "$OUT")"
  V1="$(jq -r .impls.v1 "$OUT")"
  V2="$(jq -r .impls.v2 "$OUT")"
  VURL="${VERIFIER_URL:-https://sourcify-api-monad.blockvision.org/}"
  cat <<EOF

Sourcify verification (GuardedAdmin and DemoBTC only; the attack implementations are NOT verified):
  forge verify-contract $GA src/GuardedAdmin.sol:GuardedAdmin --chain $CHAIN_ID --verifier sourcify --verifier-url $VURL --watch
  forge verify-contract $V1 src/DemoBTC.sol:DemoBTC --chain $CHAIN_ID --verifier sourcify --verifier-url $VURL --watch
  forge verify-contract $V2 src/DemoBTCV2.sol:DemoBTCV2 --chain $CHAIN_ID --verifier sourcify --verifier-url $VURL --watch
EOF
fi
