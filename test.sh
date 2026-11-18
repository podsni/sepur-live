#!/bin/sh
# Build, unit-test the schedule engine, then run the headless smoke test against a local server.
set -e
npm run build
npm test
PORT=${PORT:-5199} node scripts/serve.mjs >/tmp/sepur-test-serve.log 2>&1 &
SRV=$!
trap 'kill $SRV' EXIT
sleep 1
curl -fsS "http://localhost:${PORT:-5199}/" >/dev/null
curl -fsS "http://localhost:${PORT:-5199}/data/network.json" >/dev/null
if node -e "import('playwright-core')" 2>/dev/null; then
  node tests/smoke.mjs "http://localhost:${PORT:-5199}" "${SHOTS:-/tmp}"
else
  echo "playwright-core not installed: skipping headless smoke test (npm i -D playwright-core)"
fi
