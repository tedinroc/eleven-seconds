#!/usr/bin/env bash
# Measure real gasUsed on `anvil --network monad` and write shared/gas.json (gasLimit = ceil(gasUsed * 1.10)).
# Starts its own throwaway anvil (GAS_PORT, default 8546), deploys there, measures, then stops it, so it
# never touches the integration anvil. Uses anvil's unlocked test accounts only (no keys).
#   script/measure-gas.sh
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${GAS_PORT:-8546}"
RPC="http://127.0.0.1:$PORT"
DEP="cache/gas-deployment.json"
LOG="cache/gas-anvil.log"
mkdir -p cache

anvil --network monad -b 0.3 --port "$PORT" >"$LOG" 2>&1 &
ANVIL_PID=$!
trap 'kill $ANVIL_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do cast block-number --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.2; done

RPC_URL="$RPC" OUT_JSON="$DEP" script/deploy.sh >/dev/null
GA=$(jq -r .guardedAdmin "$DEP")
ADMIN=$(jq -r .owner "$DEP")
APPROVER=$(jq -r .approver "$DEP")
S1=$(jq -r '.guardians[0]' "$DEP"); S2=$(jq -r '.guardians[1]' "$DEP"); S3=$(jq -r '.guardians[2]' "$DEP")
V2=$(jq -r .impls.v2 "$DEP"); EVIL=$(jq -r .impls.evilMint "$DEP"); PAUSED=$(jq -r .impls.paused "$DEP")
R1=$(cast keccak "GUARD/R1_TOTAL_SUPPLY")

declare -a NAMES=() USED=()
tx() { # <name> <from> <sig> [args...]
  local name="$1" from="$2"; shift 2
  local out gu st
  out=$(cast send --rpc-url "$RPC" --unlocked --from "$from" --json "$GA" "$@")
  gu=$(cast to-dec "$(jq -r .gasUsed <<<"$out")"); st=$(jq -r .status <<<"$out")
  [ "$st" = "0x1" ] || { echo "$name failed: $out" >&2; exit 1; }
  NAMES+=("$name"); USED+=("$gu"); echo "$name $gu"
}
wait_block() { while [ "$(cast block-number --rpc-url "$RPC")" -lt "$1" ]; do sleep 0.2; done; }
ready() { cast call --rpc-url "$RPC" "$GA" "getProposal(uint256)((uint8,uint8,address,address,uint256,bytes32,bytes32,uint64,uint64,uint256))" "$1" | tr -d '()' | awk -F', ' '{print $9}'; }

tx approveCodehash "$APPROVER" "approveCodehash(bytes32)" "$(cast keccak 0x01)"
tx proposeUpgrade "$ADMIN" "proposeUpgrade(address,bytes)" "$V2" 0x          # id 1
tx proposeUpgrade_evil "$ADMIN" "proposeUpgrade(address,bytes)" "$EVIL" 0x   # id 2
tx veto_first "$S1" "veto(uint256,bytes32)" 2 "$R1"
tx veto_second "$S2" "veto(uint256,bytes32)" 2 "$R1"
tx veto_third "$S3" "veto(uint256,bytes32)" 2 "$R1"
tx veto_repeat "$S1" "veto(uint256,bytes32)" 2 "$R1"
tx attachReason "$S1" "attachReason(uint256,bytes32)" 2 "$(cast keccak report)"
tx proposeSetGuardian "$ADMIN" "proposeSetGuardian(address,bool)" "$S3" false # id 3
tx proposeSetDelay "$ADMIN" "proposeSetDelay(uint64)" 40                      # id 4
tx proposeSetPausedImpl "$ADMIN" "proposeSetPausedImpl(address)" "$PAUSED"     # id 5
wait_block "$(ready 1)"
tx execute_upgrade "$ADMIN" "execute(uint256)" 1
tx breakGlass "$S1" "breakGlass()"
tx proposeUpgrade_unpause "$ADMIN" "proposeUpgrade(address,bytes)" "$V2" 0x   # id 6
wait_block "$(ready 5)"
tx execute_setGuardian "$ADMIN" "execute(uint256)" 3
tx execute_setDelay "$ADMIN" "execute(uint256)" 4
tx execute_setPausedImpl "$ADMIN" "execute(uint256)" 5
wait_block "$(ready 6)"
tx execute_upgrade_unpause "$ADMIN" "execute(uint256)" 6

# A vetoed execute reverts; Monad charges the full gas limit anyway. Record its gasUsed for reference.
REV=$(cast send --rpc-url "$RPC" --unlocked --from "$ADMIN" --json --gas-limit 200000 "$GA" "execute(uint256)" 2 2>/dev/null || true)
REV_USED=$( [ -n "$REV" ] && cast to-dec "$(jq -r .gasUsed <<<"$REV")" || echo null)
echo "execute_vetoed_revert $REV_USED"

DETAIL=$(for i in "${!NAMES[@]}"; do echo "{\"k\":\"${NAMES[$i]}\",\"v\":${USED[$i]}}"; done | jq -s 'map({(.k): .v}) | add')
jq -n --argjson d "$DETAIL" --argjson rev "$REV_USED" --arg at "$(date -u +%Y-%m-%dT%H:%MZ)" --arg fv "$(forge --version | head -1)" '
  def lim(x): ((x * 1.1) | ceil);
  def op(xs): (xs | max) as $u | {gasUsed: $u, gasLimit: lim($u)};
  {
    _meta: {source: "real tx receipts on anvil --network monad", tool: $fv, measuredAt: $at, multiplier: 1.1,
            note: "gasLimit = ceil(max gasUsed of the variants in _detail * 1.10). Monad charges gasLimit x price. execute covers upgrades with empty init data only."},
    propose: op([$d.proposeUpgrade, $d.proposeUpgrade_evil, $d.proposeUpgrade_unpause, $d.proposeSetGuardian, $d.proposeSetDelay, $d.proposeSetPausedImpl]),
    veto: op([$d.veto_first, $d.veto_second, $d.veto_third, $d.veto_repeat]),
    attachReason: op([$d.attachReason]),
    execute: op([$d.execute_upgrade, $d.execute_upgrade_unpause, $d.execute_setGuardian, $d.execute_setDelay, $d.execute_setPausedImpl]),
    breakGlass: op([$d.breakGlass]),
    approveCodehash: op([$d.approveCodehash]),
    _detail: ($d + {execute_vetoed_revert: $rev})
  }' > shared/gas.json
cat shared/gas.json
