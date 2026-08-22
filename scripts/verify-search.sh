#!/usr/bin/env bash
# Verifies a deployed FindWear product-search endpoint end to end, with the
# request the interpreter produces for "black oversized hoodie under $80".
#
#   ./scripts/verify-search.sh https://your-app.vercel.app/api/search
#
# Optionally pass the browser origin that will call it, to check CORS:
#
#   ./scripts/verify-search.sh https://your-app.vercel.app/api/search https://lxmafromnyc.github.io
#
# Checks that every product the browser receives carries a real title,
# image, price, retailer and direct retailer product URL — and that none is
# a Google or redirect link. Exits non-zero if any check fails. Never
# prints your API key.

set -uo pipefail

ENDPOINT="${1:-}"
ORIGIN="${2:-}"

if [ -z "$ENDPOINT" ]; then
  echo "usage: $0 <search-endpoint-url> [browser-origin]" >&2
  exit 2
fi

RESULTS=$(mktemp)
export RESULTS
trap 'rm -f "$RESULTS"' EXIT
ok()   { echo "  PASS  $1"; echo P >> "$RESULTS"; }
bad()  { echo "  FAIL  $1"; echo F >> "$RESULTS"; }
note() { echo "        $1"; }

echo "Verifying $ENDPOINT"
echo
echo '1. Searching the intent for "black oversized hoodie under $80"'

# exactly the shape /api/interpret returns for that request
read -r -d '' BODY <<'JSON'
{"intent":{"categories":["hoodie"],"colors":["black"],"occasions":[],"fits":["oversized"],
"brands":[],"styles":[],"keywords":["hoodie"],"maxPrice":80,"minPrice":null,
"season":null,"gender":null},"limit":12}
JSON

hdr=$(mktemp); out=$(mktemp)
code=$(curl -sS -o "$out" -D "$hdr" -w "%{http_code}" --max-time 40 \
  -X POST "$ENDPOINT" \
  -H "Content-Type: application/json" \
  ${ORIGIN:+-H "Origin: $ORIGIN"} \
  --data "$BODY" 2>/dev/null)

if [ "$code" = "200" ]; then
  ok "endpoint returned 200"
elif [ "$code" = "503" ]; then
  bad "endpoint returned 503 — no product source is configured on the deployment"
  note "fix: vercel env add PRODUCT_SOURCE production      (value: openwebninja)"
  note "     vercel env add OPENWEBNINJA_API_KEY production"
  note "then redeploy: env vars only apply to builds made after they were added"
elif [ "$code" = "502" ]; then
  bad "endpoint returned 502 — it reached the provider but the call failed"
  note "check the function logs: vercel logs <deployment-url>"
  note "common causes: invalid key, exhausted quota, or a rate limit"
elif [ "$code" = "000" ]; then
  bad "could not reach $ENDPOINT at all — is the URL right and the deployment live?"
else
  bad "endpoint returned $code"
fi

python3 - "$out" <<'PY'
import json, os, sys
from urllib.parse import urlparse

_tally = open(os.environ["RESULTS"], "a")
def ok(m):  print("  PASS  " + m); _tally.write("P\n"); _tally.flush()
def bad(m): print("  FAIL  " + m); _tally.write("F\n"); _tally.flush()

try:
    data = json.load(open(sys.argv[1]))
except Exception:
    bad("response was not JSON"); sys.exit(0)

source = data.get("source")
products = data.get("products")
if not isinstance(products, list):
    bad("no products array in the response"); sys.exit(0)

print("        source: %r   returned: %s   verified: %d   rejected: %s"
      % (source, data.get("returned"), len(products), json.dumps(data.get("rejected") or {})))

if not products:
    bad("no verified products came back")
    note = data.get("rejected") or {}
    if note:
        print("        every record was dropped by the gate. The reasons name the")
        print("        missing or unusable field. Run scripts/probe-openwebninja.js")
        print("        with your key to see the live field names.")
    sys.exit(0)

ok("%d verified products came back" % len(products))

AGGREGATORS = ("google.", "googleadservices.", "bing.", "duckduckgo.", "yahoo.")
problems = {"title": [], "image": [], "price": [], "retailer": [], "url": [], "aggregator": [], "budget": []}

for p in products:
    if not p.get("name"): problems["title"].append(p)
    img = p.get("imageUrl") or ""
    if not img.startswith("http"): problems["image"].append(p)
    price = p.get("price")
    if not isinstance(price, (int, float)) or price <= 0: problems["price"].append(p)
    elif price > 80: problems["budget"].append(p)
    if not p.get("retailer"): problems["retailer"].append(p)
    url = p.get("productUrl") or ""
    if not url.startswith("http"):
        problems["url"].append(p)
    else:
        host = (urlparse(url).hostname or "").lower()
        if any(host == a.rstrip(".") or host.endswith("." + a.rstrip(".")) or host.startswith(a) for a in AGGREGATORS):
            problems["aggregator"].append(p)

for label, msg in [
    ("title",      "every product has a title"),
    ("image",      "every product has an absolute image URL"),
    ("price",      "every product has a real price"),
    ("retailer",   "every product names its retailer"),
    ("url",        "every product has an absolute product URL"),
    ("aggregator", "no product links to Google or another aggregator"),
    ("budget",     "no product is over the stated $80 budget"),
]:
    if problems[label]:
        bad("%s — %d failed" % (msg, len(problems[label])))
        for p in problems[label][:3]:
            print("        offender: %s" % json.dumps({k: p.get(k) for k in ("name", "price", "retailer", "imageUrl", "productUrl")})[:300])
    else:
        ok(msg)

hosts = sorted({(urlparse(p.get("productUrl") or "").hostname or "?") for p in products})
retailers = sorted({p.get("retailer") for p in products if p.get("retailer")})
print("        retailers: %s" % ", ".join(retailers))
print("        link hosts: %s" % ", ".join(hosts))
if len(retailers) > 1:
    ok("results span more than one retailer")
else:
    print("        only one retailer in this page of results — not a failure, but")
    print("        broad coverage is the reason this provider was chosen.")

raw = json.dumps(data)
if "x-api-key" in raw.lower() or "sk-" in raw:
    bad("response body contains key-like material")
else:
    ok("response contains no key material")

print()
print("        first product as the browser receives it:")
print("        " + json.dumps(products[0], indent=2).replace("\n", "\n        "))
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
fi

# --- 3. it refuses what it should -------------------------------------------
echo
echo "3. Rejections"
g=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 15 "$ENDPOINT" 2>/dev/null)
[ "$g" = "405" ] && ok "GET is rejected with 405" || bad "GET returned $g, expected 405"

rm -f "$hdr" "$out"
pass=$(grep -c '^P$' "$RESULTS" 2>/dev/null); pass=${pass:-0}
fail=$(grep -c '^F$' "$RESULTS" 2>/dev/null); fail=${fail:-0}
echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
