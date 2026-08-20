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
