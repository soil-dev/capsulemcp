#!/bin/sh
# Wire-trace for the augmented MCP Tasks lifecycle against a DEPLOYED
# instance. Exercises the round-trip the in-process integration tests
# can't fully verify: createTask returns CreateTaskResult on the wire,
# tasks/get polls reach `completed`, tasks/result returns the wrapped
# CallToolResult, and the runner survives the stateless-POST
# notification-on-closed-stream path that crashed v1.6.0-alpha.1.
#
# IMPORTANT: writes to Capsule. Picks the first party returned by
# search_parties, adds a uniquely-named tag, removes it. Each
# add+remove cycle leaves Capsule in its original state — but if the
# script crashes mid-run, search Capsule for `mcp-tasks-trace-` and
# clean up manually.
#
# Counterpart to `smoke-test.sh` (OAuth/read-only verification only).
# Pair the two: smoke-test for every deploy, wire-trace-tasks for
# every alpha/beta cut with an OAuth-HTTP deployment running with
# `MCP_TASKS_ENABLED=1` and `CAPSULE_MCP_READONLY=0`.
#
# Usage:
#   ./scripts/wire-trace-tasks.sh
#   STACK=production REGION=europe-west1 PROJECT=<your-gcp-project> \
#       ./scripts/wire-trace-tasks.sh
#
# Reads CLIENT_ID and CLIENT_SECRET from Secret Manager, same shape
# as smoke-test.sh.
#
# Exits 0 if the lifecycle round-trips cleanly, 1 otherwise.

set -eu

STACK="${STACK:-production}"
PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-europe-west1}"
SERVICE="capsulemcp-${STACK}"
REDIRECT_URI="https://claude.ai/api/mcp/auth_callback"

for cmd in gcloud curl python3; do
    if ! command -v "${cmd}" > /dev/null 2>&1; then
        echo "error: '${cmd}' not found on PATH" >&2
        exit 1
    fi
done

PROJECT_NUMBER=$(gcloud projects describe "${PROJECT}" --format='value(projectNumber)' 2>/dev/null) || {
    echo "error: cannot read project ${PROJECT} — is gcloud authenticated?" >&2
    exit 1
}

URL="https://${SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app"
TAG_NAME="mcp-tasks-trace-$(date +%Y%m%d-%H%M%S)"

CLIENT_ID=$(gcloud secrets versions access latest --secret="capsulemcp-${STACK}-oauth-client-id")
CLIENT_SECRET=$(gcloud secrets versions access latest --secret="capsulemcp-${STACK}-oauth-client-secret")

PASS=0
FAIL=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS + 1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; if [ -n "${2:-}" ]; then printf '      %s\n' "$2"; fi; FAIL=$((FAIL + 1)); }

# OAuth dance — same shape as smoke-test.sh.
VERIFIER=$(python3 -c "import secrets; print(secrets.token_urlsafe(64))")
CHALLENGE=$(python3 -c "
import base64, hashlib, sys
print(base64.urlsafe_b64encode(hashlib.sha256(sys.argv[1].encode()).digest()).rstrip(b'=').decode())
" "$VERIFIER")
loc=$(curl -s -o /dev/null -w '%{redirect_url}' \
    "$URL/authorize?response_type=code&client_id=$CLIENT_ID&redirect_uri=$REDIRECT_URI&code_challenge=$CHALLENGE&code_challenge_method=S256")
code=$(python3 -c "
import sys
from urllib.parse import urlparse, parse_qs
print(parse_qs(urlparse(sys.argv[1]).query).get('code', [''])[0])
" "$loc")
ACCESS_TOKEN=$(curl -s -X POST "$URL/token" \
    --data-urlencode "grant_type=authorization_code" --data-urlencode "code=$code" \
    --data-urlencode "client_id=$CLIENT_ID" --data-urlencode "client_secret=$CLIENT_SECRET" \
    --data-urlencode "code_verifier=$VERIFIER" --data-urlencode "redirect_uri=$REDIRECT_URI" \
    | python3 -c "import json, sys; print(json.load(sys.stdin).get('access_token', ''))")

if [ -z "$ACCESS_TOKEN" ]; then
    echo "error: token exchange failed; cannot continue" >&2
    exit 1
fi

# ── helpers ─────────────────────────────────────────────────────────────────

mcp() {
    # $1 = JSON-RPC body; prints the first 'data: {...}' SSE line
    curl -s -X POST "$URL/mcp" \
        -H "Authorization: Bearer $ACCESS_TOKEN" \
        -H "Content-Type: application/json" \
        -H "Accept: application/json, text/event-stream" \
        -H "MCP-Protocol-Version: 2025-03-26" \
        -d "$1"
}

extract_json() {
    python3 -c "
import json, re, sys
text = sys.stdin.read()
m = re.search(r'data: (\{.*\})', text)
print(m.group(1) if m else text)
"
}

echo "Target: $URL"
echo "Tag name (this run): $TAG_NAME"
echo

# ── 1. Confirm we're in WRITE mode and tasks are enabled ────────────────────

echo "Pre-flight:"

init_resp=$(mcp '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{"tasks":{"list":{},"cancel":{}}},"clientInfo":{"name":"wire-trace-tasks","version":"0"}},"id":0}')
tasks_advertised=$(printf "%s" "$init_resp" | extract_json | python3 -c "
import json, sys
j = json.load(sys.stdin)
print('OK' if j.get('result', {}).get('capabilities', {}).get('tasks') else 'NOT_OK')
")
if [ "$tasks_advertised" = "OK" ]; then
    ok "initialize advertises tasks capability"
else
    bad "tasks capability missing — set MCP_TASKS_ENABLED=1 on the deployment"
    exit 1
fi

tools_resp=$(mcp '{"jsonrpc":"2.0","method":"tools/list","params":{},"id":1}')
has_batch=$(printf "%s" "$tools_resp" | extract_json | python3 -c "
import json, sys
j = json.load(sys.stdin)
tools = j.get('result', {}).get('tools', [])
print('True' if any(t.get('name') == 'batch_add_tag' for t in tools) else 'False')
")
if [ "$has_batch" = "True" ]; then
    ok "batch_add_tag is registered (write mode confirmed)"
else
    bad "batch_add_tag not present — set CAPSULE_MCP_READONLY=0 on the deployment"
    exit 1
fi

parties_resp=$(mcp '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"search_parties","arguments":{"perPage":1}},"id":2}')
PARTY_ID=$(printf "%s" "$parties_resp" | extract_json | python3 -c "
import json, sys
j = json.load(sys.stdin)
data = json.loads(j['result']['content'][0]['text'])
print(data['parties'][0]['id'])
")
if [ -n "$PARTY_ID" ]; then
    ok "found a test party (id $PARTY_ID)"
else
    bad "could not find a party to operate on"
    exit 1
fi

# ── 2. Augmented batch_add_tag ──────────────────────────────────────────────

echo
echo "Augmented batch_add_tag lifecycle:"

add_body=$(python3 -c "
import json, sys
print(json.dumps({
    'jsonrpc':'2.0','method':'tools/call','id':3,
    'params':{
        'name':'batch_add_tag',
        'arguments':{'items':[{'entity':'parties','entityId':int(sys.argv[1]),'tagName':sys.argv[2]}]},
        'task':{'ttl':60000}
    }
}))
" "$PARTY_ID" "$TAG_NAME")
add_resp=$(mcp "$add_body")
ADD_TASK_ID=$(printf "%s" "$add_resp" | extract_json | python3 -c "
import json, sys
print(json.load(sys.stdin)['result']['task']['taskId'])
")
if [ -n "$ADD_TASK_ID" ]; then
    ok "createTask returned CreateTaskResult (taskId: $ADD_TASK_ID)"
else
    bad "createTask did not return a taskId"
    exit 1
fi

STATUS="working"; ATTEMPTS=0
while [ "$STATUS" != "completed" ] && [ "$STATUS" != "failed" ] && [ "$STATUS" != "cancelled" ] && [ $ATTEMPTS -lt 20 ]; do
    sleep 1
    get_resp=$(mcp "{\"jsonrpc\":\"2.0\",\"method\":\"tasks/get\",\"params\":{\"taskId\":\"$ADD_TASK_ID\"},\"id\":4}")
    STATUS=$(printf "%s" "$get_resp" | extract_json | python3 -c "
import json, sys
print(json.load(sys.stdin).get('result', {}).get('status', '?'))
")
    ATTEMPTS=$((ATTEMPTS + 1))
done

if [ "$STATUS" = "completed" ]; then
    ok "tasks/get polled to 'completed' after $ATTEMPTS attempt(s)"
else
    bad "tasks/get terminal status was '$STATUS' (expected 'completed')"
    exit 1
fi

result_resp=$(mcp "{\"jsonrpc\":\"2.0\",\"method\":\"tasks/result\",\"params\":{\"taskId\":\"$ADD_TASK_ID\"},\"id\":5}")
add_summary=$(printf "%s" "$result_resp" | extract_json | python3 -c "
import json, sys
j = json.load(sys.stdin)
body = json.loads(j['result']['content'][0]['text'])
s = body.get('summary', {})
if s.get('succeeded') == 1 and s.get('failed') == 0:
    print('OK')
else:
    print(f'NOT_OK {s}')
")
case "$add_summary" in
    OK)
        ok "tasks/result body shows summary.succeeded=1, failed=0"
        ;;
    *)
        bad "unexpected tasks/result summary" "$add_summary"
        exit 1
        ;;
esac

# ── 3. Look up the new tag's id, then augmented batch_remove_tag_by_id ──────
# add_tag returns the modified party but not the tag id directly. Fetch
# the party with embed=tags to find it.

echo
echo "Cleanup (augmented batch_remove_tag_by_id):"

party_body=$(python3 -c "
import json
print(json.dumps({'jsonrpc':'2.0','method':'tools/call','id':6,'params':{'name':'get_party','arguments':{'id':int($PARTY_ID),'embed':'tags'}}}))
")
party_resp=$(mcp "$party_body")
TAG_ID=$(printf "%s" "$party_resp" | extract_json | python3 -c "
import json, sys
j = json.load(sys.stdin)
data = json.loads(j['result']['content'][0]['text'])
tags = data.get('party', {}).get('tags', [])
matches = [t for t in tags if t.get('name') == '$TAG_NAME']
print(matches[0]['id'] if matches else 'NOT_FOUND')
")
if [ "$TAG_ID" = "NOT_FOUND" ]; then
    bad "tag '$TAG_NAME' not found on party (add may have silently failed)"
    exit 1
fi
ok "located new tag id ($TAG_ID) via get_party embed=tags"

rm_body=$(python3 -c "
import json
print(json.dumps({
    'jsonrpc':'2.0','method':'tools/call','id':7,
    'params':{
        'name':'batch_remove_tag_by_id',
        'arguments':{'items':[{'entity':'parties','entityId':int($PARTY_ID),'tagId':int($TAG_ID)}]},
        'task':{'ttl':60000}
    }
}))
")
rm_resp=$(mcp "$rm_body")
RM_TASK_ID=$(printf "%s" "$rm_resp" | extract_json | python3 -c "
import json, sys
print(json.load(sys.stdin)['result']['task']['taskId'])
")
ok "cleanup createTask returned CreateTaskResult (taskId: $RM_TASK_ID)"

STATUS="working"; ATTEMPTS=0
while [ "$STATUS" != "completed" ] && [ "$STATUS" != "failed" ] && [ $ATTEMPTS -lt 15 ]; do
    sleep 1
    get_resp=$(mcp "{\"jsonrpc\":\"2.0\",\"method\":\"tasks/get\",\"params\":{\"taskId\":\"$RM_TASK_ID\"},\"id\":8}")
    STATUS=$(printf "%s" "$get_resp" | extract_json | python3 -c "
import json, sys
print(json.load(sys.stdin).get('result', {}).get('status', '?'))
")
    ATTEMPTS=$((ATTEMPTS + 1))
done

if [ "$STATUS" = "completed" ]; then
    ok "cleanup tasks/get polled to 'completed'"
else
    bad "cleanup terminal status was '$STATUS' (expected 'completed')"
fi

rm_result_resp=$(mcp "{\"jsonrpc\":\"2.0\",\"method\":\"tasks/result\",\"params\":{\"taskId\":\"$RM_TASK_ID\"},\"id\":9}")
rm_summary=$(printf "%s" "$rm_result_resp" | extract_json | python3 -c "
import json, sys
j = json.load(sys.stdin)
body = json.loads(j['result']['content'][0]['text'])
s = body.get('summary', {})
if s.get('succeeded') == 1:
    print('OK')
else:
    print(f'NOT_OK {s}')
")
case "$rm_summary" in
    OK)
        ok "cleanup tasks/result shows summary.succeeded=1"
        ;;
    *)
        bad "cleanup tasks/result not OK" "$rm_summary"
        ;;
esac

# ── summary ─────────────────────────────────────────────────────────────────

echo
TOTAL=$((PASS + FAIL))
if [ "$FAIL" -eq 0 ]; then
    printf '\033[32m✓ %d/%d checks passed — augmented MCP Tasks lifecycle works end-to-end\033[0m\n' "$PASS" "$TOTAL"
    exit 0
else
    printf '\033[31m✗ %d/%d checks failed (%d passed)\033[0m\n' "$FAIL" "$TOTAL" "$PASS"
    exit 1
fi
