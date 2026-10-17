#!/usr/bin/env bash
# Re-run Sourcify verification for an already deployed contract.
# Usage: scripts/verify.sh <address> <path:Contract>
set -euo pipefail
[ "$#" -eq 2 ] || { echo "usage: $0 <address> <path:Contract>" >&2; exit 1; }
forge verify-contract "$1" "$2" --chain "${CHAIN_ID:-10143}" \
  --verifier sourcify --verifier-url "${VERIFIER_URL:-https://sourcify-api-monad.blockvision.org/}" --watch
