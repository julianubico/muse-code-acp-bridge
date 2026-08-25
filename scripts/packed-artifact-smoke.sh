#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
workspace="$(mktemp -d "${TMPDIR:-/tmp}/muse-packed-smoke.XXXXXX")"
install_dir="$workspace/install"
project_dir="$workspace/project"
cleanup() {
  rm -rf "$workspace"
}
trap cleanup EXIT

mkdir -p "$install_dir" "$project_dir"
package_tarball="$(npm pack --pack-destination "$workspace" --silent)"
npm install --prefix "$install_dir" --no-package-lock --ignore-scripts "$workspace/$package_tarball" >/dev/null

package_bin="$install_dir/node_modules/.bin/muse-code-acp-bridge"
test -x "$package_bin"

node -e 'const fs = require("node:fs"); const [file, bin] = process.argv.slice(1); fs.writeFileSync(file, JSON.stringify({ agents: { muse: { argv: [bin] } } }, null, 2) + "\n");' \
  "$project_dir/.acpxrc.json" "$package_bin"

result="$(
  cd "$project_dir"
  MUSE_ACP_BIN="$repo_root/test/stream.test.mjs" \
  MUSE_ACP_PROVIDER=echo \
  MUSE_BRIDGE_FAKE_MUSE=1 \
    npx --yes acpx@0.13.1 --timeout 60 muse exec "packed artifact smoke"
)"

grep -Fq "first-" <<<"$result"
echo "packed artifact acpx integration smoke passed."
