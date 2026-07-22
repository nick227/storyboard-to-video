#!/usr/bin/env bash
# One-time (or safely re-run) setup for the dev/prod Modal Environment split described in
# README.md's Deployment Configuration section: creates the `dev` and `prod` Modal Environments
# if they don't already exist, then creates (or updates, via --force) voice-service-secrets and
# piper-service-secrets in both. Safe to re-run: environments are only created if missing, and
# secrets are recreated with --force so rotated token values take effect without manual cleanup.
#
# Run from a machine with the `modal` CLI installed and authenticated (`modal setup` /
# `modal token new`) -- this is meant for a human to run locally, not for CI (CI only ever
# deploys; it never creates Environments or Secrets, see .github/scripts/modal-preflight.sh).
#
# Usage:
#   SPARK_SERVICE_TOKEN=... PIPER_SERVICE_TOKEN=... ./.github/scripts/modal-bootstrap.sh
#   # SPARK_TEMPERATURE/SPARK_TOP_K/SPARK_TOP_P are optional, default to the values below.
#
# Also runnable as: npm run modal:bootstrap (from the repo root; forwards the same env vars).
set -euo pipefail

: "${SPARK_SERVICE_TOKEN:?SPARK_SERVICE_TOKEN is required (voice-service-secrets)}"
: "${PIPER_SERVICE_TOKEN:?PIPER_SERVICE_TOKEN is required (piper-service-secrets)}"
: "${SPARK_TEMPERATURE:=0.8}"
: "${SPARK_TOP_K:=50}"
: "${SPARK_TOP_P:=0.95}"

for env_name in dev prod; do
  if modal environment list --json | jq -e --arg env "$env_name" '.[] | select(.name == $env)' >/dev/null; then
    echo "Modal environment '${env_name}' already exists, skipping creation."
  else
    echo "Creating Modal environment '${env_name}'..."
    modal environment create "$env_name"
  fi

  echo "Creating/updating voice-service-secrets in '${env_name}'..."
  modal secret create voice-service-secrets \
    SPARK_SERVICE_TOKEN="$SPARK_SERVICE_TOKEN" \
    SPARK_TEMPERATURE="$SPARK_TEMPERATURE" \
    SPARK_TOP_K="$SPARK_TOP_K" \
    SPARK_TOP_P="$SPARK_TOP_P" \
    --env "$env_name" --force

  echo "Creating/updating piper-service-secrets in '${env_name}'..."
  modal secret create piper-service-secrets \
    PIPER_SERVICE_TOKEN="$PIPER_SERVICE_TOKEN" \
    --env "$env_name" --force
done

echo "Modal dev/prod bootstrap complete. voice-service-voices Volume is created automatically on first deploy (create_if_missing=True in apps/voice-service/modal_app.py)."
