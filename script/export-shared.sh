#!/usr/bin/env bash
# Regenerate shared/abi/*.json and shared/rules.json from the compiled contracts.
# Usage (from the repo root): script/export-shared.sh
set -euo pipefail
cd "$(dirname "$0")/.."

forge build --offline >/dev/null

mkdir -p shared/abi
abi() { jq '.abi' "out/$1.sol/$2.json" > "shared/abi/$3.json"; echo "shared/abi/$3.json"; }
abi GuardedAdmin GuardedAdmin GuardedAdmin
# DemoBTC.json is the v2 ABI: a superset of v1 (adds version()), so one ABI talks to the proxy
# whatever implementation is live. Calling version() on v1 simply reverts.
abi DemoBTCV2 DemoBTCV2 DemoBTC
abi DemoBTC DemoBTC DemoBTCV1
abi PausedImpl PausedImpl PausedImpl
abi EvilOwnerImpl EvilOwnerImpl EvilOwnerImpl
abi EvilMintImpl EvilMintImpl EvilMintImpl
abi EvilFeeImpl EvilFeeImpl EvilFeeImpl
abi ProxyAdmin ProxyAdmin ProxyAdmin

# rules.json: ruleHash = keccak256(utf8("GUARD/<rule>")), spec 4.2 / 4.3.
rule() { # <rule> <zh label> <threat>
  local id="GUARD/$1"
  jq -n --arg rule "$1" --arg id "$id" --arg hash "$(cast keccak "$id")" --arg zh "$2" --arg threat "$3" \
    '{rule: $rule, id: $id, ruleHash: $hash, zh: $zh, threat: $threat}'
}
{
  rule R1_TOTAL_SUPPLY "陌生地址的调用改变了总供应量" "T1"
  rule R2_OWNER "陌生地址的调用改变了 owner" "T2"
  rule R3_TRANSFER_CONSERVATION "转账不守恒" "T3"
  rule R4_TRANSFER_LIVENESS "正常转账失败" "brick"
  rule R5_STRICT_CODEHASH "严格模式：codehash 未经预核准" "timebomb"
  rule R6_SIM_FAILURE "模拟失败或超时（fail-closed）" "T8"
  rule R7_CONFIG_GUARD "未经核准的守护配置变更" "T4/T5"
  rule R8_INIT_DATA "升级附带未核准的初始化数据" "T9"
} | jq -s '{v: 1, hash: "keccak256(utf8(id))", rules: .}' > shared/rules.json
echo "shared/rules.json"
