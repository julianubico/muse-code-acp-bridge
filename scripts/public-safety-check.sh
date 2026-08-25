#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

if rg -n --hidden \
  --glob '!node_modules/**' \
  --glob '!.git/**' \
  --glob '!package-lock.json' \
  --glob '!scripts/public-safety-check.sh' \
  '(/Users/|/home/|sk-[A-Za-z0-9]|BEGIN [A-Z ]*PRIVATE KEY|Bearer [A-Za-z0-9])' .; then
  echo "Public safety scan found a personal path, credential-like value, or environment file reference." >&2
  exit 1
fi

if find . -type f \( -name '.env' -o -name '.env.*' -o -name '.npmrc' \) -not -path './node_modules/*' -print -quit | rg .; then
  echo "Public safety scan found a local configuration file." >&2
  exit 1
fi

echo "Public safety scan passed."
