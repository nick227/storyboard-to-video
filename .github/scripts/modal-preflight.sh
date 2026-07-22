#!/usr/bin/env bash
# Checks that a Modal Environment and a required Secret within it both exist before a deploy
# step runs. Two modes, because "dev" and "prod" need opposite failure behavior:
#   skip  - dev auto-deploys (ci.yml) must never fail the whole CI run just because the `dev`
#           Modal Environment hasn't been bootstrapped yet. Writes ready=false to
#           $GITHUB_OUTPUT and exits 0; the caller gates the actual deploy step on
#           steps.<id>.outputs.ready == 'true'.
#   fail  - prod deploys (deploy-modal.yml) are manual and deliberate; a missing prod
#           Environment/Secret should fail loudly with setup instructions, not silently skip.
#
# Usage: modal-preflight.sh <environment-name> <secret-name> <skip|fail>
# Requires: modal CLI installed and authenticated (MODAL_TOKEN_ID/MODAL_TOKEN_SECRET), jq
# (preinstalled on GitHub-hosted ubuntu-latest runners).
set -euo pipefail

ENVIRONMENT="$1"
SECRET_NAME="$2"
MODE="$3"

if [ "$MODE" != "skip" ] && [ "$MODE" != "fail" ]; then
  echo "Usage: modal-preflight.sh <environment-name> <secret-name> <skip|fail>" >&2
  exit 2
fi

fail_or_skip() {
  local message="$1"
  if [ "$MODE" = "fail" ]; then
    echo "::error::${message}"
    exit 1
  fi
  echo "::warning::${message} Skipping this deploy (not failing CI)."
  echo "ready=false" >> "$GITHUB_OUTPUT"
  exit 0
}

setup_hint="Run '.github/scripts/modal-bootstrap.sh' with real token values (see its header comment), or the equivalent 'modal environment create' / 'modal secret create ... --env ${ENVIRONMENT}' commands, before deploying to '${ENVIRONMENT}'."

if ! modal environment list --json | jq -e --arg env "$ENVIRONMENT" '.[] | select(.name == $env)' >/dev/null; then
  fail_or_skip "Modal environment '${ENVIRONMENT}' does not exist. ${setup_hint}"
fi

if ! modal secret list --env "$ENVIRONMENT" --json | jq -e --arg name "$SECRET_NAME" '.[] | select(.name == $name)' >/dev/null; then
  fail_or_skip "Modal secret '${SECRET_NAME}' does not exist in the '${ENVIRONMENT}' environment. ${setup_hint}"
fi

echo "ready=true" >> "$GITHUB_OUTPUT"
