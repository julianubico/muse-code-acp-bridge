#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bridge="$repo_root/src/server.mjs"
workspace="$(mktemp -d "${TMPDIR:-/tmp}/muse-acpx-smoke.XXXXXX")"
config="$workspace/.acpxrc.json"
cleanup() {
  rm -rf "$workspace"
}
trap cleanup EXIT

node -e 'const fs = require("node:fs"); const [file, bridge] = process.argv.slice(1); fs.writeFileSync(file, JSON.stringify({ agents: { muse: { argv: [process.execPath, bridge] } } }, null, 2) + "\n");' "$config" "$bridge"

if [[ "$(acpx --version)" != "0.13.1" ]]; then
  echo "warning: this check is specified for acpx 0.13.1; found $(acpx --version)" >&2
fi

result="$(
  cd "$workspace"
  MUSE_ACP_BIN="$repo_root/test/stream.test.mjs" \
  MUSE_BRIDGE_FAKE_MUSE=1 \
  MUSE_ACP_PROVIDER=echo \
    acpx --timeout 60 muse exec "packed integration smoke"
)"

grep -Fq "echo: packed integration smoke" <<<"$result"
echo "acpx integration smoke passed."
