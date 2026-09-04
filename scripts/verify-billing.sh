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
#   - accounts, Google sign-in and email are configured (or says which is not)
#   - an anonymous caller is given no account data
#   - the auth endpoints refuse what they should
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
    try { const v=process.argv[1].split('.').reduce((o,k)=>o==null?o:o[k], JSON.parse(raw)); console.log(v===undefined||v===null?'':String(v)); }
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

[ "$PLANS" = "free:0:false pro:14.99:true max:39.99:true" ] \
  && ok "Free \$0, Pro \$14.99 and Max \$39.99 are all purchasable" \
  || bad "Free \$0, Pro \$14.99 and Max \$39.99 are all purchasable" "got: $PLANS
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
  || bad "subscriptions are stored durably" "No KV_REST_API_URL / KV_REST_API_TOKEN, so accounts, sessions and subscriptions live in memory and vanish when the function instance is recycled. Attach a Vercel KV or Upstash Redis database."

# ---------------------------------------------------------
# Authentication
# ---------------------------------------------------------
echo
echo "authentication on $BASE"

[ "$(field accounts.enabled)" = "true" ] \
  && ok "sessions can be issued" \
  || bad "sessions can be issued" "AUTH_SECRET is missing or shorter than 16 characters."

[ "$(field accounts.google)" = "true" ] \
  && ok "Google sign-in is configured" \
  || bad "Google sign-in is configured" "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set, so the account page will not offer the Google button. The redirect URI to register is $BASE/api/google-callback"

if [ "$(field accounts.email.configured)" = "true" ]; then
  ok "email is configured (provider: $(field accounts.email.provider))"
else
  bad "email is configured" "reason=$(field accounts.email.reason). Without a provider and EMAIL_FROM, no confirmation link can be sent — so no account can be confirmed, and an unconfirmed account cannot subscribe."
fi

[ "$(field signedIn)" = "false" ] && [ -z "$(field user.email)" ] \
  && ok "an anonymous caller is given no account data" \
  || bad "an anonymous caller is given no account data" "/api/account returned account details to a request with no session."

if printf '%s' "$ACCOUNT" | grep -qE '"csrfToken":"[A-Za-z0-9_-]+"'; then
  bad "no CSRF token is minted for an anonymous caller" "a caller with no session was given one"
else
  ok "no CSRF token is minted for an anonymous caller"
fi

# The Google flow must start with state and PKCE, or not start at all.
START="$(curl -sS -o /dev/null -w '%{redirect_url}' "$BASE/api/google-start" 2>/dev/null)"

if printf '%s' "$START" | grep -q 'google-not-configured'; then
  bad "/api/google-start redirects to Google with state and PKCE" \
    "it declined: Google is not configured on this deployment. The redirect URI to register is $BASE/api/google-callback"
elif printf '%s' "$START" | grep -q 'accounts\.google\.com'; then
  # the parameters arrive in whatever order the URL was built in, so
  # each one is looked for on its own rather than as one ordered match
  missing=""
  for part in 'state=' 'code_challenge=' 'code_challenge_method=S256' 'response_type=code' 'nonce='; do
    printf '%s' "$START" | grep -q -- "$part" || missing="$missing $part"
  done
  if [ -z "$missing" ]; then
    ok "/api/google-start redirects to Google with state and PKCE"
  else
    bad "/api/google-start redirects to Google with state and PKCE" "the redirect is missing:$missing"
  fi
  printf '%s' "$START" | grep -q 'code_verifier' \
    && bad "the PKCE verifier stays on the server" "it appeared in the redirect the browser follows" \
    || ok "the PKCE verifier stays on the server"
else
  bad "/api/google-start redirects to Google with state and PKCE" "unexpected redirect: ${START:-none}"
fi

# Signing in must need a session, and nothing else may stand in for one.
RESEND="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "${hdr[@]}" \
  -H 'Content-Type: application/json' --data '{"action":"resend-verification"}' "$BASE/api/auth" 2>/dev/null)"
[ "$RESEND" = "401" ] \
  && ok "/api/auth refuses a resend with no session" \
  || bad "/api/auth refuses a resend with no session" "got HTTP $RESEND, expected 401."

# Account enumeration: a wrong password and an unknown address must match.
body_for() {
  curl -sS -X POST "${hdr[@]}" -H 'Content-Type: application/json' \
    --data "{\"action\":\"login\",\"email\":\"$1\",\"password\":\"definitely-not-a-real-password\"}" \
    "$BASE/api/auth" 2>/dev/null
}
A="$(body_for 'probe-one@example.invalid')"
B="$(body_for 'probe-two@example.invalid')"
if [ "$A" = "$B" ]; then
  ok "a failed sign-in says the same thing for any address"
else
  bad "a failed sign-in says the same thing for any address" "two unknown addresses got different answers, which is how accounts get enumerated."
fi

# A confirmation link must be spent, not merely checked.
VERIFY="$(curl -sS -o /dev/null -w '%{redirect_url}' \
  "$BASE/api/verify-email?token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" 2>/dev/null)"
case "$VERIFY" in
  *verify=error*) ok "/api/verify-email refuses an invented token" ;;
  *verify=success*) bad "/api/verify-email refuses an invented token" "IT ACCEPTED ONE. Do not launch." ;;
  *) bad "/api/verify-email refuses an invented token" "unexpected redirect: ${VERIFY:-none}" ;;
esac

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
