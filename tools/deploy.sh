#!/usr/bin/env bash
# Upload the generated flows (flows/all-flows.json) to a Tdarr server, creating or updating each one by its
# flow id. Run tools/build_flows.py first if you changed anything in src/.
#
#   TDARR_URL=http://tdarr-host:8265 tools/deploy.sh
#   TDARR_API_KEY=...  (only if API authentication is enabled on the server)
#
# Needs: curl, jq. Re-running is safe; libraries keep their flow assignment.
set -euo pipefail

TDARR_URL="${TDARR_URL:-http://localhost:8265}"
FLOWS="$(cd "$(dirname "$0")/.." && pwd)/flows/all-flows.json"
API="${TDARR_URL%/}/api/v2/cruddb"
AUTH=()
[ -n "${TDARR_API_KEY:-}" ] && AUTH=(-H "x-api-key: ${TDARR_API_KEY}")

command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
[ -f "$FLOWS" ] || { echo "missing $FLOWS - run tools/build_flows.py first" >&2; exit 1; }

post() { curl -fsS -X POST "${AUTH[@]}" -H 'Content-Type: application/json' -d @- "$API"; }

count=$(jq length "$FLOWS")
for i in $(seq 0 $((count - 1))); do
  id=$(jq -r ".[$i]._id" "$FLOWS")
  existing=$(jq -n --arg id "$id" '{data: {collection: "FlowsJSONDB", mode: "getById", docID: $id}}' | post | jq -r '._id // empty' 2>/dev/null || true)
  mode=insert; [ -n "$existing" ] && mode=update
  jq -c --arg id "$id" --arg mode "$mode" ".[$i] | {data: {collection: \"FlowsJSONDB\", mode: \$mode, docID: \$id, obj: .}}" "$FLOWS" | post >/dev/null
  [ "$mode" = insert ] && echo "$id: created" || echo "$id: updated"
done
echo "Done. Refresh the Tdarr UI; then set a library's flow to \"Adaptive HEVC - 1 Report\"."
