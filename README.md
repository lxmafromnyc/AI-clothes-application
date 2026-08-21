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
api/providers/etsy.js   Etsy Open API v3 adapter
assets/search.js        sends interpreted intent to /api/search
scripts/verify-api.sh   checks a deployed endpoint end to end
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
| `ALLOWED_ORIGIN` | no | Only set this if the frontend is on a different origin than the function, e.g. pages on GitHub Pages and the function on Vercel. Left unset, no CORS header is sent and the endpoint is same-origin only. |

Set the key as a secret in your host's dashboard or CLI (`npx vercel env add
OPENAI_API_KEY`). Never put it in a file you commit, and never move the OpenAI
call into the frontend — a key in client JavaScript is a key anyone can read.

### How a request flows

```
"a black oversized hoodie under $80"
        |
        v
  POST /api/interpret          browser sends the request plus the
        |                      vocabulary the catalogue can match
        v
  OpenAI chat completions      key lives here, server-side only
        |
        v
  { categories: ["knit"], colors: ["Black"],
    fits: ["Oversized"], maxPrice: 80, ... }
        |
        v
  matched against the catalogue, ranked, rendered
```

If any step fails, the frontend reads the request locally instead and shows a
notice saying so, naming the reason: no interpreter connected, deployed without
a key, unreachable, or an unusable reply.

### Worth knowing

- The endpoint caps requests at 400 characters and asks the model for JSON only,
  then re-validates every field before returning it — a malformed or hostile
  reply cannot reach the matching code.
- Upstream errors are logged server-side but never echoed to the browser, since
  they can quote the request.
- There is no rate limiting. This endpoint spends your OpenAI credit, so put your
  host's rate limiting or an auth check in front of it before making it public.

## Product search

`/api/search` takes the structured intent from `/api/interpret` and asks the
configured product source for real listings. No provider is hard-coded: the
registry in `api/providers/product-source.js` ships with only a `none`
placeholder, so the endpoint answers 503 and the interface says plainly that no
product source is connected.

### Etsy (implemented)

Set these in the server environment to switch the site onto live Etsy listings:

| Variable | Required | Purpose |
| --- | --- | --- |
| `PRODUCT_SOURCE` | yes | Set to `etsy` |
| `ETSY_API_KEY` | yes | The app keystring, sent as the `x-api-key` header |
| `ETSY_SHARED_SECRET` | no | **Not used.** It exists for the OAuth 2.0 authorization-code flow, which only user-scoped endpoints need. Searching public listings needs no user context, so this adapter never reads or transmits it. |

The adapter calls `GET /v3/application/listings/active` with
`includes=Images,Shop`, which nests each listing's own images and shop inside
that listing. That association is what guarantees the photo belongs to the
product shown — it is not matched up after the fact. Mapping:

| FindWear | Etsy Open API v3 |
| --- | --- |
| `title` | `ShopListing.title`, unmodified |
| `productUrl` | `ShopListing.url` — "the full URL to the listing's page on Etsy" |
| `price` | `Money.amount / Money.divisor` |
| `imageUrl` | `ListingImage.url_570xN` from that listing's own `images` |
| `brand` | `Shop.shop_name`, the maker |
| `retailer` | Etsy, where the page lives |
| availability | `state === 'active'` and `quantity > 0` |

A listing whose `images` association is absent or empty gets **no** image — none
is substituted from another listing — and the gate then drops the record.

### Verifying the product source in production

Once `PRODUCT_SOURCE` and the provider's credentials are set and the deployment
has been rebuilt, check the endpoint directly:

```sh
curl -s -X POST https://ai-clothes-application.vercel.app/api/search \
  -H 'Content-Type: application/json' \
  --data '{"intent":{"categories":["knit"],"colors":["Black"],"maxPrice":80,"keywords":["hoodie"]},"limit":6}'
```

What the reply tells you:

| Response | Meaning |
| --- | --- |
| `"source":"etsy"` with a populated `products` array | Live. Each entry carries a real title, brand, price, image URL and listing URL. |
| `"source":"etsy"`, `products` empty, `rejected` populated | The source answered but nothing passed the gate. `rejected` names the missing field for each dropped record. |
| `503` `"No product source is configured."` | `PRODUCT_SOURCE` is unset, or names a provider whose credentials are missing. Environment variables only apply to deployments built after they were added, so a redeploy is usually what is missing. |
| `502` | The provider was reached but failed. The reason is in the function logs, never in the response. |

Environment variables take effect on the next build, not on the running
deployment, so any change to them needs a redeploy before it is visible.

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

Every record must arrive from the source with all six of:

```
title   brand   price   imageUrl   productUrl   retailer
```

A record missing any one is dropped, never filled in. `productUrl` must also
address a specific product page — a bare origin, or a path reading as a search
or category listing, is rejected, because a homepage link is not the product
the card claims to show. Out-of-stock records are dropped; a source that says
nothing about stock is not assumed to be out of stock. The response reports how
many records were rejected and why, so a badly behaved provider is visible
rather than silently thinning the results.

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
