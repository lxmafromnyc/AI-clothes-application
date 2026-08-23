# FindWear — AI clothing finder

A four-page site where you describe the clothes you want in your own words and get
back a ranked shortlist. "I need a black shirt for school under $50" is a complete
request — there is no form to fill in.

## Pages

| Page | File | What it does |
| --- | --- | --- |
| Home | `index.html` | States the value proposition and links to the finder |
| Find Clothes | `find-clothes.html` | One text box → AI reads the request → ranked recommendations |
| Discover | `discover.html` | Browse the catalogue, filtered by style |
| About | `about.html` | What the site does and how the matching works |

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

## Structure

```
index.html, find-clothes.html, discover.html, about.html
api/interpret.js        serverless endpoint; calls OpenAI, holds the API key
api/search.js           serverless endpoint; asks the product source for real listings
api/providers/          product source adapters and the verification gate
api/providers/openwebninja.js  OpenWeb Ninja Real-Time Product Search adapter
api/providers/etsy.js   Etsy Open API v3 adapter, kept as an alternative
assets/search.js        sends interpreted intent to /api/search
scripts/verify-api.sh          checks a deployed interpreter endpoint
scripts/verify-search.sh       checks a deployed search endpoint
scripts/probe-openwebninja.js  prints the provider's live response fields
scripts/test-pipeline.js       offline test of the whole server pipeline
scripts/test-ui.js             browser test of the search interface
assets/attachments.js          drag-and-drop and file picker for the search box
.env.example            template; the real .env is git-ignored
assets/products.js      data layer: normalises any source into one schema
assets/catalog.js       demo product source, replaceable by a real feed
assets/interpret.js     sends the request to the endpoint; local fallback
assets/app.js           rendering and page behaviour
assets/styles.css       design tokens and all shared components
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

**3. Point the site at the function.** Already done — `find-clothes.html`
carries the tag:

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

1. **FindWear's own published site**, listed as `SITE_ORIGINS` in `api/_cors.js`.
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
- There is no rate limiting. This endpoint spends your OpenAI credit, so put your
  host's rate limiting or an auth check in front of it before making it public.

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

### OpenWeb Ninja (the provider FindWear runs on)

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

| FindWear | OpenWeb Ninja |
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

Records are shown in the order the source returned them, badged with the
retailer name. FindWear does not attach a match percentage to a provider
result: it did not score them, and displaying a made-up score would be
inventing information about a real product.

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
