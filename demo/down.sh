#!/usr/bin/env bash
# Stop only the processes demo/up.sh started (recorded in .demo/pids), children first.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
F="$ROOT/.demo/pids"
[ -f "$F" ] || { echo "nothing recorded in .demo/pids"; exit 0; }
while read -r pid name; do
  [ -n "$pid" ] || continue
  pkill -TERM -P "$pid" 2>/dev/null   # children of this exact PID only
  kill "$pid" 2>/dev/null && echo "stopped $name ($pid)"
done < "$F"
: > "$F"
