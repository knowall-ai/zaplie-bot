#!/usr/bin/env bash
# Poll an App Service /healthz endpoint until it returns 200 or attempts run out.
# Usage: smoke-health.sh <app-name> <label>
set -u
app_name="$1"
label="$2"
for attempt in $(seq 1 12); do
  code=$(curl -sS -o /dev/null -w '%{http_code}' \
    --max-time 20 \
    "https://${app_name}.azurewebsites.net/healthz" || true)
  echo "attempt ${attempt}: HTTP ${code:-000}"
  [[ "$code" == '200' ]] && exit 0
  sleep 15
done
echo "::error::${label} /healthz never returned HTTP 200."
exit 1
