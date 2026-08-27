# Fynd — AI clothing finder

A four-page site where you describe the clothes you want in your own words and get
back matching items. "I need a black shirt for school under $50" is a complete
request — there is no form to fill in.

The interface is deliberately plain: one typeface, three levels of neutral ink
(black for primary text, one step down for body copy, muted for metadata), and
two brand hues used only where they are saying something.

Hierarchy is carried by size, weight, space and surface. Every page opens on a
lightly tinted band — the stage — holding the headline and the search card, and
closes on one inverted block that carries the call to action and the footer
together. In between, the page is white. The search card is the only elevated
layer and the primary button the only filled control, so the thing to do next
is never in doubt.

## Colour

Every colour in the interface is a token in the `:root` block of
`assets/styles.css`, and no rule anywhere writes a raw value. The foundation —
pages, cards, type, rules — is neutral; the hues have jobs:

| Token | Job |
| --- | --- |
| `--color-primary` | Trust and action: the one filled control, the focus ring, the current page, links, the logo mark, and the retailer a product came from |
| `--color-accent` | Discovery and energy: the example searches and the numbered steps — the places that invite a try |
| `--color-success` | A live listing came back from a real product source |
| `--color-warning` | A caveat: sample data, or a request that needs fixing before it can run |

Each hue comes in weights — the solid for filled controls, an `-ink` dark enough
to set type on white, and where it is needed a `-soft` tint and a `-line` edge.
Every ink clears 4.5:1 both on the page and on its own tint.

`scripts/test-ui.js` holds the interface to all of this by walking the rendered
document rather than a fixed list of selectors: every piece of type must be set
in one of the declared inks and must clear its contrast requirement on the
ground it actually sits on, no rule may carry a raw colour value, no token may
go unused, and the palette must still be wired to the CTA, the logo, the current
page, the examples, the steps and the retailer labels.

## Pages

| Page | File | What it does |
| --- | --- | --- |
| Home | `index.html` | States the value proposition, carries the search itself directly under the headline, and shows what an answer looks like |
| Find Clothes | `find-clothes.html` | The same search, with nothing else on the page |
| Discover | `discover.html` | Browse the catalogue, filtered by style |
| Pricing | `pricing.html` | The three plans, which one you are on, and the way to change it |
| Account | `account.html` | Sign in, what you have used this period, and the billing portal |
| About | `about.html` | What the site does and what it takes into account |

Every product, wherever it appears, is drawn by one function in `assets/app.js`
and carries the same six things in the same order — image, retailer, name,
price, attributes, action — so a grid always reads as one set of rows.

## Running it

The site itself is plain HTML, CSS and JavaScript with no build step.

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

Opening `index.html` directly in a browser also works. Without the interpreter
endpoint below, requests are read by a small local parser instead of the AI. The
page still returns results, and says on screen that the AI did not read the
request — a keyword match is never presented as an AI reading.

`pricing.html` lists the plans from its own markup, so it reads correctly with
no server at all. Signing in, subscribing and the usage meters need the
functions in `api/`, and the page says plainly when they are not reachable.

## Structure

```
index.html, find-clothes.html, discover.html, about.html
api/interpret.js        serverless endpoint; calls OpenAI, holds the API key
api/search.js           serverless endpoint; asks the product source for real listings
api/providers/          product source adapters and the verification gate
api/account.js          what plan the caller is on, and what they have used
api/auth.js             sign up, sign in, sign out
api/checkout.js         opens a Stripe Checkout Session for Pro or Max
api/portal.js           opens Stripe's billing portal
api/stripe-webhook.js   the ONLY thing that can change a plan
api/_plans.js           Free, Pro and Max, and what each entitles you to
api/_stripe.js          Stripe's REST API, and webhook signature verification
api/_usage.js           the token and search counters
api/_meter.js           what /api/interpret and /api/search ask before spending
api/_auth.js            password hashing, session cookies, who a request is
api/_users.js           user records, and the Stripe customer mapping
api/_store.js           the key/value store: Vercel KV / Upstash, or memory
api/providers/openwebninja.js  OpenWeb Ninja Real-Time Product Search adapter
api/providers/etsy.js   Etsy Open API v3 adapter, kept as an alternative
assets/search.js        sends interpreted intent to /api/search
scripts/verify-api.sh          checks a deployed interpreter endpoint
scripts/verify-search.sh       checks a deployed search endpoint
scripts/verify-billing.sh      checks a deployed billing setup
scripts/probe-openwebninja.js  prints the provider's live response fields
scripts/test-pipeline.js       offline test of the whole server pipeline
scripts/test-stripe.js         offline test of payments and subscriptions
scripts/test-ui.js             browser test of the search interface
assets/attachments.js          drag-and-drop and file picker for the search box
assets/account.js       talks to the account and billing endpoints
assets/billing-ui.js    draws the pricing page and the account page
.env.example            template; the real .env is git-ignored
assets/products.js      data layer: normalises any source into one schema
assets/catalog.js       demo product source, replaceable by a real feed
assets/interpret.js     sends the request to the endpoint; local fallback
assets/app.js           rendering and page behaviour
assets/styles.css       colour tokens, design tokens and all shared components
```

## Connecting the AI

`api/interpret.js` turns a written request into structured preferences. It runs
server-side so `OPENAI_API_KEY` is never sent to a browser. **Do not move this
call into the frontend** — a key in client JavaScript is a key anyone can take.

### Deploying to production

The live setup is: **GitHub Pages (site) → Vercel (interpreter) → OpenAI**. Pages
serves static files only and cannot run the function, which is why the two are
split. Run these from the repository root.

**1. Deploy the function.** No `vercel.json` is needed — Vercel treats `api/*.js`
as serverless functions and serves the rest as static files, which is exactly
this layout. Deploying the whole repo is fine and gives you a second, fully
working same-origin copy of the site at the Vercel URL.

```sh
npm i -g vercel        # once
vercel login
vercel --prod          # deployed: https://ai-clothes-application.vercel.app
```

**2. Store the key.** It lives only in Vercel's encrypted environment. It is
never committed, never bundled, and never sent to a browser.

```sh
vercel env add OPENAI_API_KEY production      # paste the key when prompted
vercel env add ALLOWED_ORIGIN production      # value: https://lxmafromnyc.github.io
vercel --prod                                 # redeploy so the vars take effect
```

`ALLOWED_ORIGIN` is scheme and host only — no path, no trailing slash. For this
repository's Pages site that is exactly `https://lxmafromnyc.github.io`.

**3. Point the site at the function.** Already done — `index.html` and
`find-clothes.html` each carry the tag. The tag name and the
`window.FINDWEAR_API` override keep their original spelling, so an existing
deployment needs no configuration change:

```html
<meta name="findwear-api" content="https://ai-clothes-application.vercel.app/api/interpret">
```

This is the only place the endpoint is configured. Change it here if the
deployment URL ever changes; `window.FINDWEAR_API` overrides it at runtime if
you need to point somewhere else without editing the file.

**4. Verify the whole chain.**

```sh
./scripts/verify-api.sh https://ai-clothes-application.vercel.app/api/interpret https://lxmafromnyc.github.io
```

It sends the real request *"Find me a black oversized hoodie under $80"*, then
checks the response came back tagged `source: "openai"`, that a colour, a fit and
the $80 budget were extracted, that CORS allows your Pages origin, that preflight
works, that `GET` and empty queries are refused, and that no key material appears
in the response. It exits non-zero if anything fails and names the fix — a `503`
tells you the key is missing, a missing CORS header tells you `ALLOWED_ORIGIN`
is unset.

Then open the live Ask page, type the same request, and confirm no fallback
notice appears. A notice means the browser did not get an AI reading, and its
wording says which step failed.

### If you would rather not split the hosting

Deploying everything to Vercel removes steps 3 and 4's CORS entirely: the site
and the function share an origin, `/api/interpret` resolves by default, and
`ALLOWED_ORIGIN` can stay unset. The Pages site can then just redirect there.

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | yes | Your OpenAI key. Without it the endpoint returns 503 and the frontend falls back to local parsing. |
| `OPENAI_MODEL` | no | Model to call. Defaults to `gpt-4o-mini`; set it to whatever your account has access to. |
| `OPENWEBNINJA_API_KEY` | yes | The product source's key. Without it `/api/search` returns 503 and the frontend falls back to the sample catalogue, labelled as such. |
| `PRODUCT_SOURCE` | no | Which adapter in `api/providers/` finds the products. Unset runs `openwebninja`, which is what this deployment uses. |
| `ALLOWED_ORIGIN` | no | Extra browser origins allowed to call the endpoints, comma-separated. The deployment's own origin is always allowed without configuration, so this is only needed for a frontend hosted elsewhere — GitHub Pages calling functions on Vercel. See [Cross-origin access](#cross-origin-access). |
| `STRIPE_SECRET_KEY` | for billing | Your Stripe key. `sk_test_…` until launch. Without it the paid plans cannot be bought and the pricing page says so. |
| `STRIPE_WEBHOOK_SECRET` | for billing | The signing secret of the webhook endpoint (`whsec_…`). Without it every delivery is refused, so no plan ever changes. |
| `STRIPE_PRICE_PRO` | for billing | The Stripe Price Pro is sold at — recurring, monthly, $14.99. |
| `STRIPE_PRICE_MAX` | for billing | The Stripe Price Max is sold at — recurring, monthly, $79.99. |
| `AUTH_SECRET` | for billing | Signs the session cookie; 16 characters or more. Without it nobody can sign in, so nobody can subscribe. |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | for billing | Where accounts, subscriptions and usage counters are kept. Vercel KV sets these when a database is attached; `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` are read too. Without either, state is held in memory and lost on restart. |

See [Plans, payments and subscriptions](#plans-payments-and-subscriptions) for the whole billing setup.

Both keys are server-side secrets. Set them in your host's dashboard or CLI
(`npx vercel env add OPENAI_API_KEY`, `npx vercel env add
OPENWEBNINJA_API_KEY`). Never put either in a file you commit, never prefix
one so a bundler would publish it, and never move either call into the frontend
— a key in client JavaScript is a key anyone can read.

### Attachments on the search box

Photos and documents can be dropped onto the search card or chosen with the
**Attach files** button. Images get a thumbnail; PDFs and other documents are
named and labelled with their type rather than rendered as a picture they are
not.

Accepted: JPEG, PNG, WEBP, GIF, AVIF, HEIC, BMP, PDF, TXT, CSV, RTF, DOC, DOCX,
ODT. Up to 8 files, 10 MB each, 40 MB together. A file whose type the browser
does not report is judged by its extension, so a photo straight off a phone is
not turned away.

**Nothing is uploaded.** Files are held in the page until the search is
submitted, and even then only a manifest travels — each file's name, type and
size. The bytes stay in the browser, because nothing on the server can read a
file yet, and sending megabytes to be discarded would spend the shopper's
bandwidth and put their photos on a server for no purpose.

`/api/search` accepts that manifest, shapes it, and reports back
`attachments: { received: n, used: 0 }`. The interface says the same thing in
words under the chips. An attachment is never presented as something that
influenced the results, because it did not.

When the backend can use them, `manifest()` in `assets/attachments.js` is the
one function that changes.

Interface behaviour is covered by `node scripts/test-ui.js`, which drives the
real page in a browser: dragging, dropping, the picker, multiple files,
refusals, removal and submission.

### Cross-origin access

Both endpoints spend money — one on OpenAI credit, the other on product-search
quota — so who may call them from a browser is decided in one place,
`api/_cors.js`, rather than twice with a chance of drifting apart.

Four sources of allowed origins, in order of how much configuration each needs:

1. **Fynd's own published site**, listed as `SITE_ORIGINS` in `api/_cors.js`.
   The Pages site is a fact about the project, not a deployment setting, so it
   lives in the repository where it cannot go missing. These are public
   origins, not secrets — the same hostname is already in the meta tag of every
   page — and keeping them here means the site cannot be locked out of its own
   API by a mistyped or undelivered environment variable.
2. **The deployment's own origin**, matched against the request's `Host`
   header. A page served from the same host as the function is same-origin by
   definition. No configuration, and it keeps working on production, preview
   and custom domains alike.
3. **The deployment's Vercel hostnames**, from the system environment variables
   Vercel injects at runtime (`VERCEL_PROJECT_PRODUCTION_URL`,
   `VERCEL_BRANCH_URL`, `VERCEL_URL`). Needs *Automatically expose System
   Environment Variables* left enabled in project settings, which is the
   default.
4. **`ALLOWED_ORIGIN`**, for anything the first three do not cover. It adds to
   the list and cannot remove from it. One origin or several, comma-separated. A trailing slash is tolerated and
   stripped, because pasting a URL out of an address bar brings one along and
   the resulting mismatch is invisible in a dashboard.

```
ALLOWED_ORIGIN=https://lxmafromnyc.github.io
ALLOWED_ORIGIN=https://lxmafromnyc.github.io,https://findwear.example
```

There is deliberately no wildcard and no blanket `*.vercel.app` rule: that
would let anybody's Vercel deployment spend this project's API credit.

**A rejected origin gets a 403, preflight included.** This matters more than it
looks. Answering a preflight `204` without the CORS headers is what a browser
treats as a rejection, but the log only records the `204` — so a misconfigured
deployment reads as a working one, and the failure appears to be somewhere else
entirely. A `403` puts the reason in the log where it can be found:

```
OPTIONS /api/search → 403    the Origin is not allowed
OPTIONS /api/search → 204    the Origin is allowed; the POST will follow
```

A request with no `Origin` header is not a browser cross-origin request —
`curl`, a server-to-server call — and is left alone, so the verification
scripts keep working.

### How a request flows

```
"a black oversized hoodie under $80"
        |
        v
  POST /api/interpret          browser sends the request plus the
        |                      vocabulary the catalogue can match
        v
  OpenAI chat completions      key lives here, server-side only
        |                      the model reads the request; it never
        |                      names a product, price, shop or URL
        v
  { categories: ["hoodie"], colors: ["Black"],
    fits: ["Oversized"], maxPrice: 80, ... }
        |
        v
  POST /api/search             the interpreted constraints, nothing else
        |
        v
  OpenWeb Ninja                q=black oversized hoodie, max_price=80
  Real-Time Product Search     key lives here, server-side only
        |
        v
  real products, each carrying its own photo
  and its own retailer offer
        |
        v
  the verification gate        drops anything without a title, price,
        |                      image, retailer or direct product URL
        v
  rendered, badged with the retailer, linking to its page
```

If the interpreter fails, the frontend reads the request locally instead and
shows a notice saying so, naming the reason: no interpreter connected, deployed
without a key, unreachable, or an unusable reply.

What the page may show when there are no products depends on why:

| `/api/search` says | State | The page shows |
| --- | --- | --- |
| `503` / `404` | `not-configured` | the sample catalogue, with a notice and a `Sample` badge on every row that is not a real listing |
| `502`, or unreachable | `unavailable` | "Product search unavailable" — **no** sample rows |
| `200`, empty `products` | `empty` | "No matches found" — **no** sample rows |

The sample catalogue stands in only when nothing is connected at all. Once a
product source is configured, a failed or empty search says so plainly: a
deployment that can sell things must never pad the page with demo rows, however
clearly they are labelled. No product is ever invented to fill the gap.

### Worth knowing

- The endpoint caps requests at 400 characters and asks the model for JSON only,
  then re-validates every field before returning it — a malformed or hostile
  reply cannot reach the matching code.
- Upstream errors are logged server-side but never echoed to the browser, since
  they can quote the request.
- Every interpretation is metered. The tokens OpenAI reports for the call are
  counted against the caller's plan — 20,000 a day on Free, a million a month on
  Pro, five million on Max — and a caller with nothing left gets a 429 before the
  model is called, so no credit is spent on a request that is over the limit. The
  frontend then reads the request locally and says on screen that it did. See
  [Plans, payments and subscriptions](#plans-payments-and-subscriptions).
- The plan comes from the stored user record, which is derived from a Stripe
  subscription. Nothing in the request reaches it: there is no header, cookie
  value or body field that raises a limit.

## Product search

The two halves of a search have separate jobs, and neither does the other's:

- **`/api/interpret` understands the request.** It turns "black oversized Nike
  hoodie under $80" into structured constraints. It never names a product,
  a price, a shop or a URL.
- **`/api/search` finds the products.** It hands those constraints to a product
  source, and everything shown on a card comes back from that source.

Nothing in between invents anything. The model is never asked what a product
costs or where to buy it, because it does not know — only the source does.

No provider is hard-coded: the registry in `api/providers/product-source.js`
decides which adapter runs from `PRODUCT_SOURCE`. Unset, or naming an adapter
whose credentials are missing, and the endpoint answers 503 and the interface
says plainly that no product source is connected.

### OpenWeb Ninja (the provider Fynd runs on)

[Real-Time Product Search](https://www.openwebninja.com/api/real-time-product-search)
searches Google Shopping's cross-retailer index, so one query reaches Amazon,
Walmart, Target, Nordstrom, ASOS and the long tail of clothing merchants rather
than one shop's catalogue. Set these in the server environment:

| Variable | Required | Purpose |
| --- | --- | --- |
| `OPENWEBNINJA_API_KEY` | yes | Your API key, sent as the `x-api-key` header. This is the only variable the product search needs. |
| `PRODUCT_SOURCE` | no | Which adapter to run. Left unset, the OpenWeb Ninja adapter is used when its key is present. Set it only to run a different one. |
| `OPENWEBNINJA_COUNTRY` | no | Marketplace to search, ISO 3166-1 alpha-2. Defaults to `us` |
| `OPENWEBNINJA_LANGUAGE` | no | Result language, ISO 639-1. Defaults to `en` |

Set them on the server only. The key is read inside the serverless function,
sent as a request header rather than in the query string, and never included in
a response — a 502 from the provider is logged server-side and reported to the
browser as a generic message, so neither the key nor the upstream body leaks.

```sh
vercel env add OPENWEBNINJA_API_KEY production
```

Setting `PRODUCT_SOURCE` is not necessary — an unset value runs the OpenWeb
Ninja adapter whenever its key is present, so there is no second variable that
has to agree with the first. An explicit value always wins, and one naming no
adapter selects none, so a typo surfaces as a 503 rather than quietly running
something else.

Environment variables apply to the next build, not the running deployment, so
redeploy after adding them.

#### Intent to query

The adapter builds one search phrase from the interpreter's output, in the
order a shopper would type it — gender, colour, fit, style, brand, garment,
occasion, then any remaining keywords:

```
{ colors: ["black"], fits: ["oversized"], brands: ["Nike"],
  categories: ["hoodie"], maxPrice: 80 }

  ->  q=black oversized nike hoodie & max_price=80 & country=us
```

Only words the shopper's own request produced are used. `season` is left out
deliberately: it reads as a keyword to the search engine and would narrow
results on a word used descriptively. The stated budget is passed to the source
as `max_price`, and any offer that still comes back above it is dropped.

#### Mapping

Confirmed against a live response: the commerce fields appear at the **top
level** of a search record, not only nested under `offer`. Both shapes are read.

| Fynd | OpenWeb Ninja |
| --- | --- |
| `title` | `product_title` |
| `imageUrl` | `product_photos[0]`, from that product's own photo list |
| `price` | `price`, or the price of the resolved offer |
| `retailer` | `store_name` — a domain, e.g. `nike.com` |
| `productUrl` | the resolved offer's `offer_page_url` — **never** `product_page_url` |
| `brand` | `product_attributes.Brand`, when present |

#### Where a direct retailer URL actually comes from

`/search` returns Google Shopping's **product view**. Its `product_page_url` is
a Google URL — a live response returned a `google.com/search?…` URL in it. It is
never the retailer's page, so it is never used as one. `store_name` is a domain,
and a domain is not a URL: no link is ever built from it.

The per-seller links live behind a second endpoint, confirmed in the vendor's
OpenAPI manifest:

```
GET /realtime-product-search/v2/product-offers?product_id=…
"Get all offers available for a product. Each page of offers contains
 offers from 10 sellers."
```

So the adapter:

1. uses whatever link the search record already carries, if it is a real
   retailer URL — some records have one
2. otherwise asks `/product-offers` for that `product_id` and takes the first
   offer that has one, preferring the shop the search result named
3. otherwise leaves the record without a URL, and the gate drops it

Nothing is inferred at any step.

**This costs one extra request per product that needs a link.** A page of 12
products is up to 13 requests rather than 1. On the $25/mo Pro plan that is
roughly 770 shopper searches a month rather than 10,000. Two knobs bound it:

| Variable | Default | Effect |
| --- | --- | --- |
| `OPENWEBNINJA_RESOLVE_OFFERS` | on | `off` skips the lookups entirely — cheaper, and almost everything is then dropped for having no retailer link |
| `OPENWEBNINJA_OFFER_BUDGET_MS` | 6000 | total wall-clock budget for the lookups; whatever resolved by then is what shows |

Lookups also stop early once enough records have a link, and only products
that need one are looked up at all.

#### Response fields: what is verified, and what is not

The request parameters above are taken from the vendor's own OpenAPI-derived
manifest, shipped in `@openwebninja/mcp-server`. The response field names come
from the vendor's published documentation and have **not** been confirmed
against a live call in this repository.

The mapping is therefore written to fail closed. It accepts the documented
spellings and their obvious variants, and anything it does not recognise
produces a record missing its required fields — which the gate rejects and
counts. A wrong field name shows up as an empty result set with a populated
`rejected` tally. It can never show up as an invented product.

To confirm the live shape, run the probe with a real key:

```sh
OPENWEBNINJA_API_KEY=... node scripts/probe-openwebninja.js "black oversized hoodie"
```

It prints the response envelope's keys, every key on the first product and on
that product's offer, the record the adapter maps out of it, and the gate's
verdict for the batch — enough to see at a glance which alias to add if a name
differs.

### Etsy (kept, unused)

`api/providers/etsy.js` still works and is still registered, but production
never calls it: nothing selects Etsy unless `PRODUCT_SOURCE=etsy` names it
explicitly, and an unset `PRODUCT_SOURCE` runs OpenWeb Ninja instead. Deleting
one `require` and one registry line removes it entirely. It searches a single
catalogue, which is why it is no longer the default.

### Testing the pipeline

Offline, with no key and no network — intent, mapping, the gate's rejection
rules, and the JSON `/api/search` returns:

```sh
node scripts/test-pipeline.js
```

Payments and subscriptions are a separate offline suite, and the interface is
driven in a real browser:

```sh
node scripts/test-stripe.js
node scripts/test-ui.js
```

Against a live deployment, with the request the interpreter produces for
"black oversized hoodie under $80":

```sh
./scripts/verify-search.sh https://ai-clothes-application.vercel.app/api/search \
  https://lxmafromnyc.github.io
```

It checks that every product the browser receives has a title, an absolute
image URL, a real price, a named retailer and a direct retailer product URL,
that none links to Google or another aggregator, and that none is over the
stated budget.

Or call it by hand:

```sh
curl -s -X POST https://ai-clothes-application.vercel.app/api/search \
  -H 'Content-Type: application/json' \
  --data '{"intent":{"categories":["hoodie"],"colors":["black"],"fits":["oversized"],"maxPrice":80},"limit":6}'
```

What the reply tells you:

| Response | Meaning |
| --- | --- |
| `"source":"openwebninja"` with a populated `products` array | Live. Each entry carries a real title, price, image URL, retailer and product-page URL. |
| `"source":"openwebninja"`, `products` empty, `rejected` populated | The source answered but nothing passed the gate. `rejected` names the fault for each dropped record; run the probe above to compare with the live field names. |
| `503` `"No product source is configured."` | `PRODUCT_SOURCE` is unset, or names a provider whose credentials are missing. Environment variables only apply to deployments built after they were added, so a redeploy is usually what is missing. |
| `502` | The provider was reached but failed. The reason is in the function logs, never in the response. |

### Adding another provider

1. Create `api/providers/<name>.js` exporting `{ name, configured, search }`:

```js
module.exports = {
  name: 'example',
  defaultRetailer: 'Example Store',
  configured: () => Boolean(process.env.EXAMPLE_API_KEY),
  async search(intent, { limit }) {
    // intent is the interpreter's output:
    //   categories, colors, occasions, fits, brands, styles,
    //   maxPrice, minPrice, season, gender, keywords
    // return raw records; field names are mapped for you
  }
};
```

2. Register it in `PROVIDERS` in `product-source.js`.
3. Set `PRODUCT_SOURCE=example` and the provider's credentials in Vercel.

That is the whole integration. The frontend, the schema and the rendering do
not change.

### The verification gate

Every record must arrive from the source with all five of:

```
title   price   imageUrl   productUrl   retailer
```

A record missing any one is dropped, never filled in.

`brand` is optional. A cross-retailer source often carries no separate brand
for a listing, and a hoodie is still a real hoodie without one — so a brandless
record passes, and the card simply shows no brand line. What is never done is
putting something else there: the retailer's name in the brand field would be
a fabricated attribution.

`productUrl` must address a specific product page on the retailer's own site.
Three kinds of link are rejected:

| Rejected | Reason |
| --- | --- |
| `https://www.uniqlo.com/`, `https://shop.com/search` | a homepage or listing is not the product the card claims to show |
| `https://www.google.com/shopping/product/…` | an aggregator's comparison page is not a retailer's product page |
| `https://…/aclk?u=https://…` | a redirector's destination cannot be read off the link |

Out-of-stock records are dropped; a source that says nothing about stock is not
assumed to be out of stock. Prices must parse to a positive number. The
response reports how many records were rejected and why, so a badly behaved
provider is visible rather than silently thinning the results.

Records are shown in the order the source returned them, with the retailer
named on the card. Fynd does not attach a match percentage to any result: it
did not score the provider's records, and a made-up score would be inventing
information about a real product. What the request was read as is said once,
above the grid, rather than claimed again on every card.

## Plans, payments and subscriptions

Fynd has three plans. Free needs no account and no card; Pro and Max are
monthly subscriptions bought through Stripe Checkout.

| Plan | Price | AI tokens | Live product searches |
| --- | --- | --- | --- |
| Free | $0 | 20,000 per day | 3 per day |
| Pro | $14.99 / month | 1,000,000 per month | 75 per month |
| Max | $79.99 / month | 5,000,000 per month | 400 per month |

Free counts by UTC day and the paid plans by UTC calendar month, because
that is how each is written. The period is part of the counter's key, so
upgrading starts the monthly allowance at zero rather than inheriting a
day's use — somebody who upgrades is buying the month, not the remainder
of an afternoon.

Fynd never sees a card. The shopper types their card on Stripe's own
pages, and changing a card, switching plan, downloading an invoice and
cancelling all happen in Stripe's billing portal. There is no billing
screen in this repository, on purpose: a second place to type a card is a
second place for one to leak, and a second copy of a subscription's state
is a second thing to be wrong.

### The rule the whole design rests on

**A plan is raised or lowered by a signed Stripe webhook, and by nothing
else.**

Not by the checkout endpoint, which only opens a session. Not by the page
the shopper lands on afterwards. Not by any request a browser can make.

`/api/account` is the only endpoint the interface reads a plan from, and
it is `GET`-only — there is no write path to answer. The plan on a user
record is not a field anything assigns: `api/_users.js` recomputes it from
the stored subscription on every write, so even a call site that tried to
set one would get back the plan the subscription actually justifies.

That is what makes the success URL harmless. `?checkout=success` is worth
one sentence on screen — "confirming your payment" — and the page then
re-reads `/api/account` until the server changes its mind. Loading that
URL by hand does the same thing and finds the same answer: the plan you
actually have.

Which Stripe statuses entitle anything is one list, in `api/_plans.js`:

| Status | Plan |
| --- | --- |
| `active`, `trialing` | the plan the subscription's price maps to |
| `past_due`, `unpaid`, `incomplete`, `incomplete_expired`, `paused`, `canceled` | Free |

`past_due` being Free is deliberate: a card that stopped working stops the
paid allowance rather than running it on credit. The status is kept and
shown, so the account page says *why* — "your last payment failed, update
your card" — instead of downgrading in silence. A subscription set to
cancel at period end stays `active` until the period ends, which is what
the shopper paid for; the plan drops when Stripe says `canceled`, not when
they press the button.

### Setting it up in Stripe

All of this in **test mode** first. The deployment reports which mode it
is in, and the pricing page says so on screen.

**1. Two products, two prices.** In the Stripe dashboard, *Products → Add
product*:

| Product | Price | Billing period | Currency |
| --- | --- | --- | --- |
| Fynd Pro | 14.99 | Monthly, recurring | USD |
| Fynd Max | 79.99 | Monthly, recurring | USD |

Copy each price's id — it starts `price_`, not `prod_`. The **price** id
is what Fynd needs; the product id is not used.

**2. One webhook endpoint.** *Developers → Webhooks → Add endpoint*:

```
https://your-app.vercel.app/api/stripe-webhook
```

Subscribe it to exactly these six events:

```
checkout.session.completed
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
invoice.paid
invoice.payment_failed
```

Then copy that endpoint's **signing secret** (`whsec_…`). It is on the
endpoint's own page and is not the API key.

**3. Turn on the billing portal.** *Settings → Billing → Customer portal*,
and save it once. Until that is done, "Manage subscription" answers 502 —
the endpoint says `portal-not-configured` when Stripe gives it that
reason.

**4. A database.** Accounts, subscriptions and usage counters have to
outlive a request. Attach Vercel KV to the project (*Storage → Create →
KV*) and Vercel sets `KV_REST_API_URL` and `KV_REST_API_TOKEN` itself; an
Upstash Redis database works too, through
`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`.

Without one, the store falls back to memory. That is right for local
development and for the tests, and wrong for anything else: a
subscription somebody paid for would vanish when the function instance is
recycled. `/api/account` reports `storage.durable: false` and both billing
pages say so on screen.

**5. The variables.**

```sh
vercel env add STRIPE_SECRET_KEY production      # sk_test_… for now
vercel env add STRIPE_WEBHOOK_SECRET production  # whsec_…
vercel env add STRIPE_PRICE_PRO production       # price_…
vercel env add STRIPE_PRICE_MAX production       # price_…
vercel env add AUTH_SECRET production            # 32 random bytes, hex
vercel --prod                                    # redeploy so they take effect
```

Generate `AUTH_SECRET` rather than choosing it:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Environment variables apply to the next build, not the running
deployment, so the redeploy is not optional.

**6. Check it from outside.**

```sh
./scripts/verify-billing.sh https://ai-clothes-application.vercel.app
```

It confirms an anonymous visitor is on Free with the right allowance,
that all three plans are priced and purchasable, that the deployment is
in test mode, that a webhook secret and a durable store are configured,
that `/api/checkout` refuses a caller with no account, and that
`/api/stripe-webhook` refuses both an unsigned delivery and a wrongly
signed one. It creates nothing at Stripe and charges nothing.

**7. Buy something, with a test card.** Sign up on `/account.html`, go to
`/pricing.html`, press **Get Pro**, and pay with `4242 4242 4242 4242`,
any future expiry, any CVC. You should land back on the pricing page,
see "confirming your payment" for a second or two, and then see Pro.

Stripe's CLI is the fastest way to watch the other half:

```sh
stripe listen --forward-to localhost:3000/api/stripe-webhook
stripe trigger customer.subscription.deleted
```

### Where the money and the state actually move

```
  the shopper presses "Get Pro"
        |
        v
  POST /api/checkout            plan: "pro" — a name, and nothing else.
        |                       The price is looked up server-side from
        |                       STRIPE_PRICE_PRO, so a page cannot
        |                       re-price its own checkout.
        v
  Stripe Checkout               the card is typed here, on Stripe's
        |                       domain. Fynd never receives it.
        v
  the shopper lands on /pricing.html?checkout=success
        |                       ...which grants nothing. It re-reads
        |                       /api/account and waits.
        |
  meanwhile, server to server:
        |
  POST /api/stripe-webhook      signature verified against the raw bytes
        |                       with STRIPE_WEBHOOK_SECRET
        v
  the event id is claimed       an atomic set-if-absent. A duplicate
        |                       delivery loses the claim and stops.
        v
  the price id decides the plan the account is on
        |
        v
  /api/account now says Pro, and /api/search and /api/interpret meter
  against 75 searches and 1,000,000 tokens a month
```

### Duplicate deliveries, and events that arrive out of order

Stripe delivers at least once and retries anything it did not hear a 2xx
for, so the same event arrives twice often enough to plan for. Three
separate mechanisms, because they fail in different ways:

- **The same event twice.** The event id is claimed with a set-if-absent —
  an atomic write, not a read followed by a write, so two deliveries
  landing at the same moment on two instances cannot both proceed. Ten
  simultaneous copies of one delivery apply once; `scripts/test-stripe.js`
  fires exactly that.
- **A delivery that fails halfway.** The claim is released and a 500 is
  returned, so Stripe's retry is a real attempt rather than one this
  endpoint has already promised to have handled.
- **An older event behind a newer one.** Deliveries are not ordered: a
  `created` can land after the `deleted` that followed it. Every stored
  subscription carries the timestamp of the event it came from, and an
  older one is dropped. A late `created` cannot resurrect a cancelled
  plan.

### Accounts

Fynd had no accounts before this, and the site's own copy says "no
filters, no account". That is still true for searching. An account exists
for one reason: a subscription has to belong to somebody a webhook can
find later.

- Anonymous visitors are on Free, metered per browser by an opaque device
  cookie — and, for a client that ignores cookies, by a hash of its
  address and user agent, so the allowance is not bypassed by ignoring
  `Set-Cookie`. Neither is airtight and neither needs to be: metering the
  free tier is about the API bill.
- Signing in is `email` and `password`, hashed with scrypt from node's own
  crypto, salted per password, compared in constant time. A wrong password
  and an address with no account give the same answer in the same time.
- The session is an HMAC-signed, `HttpOnly` cookie. No script on the page
  can read it, so no script can leak one. Cross-site it is
  `SameSite=None; Secure` — which is what the Pages-to-Vercel deployment
  needs — and `SameSite=Lax` when the site and the functions share an
  origin.

The Stripe customer id is stored against the user **and** indexed back to
it, because a webhook knows a customer and nothing about Fynd. The
customer is created before the checkout starts, so no event can arrive
naming a customer nothing can resolve, and a customer is never moved to a
different account.

### Why there is no `stripe` package

This repository has no build step, no `package.json` and no
`node_modules`: the site is files, and `node scripts/…` runs the tests
with nothing installed. `api/_stripe.js` calls Stripe's REST API with the
same `fetch` already used for OpenAI and the product source, and verifies
webhook signatures with `node:crypto`.

What that costs is that the request encoding and the signature scheme are
written out rather than imported. Both are small and specified, and
`scripts/test-stripe.js` covers them — signing its webhook payloads with
`crypto` directly rather than with the module that verifies them, so a
bug that made both sides agree on the wrong scheme would still fail.

### Testing it

```sh
node scripts/test-stripe.js
```

Offline, with no key, no Stripe account and no network. It drives the
real endpoints with Stripe's HTTP API stubbed at the `fetch` boundary:
signature verification and its refusals, a Pro checkout, a Max checkout, a
cancelled checkout, cancellation, cancel-at-period-end, a failed payment
and its recovery, a plan change made in the portal, duplicate and
concurrent and out-of-order deliveries, the customer mapping, the account
endpoints, and every way a browser might try to grant itself a plan.

`node scripts/test-ui.js` covers the pricing and account pages in a real
browser, including that landing on `?checkout=success` with the server
still saying Free leaves the page saying Free.

### When something is not working

| What you see | What it is |
| --- | --- |
| The pricing page says the paid plans cannot be bought here | `STRIPE_SECRET_KEY` is not set on the running deployment. Variables apply to the next build — redeploy. |
| Checkout answers 503 with `no-price-id` | `STRIPE_PRICE_PRO` or `STRIPE_PRICE_MAX` is missing. A plan with no price is never sold at some other price. |
| The checkout completes but the plan never changes | The webhook is not reaching Fynd, or is being refused. Check *Developers → Webhooks* in Stripe for the delivery and its response, then the function logs. |
| The webhook answers 400 `Raw body unavailable` | Something parsed the body before the handler saw it, so the exact bytes Stripe signed are gone. `api/stripe-webhook.js` turns body parsing off with its `config` export; a host that ignores it needs its own equivalent. |
| The webhook answers 400 `Signature verification failed` | `STRIPE_WEBHOOK_SECRET` does not match this endpoint. Test and live endpoints have separate secrets, and it is the endpoint's signing secret, not the API key. |
| The webhook answers 503 | `STRIPE_WEBHOOK_SECRET` is not set at all. |
| "Manage subscription" answers 502 `portal-not-configured` | The customer portal has not been saved once in the Stripe dashboard, per mode. |
| A plan is right and then wrong again later | No durable store: state is in memory and the instance was recycled. `verify-billing.sh` reports this. |
| Sign-in answers 503 `no-auth-secret` | `AUTH_SECRET` is missing or shorter than 16 characters. |
| Everything answers 403 | The Origin is not allowed — set `ALLOWED_ORIGIN` for a frontend on another host. See [Cross-origin access](#cross-origin-access). |

The function logs name which variables the running deployment can see —
states only, never values. See `api/_env-report.js`.

### Before taking real money

- Swap `STRIPE_SECRET_KEY` for the live key, and `STRIPE_PRICE_PRO` /
  `STRIPE_PRICE_MAX` for prices created in live mode. Test-mode price ids
  do not exist in live mode.
- Add a **live-mode** webhook endpoint and use *its* signing secret. Test
  and live endpoints are separate objects with separate secrets.
- Turn the customer portal on in live mode too; it is configured per mode.
- Attach a durable store, if you have not. `verify-billing.sh` will tell
  you.
- Re-run `./scripts/verify-billing.sh` against production. It fails on a
  live key, which is what you want right up until the moment you do not.

## The product catalogue

Every product, demo or real, is normalised by `assets/products.js` into one shape:

```
id, name, brand, price, productUrl, imageUrl,
category, styles, occasions, fits, colors, sizes
```

Feeds disagree about field names, so `style`/`styles`, `color`/`colors`,
`url`/`productUrl`, `image`/`imageUrl` and similar are all accepted; `"$49.90"`
parses to a number and `"S,M,L"` to a list. Records missing a name or brand are
dropped rather than throwing, and only `http(s)` links survive.

Swapping the demo catalogue for real data is one call:

```js
Products.load(DEMO_PRODUCTS);          // this repo's demo data
Products.load('/api/products.json');   // a URL returning JSON
Products.load(() => queryDatabase());  // a function or promise
```

The interface subscribes to the store, so filter options, Discover pills and the
matching vocabulary all rebuild from whatever arrives. Unfamiliar colours and
garment categories fall back to neutral artwork rather than breaking.

## Notes

- Typeface is Inter, loaded from Google Fonts.
- Products without an `imageUrl` — which is all of them today — render generated
  artwork built from CSS gradients and inline SVG. Set `imageUrl` on a product
  and it renders the photo; if that photo fails to load, the artwork returns.
- `price` and `imageUrl` are `null` throughout the demo catalogue because no
  retailer domain was reachable from the environment this was built in, so no
  value could be verified. They are ordinary data fields.
- The catalogue is a small sample set plus three real listings; it is not real
  inventory.
