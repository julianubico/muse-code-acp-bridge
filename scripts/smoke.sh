#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

node --check src/server.mjs
node --check test/boundary.test.mjs
node --check test/concurrency.test.mjs
node --check test/stream.test.mjs
node --check test/tool-boundary.test.mjs

npm test
bash scripts/public-safety-check.sh

if [[ "${MUSE_ACP_SMOKE_ACPX:-0}" == "1" ]]; then
  command -v acpx >/dev/null 2>&1 || {
    echo "MUSE_ACP_SMOKE_ACPX=1 requires acpx on PATH." >&2
    exit 127
  }
  bash scripts/acpx-integration-smoke.sh
fi

echo "Muse ACP bridge smoke test passed."
