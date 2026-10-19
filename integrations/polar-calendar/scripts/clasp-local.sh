#!/usr/bin/env bash
set -euo pipefail

if command -v clasp >/dev/null 2>&1; then
  exec clasp "$@"
fi

for candidate in "$HOME"/.npm/_npx/*/node_modules/.bin/clasp; do
  if [[ -x "$candidate" ]]; then
    exec "$candidate" "$@"
  fi
done

if command -v npx >/dev/null 2>&1; then
  exec npx --yes @google/clasp@3.4.1 "$@"
fi

echo "clasp is unavailable. Install @google/clasp or restore the existing npm cache." >&2
exit 127
