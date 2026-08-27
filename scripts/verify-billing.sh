#!/usr/bin/env bash
# =========================================================
# Fynd — check a deployed billing setup
#
#   ./scripts/verify-billing.sh https://your-app.vercel.app [origin]
#
# Checks the deployment from outside, the way scripts/verify-api.sh and
# scripts/verify-search.sh check the other two endpoints. It creates
# nothing at Stripe and charges nothing: every request it makes is one
# an anonymous visitor could already make.
#
# What it confirms:
#   - /api/account answers, and says which plan an anonymous visitor is on
#   - the plan catalogue carries Free, Pro and Max at the right prices
#   - the deployment is in Stripe TEST mode, not live
#   - both paid plans have a price id configured
#   - subscriptions are stored somewhere durable
#   - /api/checkout refuses a caller with no account
#   - /api/stripe-webhook refuses an unsigned delivery
#   - no response carries a Stripe key
#
# Exits non-zero on the first failure and names the fix.
# =========================================================

set -uo pipefail

BASE="${1:-}"
ORIGIN="${2:-}"

if [ -z "$BASE" ]; then
  echo "usage: $0 https://your-app.vercel.app [https://your-site-origin]" >&2
  exit 2
fi

BASE="${BASE%/}"
BASE="${BASE%/api}"

pass=0
fail=0

ok()   { echo "  ok    $1"; pass=$((pass + 1)); }
bad()  { echo "  FAIL  $1"; echo "        $2"; fail=$((fail + 1)); }

hdr=()
[ -n "$ORIGIN" ] && hdr=(-H "Origin: $ORIGIN")

echo
echo "billing endpoints on $BASE"

# ---------------------------------------------------------
# /api/account
# ---------------------------------------------------------
ACCOUNT="$(curl -sS "${hdr[@]}" "$BASE/api/account" 2>/dev/null)"
STATUS="$(curl -sS -o /dev/null -w '%{http_code}' "${hdr[@]}" "$BASE/api/account" 2>/dev/null)"

if [ "$STATUS" != "200" ]; then
  bad "/api/account answers" "got HTTP $STATUS. A 404 means the function is not deployed; a 403 means this Origin is not allowed (set ALLOWED_ORIGIN)."
  echo
  echo "$pass passed, $fail failed"
  exit 1
fi
ok "/api/account answers"

field() { printf '%s' "$ACCOUNT" | node -e "
  let raw=''; process.stdin.on('data',d=>raw+=d).on('end',()=>{
    try { const v=process.argv[1].split('.').reduce((o,k)=>o==null?o:o[k], JSON.parse(raw)); console.log(v===undefined?'':String(v)); }
    catch (e) { console.log(''); }
  });" "$1"; }

[ "$(field plan.id)" = "free" ] \
  && ok "an anonymous visitor is on the Free plan" \
  || bad "an anonymous visitor is on the Free plan" "got plan.id=$(field plan.id) — a visitor with no account must never be anything but free."

[ "$(field usage.searches.limit)" = "3" ] && [ "$(field usage.aiTokens.limit)" = "20000" ] \
  && ok "the Free allowance is 3 searches and 20,000 tokens a day" \
  || bad "the Free allowance is 3 searches and 20,000 tokens a day" "got searches=$(field usage.searches.limit) tokens=$(field usage.aiTokens.limit)."

PLANS="$(printf '%s' "$ACCOUNT" | node -e "
  let raw=''; process.stdin.on('data',d=>raw+=d).on('end',()=>{
    try {
      const plans=(JSON.parse(raw).plans||[]);
      console.log(plans.map(p=>\`\${p.id}:\${p.amount}:\${p.purchasable}\`).join(' '));
    } catch (e) { console.log(''); }
  });")"

[ "$PLANS" = "free:0:false pro:14.99:true max:79.99:true" ] \
  && ok "Free \$0, Pro \$14.99 and Max \$79.99 are all purchasable" \
  || bad "Free \$0, Pro \$14.99 and Max \$79.99 are all purchasable" "got: $PLANS
        A plan with purchasable=false has no price id: set STRIPE_PRICE_PRO / STRIPE_PRICE_MAX and redeploy."

[ "$(field billing.enabled)" = "true" ] \
  && ok "a Stripe key is configured" \
  || bad "a Stripe key is configured" "STRIPE_SECRET_KEY is not set on this deployment. Add it and redeploy — environment variables only apply to builds made after they were added."

if [ "$(field billing.testMode)" = "true" ]; then
  ok "Stripe is in TEST mode — no real card can be charged"
else
  bad "Stripe is in TEST mode — no real card can be charged" \
    "This deployment is using a LIVE key (sk_live_…). Real cards will be charged. Switch to sk_test_… until you are ready to launch."
fi

[ "$(field billing.webhookConfigured)" = "true" ] \
  && ok "a webhook signing secret is configured" \
  || bad "a webhook signing secret is configured" "STRIPE_WEBHOOK_SECRET is not set, so every delivery will be refused and no plan will ever change. Copy it from the endpoint's page in the Stripe dashboard."

[ "$(field accounts.enabled)" = "true" ] \
  && ok "accounts are enabled" \
  || bad "accounts are enabled" "AUTH_SECRET is missing or shorter than 16 characters, so nobody can sign in and nobody can subscribe."

[ "$(field storage.durable)" = "true" ] \
  && ok "subscriptions are stored durably" \
  || bad "subscriptions are stored durably" "No KV_REST_API_URL / KV_REST_API_TOKEN, so accounts and subscriptions live in memory and vanish when the function instance is recycled. Attach a Vercel KV or Upstash Redis database."

# ---------------------------------------------------------
# nothing secret comes back
# ---------------------------------------------------------
if printf '%s' "$ACCOUNT" | grep -qE 'sk_live_|sk_test_|rk_live_|whsec_|price_[A-Za-z0-9]'; then
  bad "no key or price id reaches the browser" "/api/account returned Stripe key material or a price id."
else
  ok "no key or price id reaches the browser"
fi

# ---------------------------------------------------------
# /api/checkout refuses a caller with no account
# ---------------------------------------------------------
CHECKOUT="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "${hdr[@]}" \
  -H 'Content-Type: application/json' --data '{"plan":"pro"}' "$BASE/api/checkout" 2>/dev/null)"

case "$CHECKOUT" in
  401) ok "/api/checkout refuses a caller with no account" ;;
  503) bad "/api/checkout refuses a caller with no account" "got 503 — Stripe or the price ids are not configured, so this could not be tested." ;;
  *)   bad "/api/checkout refuses a caller with no account" "got HTTP $CHECKOUT, expected 401. A subscription must belong to an account." ;;
esac

# ---------------------------------------------------------
# /api/stripe-webhook refuses anything it did not sign
# ---------------------------------------------------------
FORGED="$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  -H 'Content-Type: application/json' \
  --data '{"id":"evt_forged","type":"customer.subscription.created","data":{"object":{"id":"sub_x","status":"active","customer":"cus_x","items":{"data":[{"price":{"id":"price_x"}}]}}}}' \
  "$BASE/api/stripe-webhook" 2>/dev/null)"

case "$FORGED" in
  400) ok "/api/stripe-webhook refuses an unsigned delivery" ;;
  503) bad "/api/stripe-webhook refuses an unsigned delivery" "got 503 — STRIPE_WEBHOOK_SECRET is not set, so the endpoint cannot verify anything yet." ;;
  200) bad "/api/stripe-webhook refuses an unsigned delivery" "got 200. An unsigned request was ACCEPTED — anybody could grant themselves a plan. Do not launch until this returns 400." ;;
  *)   bad "/api/stripe-webhook refuses an unsigned delivery" "got HTTP $FORGED, expected 400." ;;
esac

BADSIG="$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  -H 'Content-Type: application/json' \
  -H 'stripe-signature: t=1700000000,v1=0000000000000000000000000000000000000000000000000000000000000000' \
  --data '{"id":"evt_forged2","type":"invoice.paid","data":{"object":{}}}' \
  "$BASE/api/stripe-webhook" 2>/dev/null)"

case "$BADSIG" in
  400) ok "/api/stripe-webhook refuses a wrong signature" ;;
  503) ok "/api/stripe-webhook refuses a wrong signature (no secret set yet)" ;;
  *)   bad "/api/stripe-webhook refuses a wrong signature" "got HTTP $BADSIG, expected 400." ;;
esac

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
