#!/usr/bin/env bash
# One-command bootstrap for ShopPilot AI. Safe to re-run.
#
#   ./dev-up.sh              → install deps if needed, seed a demo store if empty, start the server
#   ./dev-up.sh --reseed     → force a clean seed of the documented demo state, then start
#   ./dev-up.sh --check      → verify everything without starting a server (used in CI/judging)
#
# Judges: see README.md. Nothing here needs API keys — the default mode is a self-contained
# PayPal simulator, so this boots a complete working product offline.

set -euo pipefail
cd "$(dirname "$0")/app"

RESEED=0
CHECK_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --reseed) RESEED=1 ;;
    --check) CHECK_ONLY=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

step "1/5  Node version"
node -e 'const [maj,min]=process.versions.node.split(".").map(Number); if (maj<20||(maj===20&&min<11)) { console.error(`Node ${process.versions.node} is too old — need >=20.11`); process.exit(1); } console.log(`   node ${process.versions.node} ok`)'

step "2/5  Dependencies"
if node -e "require.resolve('express'); require.resolve('zod')" >/dev/null 2>&1; then
  echo "   already installed"
else
  echo "   installing…"
  npm install --no-audit --no-fund
fi

step "3/5  Store"
if [ "$RESEED" = "1" ] || [ ! -f .data/db.json ]; then
  node scripts/reset.mjs >/dev/null
  node scripts/seed.mjs --demo-orders | tail -6
else
  echo "   existing store kept (.data/db.json) — use --reseed for a clean demo state"
fi

step "4/5  Self-check"
node --test tests/unit 2>&1 | grep -E "^# (tests|pass|fail)" | sed 's/^/   /'
node scripts/ledger-check.mjs 2>&1 | tail -2 | sed 's/^/   /'

if [ "$CHECK_ONLY" = "1" ]; then
  step "Done (--check: no server started)"
  exit 0
fi

step "5/5  Starting"
echo "   storefront  http://localhost:${PORT:-4000}/"
echo "   merchant    http://localhost:${PORT:-4000}/merchant  (merchant@demo.dev / Merchant@12345)"
echo "   payments    simulator — run 'npm run paypal:check' for the real sandbox path"
echo
exec env HOST="${HOST:-0.0.0.0}" PORT="${PORT:-4000}" node server/index.mjs
