#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="${HEALINE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
EXPECTED_SCRIPT_ID="1zfCgFLuRF_HOjRs-pF12z2_9RR5BdhzHq7eVZsqZHBHuPerSzTreH01e"
EXPECTED_DEPLOYMENT_ID="AKfycbyOuTgYaXV64uzBanGnGBO2f7dSDUyjnaLuI585PC3jWP8sIRJR2pI6whL1J1SH_a_1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[[ -d "$PROJECT_DIR/src" ]] || { echo "Missing Healine src directory: $PROJECT_DIR/src" >&2; exit 1; }
[[ -f "$PROJECT_DIR/.clasp.json" ]] || { echo "Missing $PROJECT_DIR/.clasp.json" >&2; exit 1; }

clasp_values="$(node -e "const fs=require('fs'); const p=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); process.stdout.write(String(p.scriptId||'')+'\\n'+String(p.rootDir||''));" "$PROJECT_DIR/.clasp.json")"
actual_script_id="$(printf '%s\n' "$clasp_values" | sed -n '1p')"
actual_root_dir="$(printf '%s\n' "$clasp_values" | sed -n '2p')"
[[ "$actual_script_id" == "$EXPECTED_SCRIPT_ID" ]] || {
  echo "Refusing unexpected Apps Script ID: $actual_script_id" >&2
  exit 1
}
[[ "$actual_root_dir" == "src" ]] || {
  echo "Refusing unexpected clasp rootDir: $actual_root_dir" >&2
  exit 1
}

expected_files="$(printf '%s\n' \
  appsscript.json \
  Baseline.gs \
  CalendarSink.gs \
  Config.gs \
  DateUtils.gs \
  Main.gs \
  PolarAuth.gs \
  PolarClient.gs \
  StressEngine.gs | sort)"
actual_files="$(cd "$PROJECT_DIR/src" && find . -type f -print | sed 's#^\./##' | sort)"
[[ "$actual_files" == "$expected_files" ]] || {
  echo "Refusing unexpected Apps Script upload file set:" >&2
  printf '%s\n' "$actual_files" >&2
  exit 1
}

node --test "$PROJECT_DIR"/tests/*.test.js

for file in "$PROJECT_DIR"/src/*.gs; do
  node --check < "$file"
done

(
  cd "$PROJECT_DIR"
  "$SCRIPT_DIR/clasp-local.sh" status >/dev/null
  deployments="$("$SCRIPT_DIR/clasp-local.sh" deployments)"
  [[ "$deployments" == *"$EXPECTED_DEPLOYMENT_ID"* ]] || {
    echo "Canonical Healine deployment is missing." >&2
    exit 1
  }
)

echo "Healine validation passed for Apps Script $EXPECTED_SCRIPT_ID and its canonical deployment"
