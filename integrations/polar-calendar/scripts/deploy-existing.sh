#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" != "--apply" ]]; then
  echo "Live deployment requires: $0 --apply \"description\"" >&2
  exit 2
fi

DESCRIPTION="${2:-Healine maintenance update}"
PROJECT_DIR="${HEALINE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DEPLOYMENT_ID="AKfycbyOuTgYaXV64uzBanGnGBO2f7dSDUyjnaLuI585PC3jWP8sIRJR2pI6whL1J1SH_a_1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

"$SCRIPT_DIR/validate-project.sh"

(
  cd "$PROJECT_DIR"
  "$SCRIPT_DIR/clasp-local.sh" push --force
  "$SCRIPT_DIR/clasp-local.sh" deploy \
    --deploymentId "$DEPLOYMENT_ID" \
    --description "$DESCRIPTION"
  "$SCRIPT_DIR/clasp-local.sh" deployments
)
