#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bridge="${MUSE_BRIDGE_ENTRY:-$repo_root/src/server.mjs}"
workspace="$(mktemp -d "${TMPDIR:-/tmp}/muse-live-smoke.XXXXXX")"
cleanup() {
  rm -rf "$workspace"
}
trap cleanup EXIT

command -v muse >/dev/null 2>&1 || {
  echo "Muse Code is not installed or is not on PATH." >&2
  exit 127
}

version="$(muse --version 2>&1 || true)"
grep -Fq "0.2.1" <<<"$version" || {
  echo "Muse Code 0.2.1 is required for this compatibility check; found: $version" >&2
  exit 1
}

node -e 'const fs = require("node:fs"); const [file, bridge] = process.argv.slice(1); fs.writeFileSync(file, JSON.stringify({ agents: { muse: { argv: [process.execPath, bridge] } } }, null, 2) + "\n");' \
  "$workspace/.acpxrc.json" "$bridge"

result="$(
  cd "$workspace"
  MUSE_ACP_PROVIDER=echo \
    npx --yes acpx@0.13.1 --timeout 120 muse exec "Muse 0.2.1 ACP compatibility smoke"
)"

grep -Fq "echo: Muse 0.2.1 ACP compatibility smoke" <<<"$result"
echo "Muse Code 0.2.1 compatibility smoke passed."
