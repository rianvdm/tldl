#!/bin/bash
# Seed local miniflare KV with the monitored podcast records from remote.
# Required for /subscribe and /preferences/manage to show the real podcast
# list when running `wrangler dev` (no --remote) against local D1.
#
# Usage:  ./scripts/seed-local-kv.sh
#
# Only copies `monitored:list` and `monitored:<podcastId>` entries.
# Skips `monitored:processed:*`, `monitor:*`, and other unrelated prefixes.

set -euo pipefail

cd "$(dirname "$0")/.."

echo "Fetching monitored:list from remote..."
LIST_JSON=$(npx wrangler kv key get "monitored:list" --binding=TLDL_DATA --remote 2>/dev/null)
echo "$LIST_JSON" | python3 -m json.tool >/dev/null  # validate JSON

PODCAST_IDS=$(echo "$LIST_JSON" | python3 -c 'import json,sys; print(" ".join(json.load(sys.stdin)))')
COUNT=$(echo "$LIST_JSON" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')

echo "Writing monitored:list to local ($COUNT podcasts)..."
TMP_LIST=$(mktemp)
printf '%s' "$LIST_JSON" > "$TMP_LIST"
npx wrangler kv key put "monitored:list" --binding=TLDL_DATA --path="$TMP_LIST" >/dev/null
rm "$TMP_LIST"

i=0
for PID in $PODCAST_IDS; do
    i=$((i+1))
    KEY="monitored:$PID"
    echo "[$i/$COUNT] $KEY"
    VAL=$(npx wrangler kv key get "$KEY" --binding=TLDL_DATA --remote 2>/dev/null)
    TMP=$(mktemp)
    printf '%s' "$VAL" > "$TMP"
    npx wrangler kv key put "$KEY" --binding=TLDL_DATA --path="$TMP" >/dev/null
    rm "$TMP"
done

echo ""
echo "Done. Local KV now has $COUNT monitored podcasts."
echo "Run 'npx wrangler dev' and visit http://localhost:8787/subscribe"
