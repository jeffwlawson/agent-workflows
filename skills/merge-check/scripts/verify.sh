#!/bin/bash
# Install and verify a worktree, and print the head, the toolchain against what the repo declares, and the verdict.
# usage: verify.sh <worktree> <log-prefix> <verify command...>
#   e.g. verify.sh ../pr-540 "$TMPDIR/pr-540" npm run verify
#   TOOL_BIN: the required toolchain's bin directory, when the default is wrong.
#   INSTALL:  the install command, when it is not `npm ci` from a package-lock.json.
[ $# -ge 3 ] || { echo "usage: verify.sh <worktree> <log-prefix> <verify command...>"; exit 2; }
wt=$1 log=$2; shift 2
[ -n "$TOOL_BIN" ] && export PATH=$TOOL_BIN:$PATH
cd "$wt" || exit 2
declared=$(cat .nvmrc .tool-versions 2>/dev/null | head -3 | tr '\n' ' ')
[ -f package.json ] && declared="$declared engines=$(node -p 'require("./package.json").engines?.node ?? "-"' 2>/dev/null)"
if [ -n "$INSTALL" ]; then
  sh -c "$INSTALL" > "$log.install.log" 2>&1 || { echo "install failed: $log.install.log"; exit 3; }
elif [ -f package-lock.json ]; then
  npm ci --no-fund --no-audit > "$log.install.log" 2>&1 || { echo "npm ci failed: $log.install.log"; exit 3; }
fi
"$@" > "$log.verify.log" 2>&1; rc=$?
echo "head=$(git rev-parse HEAD) node=$(node --version 2>/dev/null || echo -) declared=[${declared:-none}] exit=$rc log=$log.verify.log"
grep -E "Test Files|Tests  |passed|failed" "$log.verify.log" | tail -5
grep -E "^ FAIL " "$log.verify.log" | head -20
[ $rc -eq 0 ] || tail -15 "$log.verify.log"
exit $rc
