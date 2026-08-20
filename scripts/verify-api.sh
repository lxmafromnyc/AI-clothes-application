#!/usr/bin/env bash
# Verifies a deployed FindWear interpreter endpoint end to end.
#
#   ./scripts/verify-api.sh https://your-app.vercel.app/api/interpret
#
# Optionally pass the browser origin that will call it, to check CORS:
#
#   ./scripts/verify-api.sh https://your-app.vercel.app/api/interpret https://lxmafromnyc.github.io
#
# Exits non-zero if any check fails. Never prints your API key.

set -uo pipefail

ENDPOINT="${1:-}"
ORIGIN="${2:-}"
QUERY="Find me a black oversized hoodie under \$80"

if [ -z "$ENDPOINT" ]; then
  echo "usage: $0 <endpoint-url> [browser-origin]" >&2
  exit 2
fi

# Results are tallied through a file so the python checks below, which run in
# their own process, count towards the same total.
RESULTS=$(mktemp)
export RESULTS
trap 'rm -f "$RESULTS"' EXIT
ok()   { echo "  PASS  $1"; echo P >> "$RESULTS"; }
bad()  { echo "  FAIL  $1"; echo F >> "$RESULTS"; }
note() { echo "        $1"; }

echo "Verifying $ENDPOINT"
echo

# --- 1. the real request ----------------------------------------------------
echo "1. Interpreting: \"$QUERY\""
body=$(python3 - "$QUERY" <<'PY'
import json, sys
print(json.dumps({
  "query": sys.argv[1],
  "vocabulary": {
    "categories": ["knit", "shirt", "trousers", "tee", "jacket"],
    "colors": ["Black", "White", "Neutral", "Blue", "Green", "Earth", "Pastel", "Bright"],
    "occasions": ["Everyday", "Work", "Evening", "Weekend", "Active"],
    "fits": ["Slim", "Regular", "Relaxed", "Oversized"],
    "brands": ["UNIQLO", "ZARA", "LEVI'S"]
  }
}))
PY
)

hdr=$(mktemp); out=$(mktemp)
code=$(curl -sS -o "$out" -D "$hdr" -w "%{http_code}" --max-time 30 \
  -X POST "$ENDPOINT" \
  -H "Content-Type: application/json" \
  ${ORIGIN:+-H "Origin: $ORIGIN"} \
  --data "$body" 2>/dev/null)

if [ "$code" = "200" ]; then
  ok "endpoint returned 200"
elif [ "$code" = "503" ]; then
  bad "endpoint returned 503 — OPENAI_API_KEY is not set on the deployment"
  note "fix: vercel env add OPENAI_API_KEY production   (then redeploy)"
elif [ "$code" = "502" ]; then
  bad "endpoint returned 502 — it reached OpenAI but the call failed"
  note "check the function logs: vercel logs <deployment-url>"
  note "common causes: invalid key, no billing, or OPENAI_MODEL not available to your account"
elif [ "$code" = "000" ]; then
  bad "could not reach $ENDPOINT at all — is the URL right and the deployment live?"
else
  bad "endpoint returned $code"
fi

python3 - "$out" <<'PY'
import json, sys
try:
    data = json.load(open(sys.argv[1]))
except Exception:
    import os
    print("  FAIL  response was not JSON")
    open(os.environ["RESULTS"], "a").write("F\n")
    sys.exit(0)

import os
_tally = open(os.environ["RESULTS"], "a")
def ok(m):  print("  PASS  " + m); _tally.write("P\n"); _tally.flush()
def bad(m): print("  FAIL  " + m); _tally.write("F\n"); _tally.flush()

if data.get("source") == "openai":
    ok('response is tagged source="openai" — OpenAI actually interpreted it')
else:
    bad('response is not tagged source="openai" (got %r)' % data.get("source"))

p = data.get("preferences") or {}
if not p:
    bad("no preferences in the response"); sys.exit(0)

print("        read as: " + json.dumps({k: v for k, v in p.items() if v not in ([], None)}))

checks = [
    ("a fit was extracted",        bool(p.get("fits"))),
    ("a colour was extracted",     bool(p.get("colors"))),
    ("the $80 budget was read",    p.get("maxPrice") == 80),
]
for label, good in checks:
    (ok if good else bad)(label)

raw = json.dumps(data)
if "sk-" in raw or "Authorization" in raw:
    bad("response body contains key-like material")
else:
    ok("response contains no key material")
PY

# --- 2. CORS ----------------------------------------------------------------
if [ -n "$ORIGIN" ]; then
  echo
  echo "2. CORS for $ORIGIN"
  acao=$(grep -i '^access-control-allow-origin:' "$hdr" | tr -d '\r' | cut -d' ' -f2-)
  if [ "$acao" = "$ORIGIN" ]; then
    ok "Access-Control-Allow-Origin matches"
  elif [ -z "$acao" ]; then
    bad "no Access-Control-Allow-Origin header — the browser will block this"
    note "fix: vercel env add ALLOWED_ORIGIN production   (value: $ORIGIN)  then redeploy"
  else
    bad "Access-Control-Allow-Origin is '$acao', expected '$ORIGIN'"
  fi

  pre=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 15 -X OPTIONS "$ENDPOINT" \
    -H "Origin: $ORIGIN" -H "Access-Control-Request-Method: POST" 2>/dev/null)
  [ "$pre" = "204" ] && ok "preflight OPTIONS returns 204" || bad "preflight OPTIONS returned $pre, expected 204"
fi

# --- 3. it refuses what it should -------------------------------------------
echo
echo "3. Rejections"
g=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 15 "$ENDPOINT" 2>/dev/null)
[ "$g" = "405" ] && ok "GET is rejected with 405" || bad "GET returned $g, expected 405"

e=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 15 -X POST "$ENDPOINT" \
  -H "Content-Type: application/json" --data '{"query":"   "}' 2>/dev/null)
[ "$e" = "400" ] && ok "empty query is rejected with 400" || bad "empty query returned $e, expected 400"

rm -f "$hdr" "$out"
# grep -c prints 0 and exits 1 when nothing matches; that exit status is not
# an error here, so take the count and ignore it.
pass=$(grep -c '^P$' "$RESULTS" 2>/dev/null); pass=${pass:-0}
fail=$(grep -c '^F$' "$RESULTS" 2>/dev/null); fail=${fail:-0}
echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
