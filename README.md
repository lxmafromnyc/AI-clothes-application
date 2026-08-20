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

### Deploying

GitHub Pages serves static files only and cannot run this function, so a
Pages-only deployment always falls back to local parsing. To get the AI path,
deploy somewhere with serverless support. The site is static, so any of these
work and all have a free tier:

**Vercel** — `api/interpret.js` is picked up as-is.

```sh
npx vercel
npx vercel env add OPENAI_API_KEY
```

**Netlify** — point `netlify.toml` at the file, or move it to
`netlify/functions/interpret.js` and export `handler`.

**Cloudflare Pages** — move it to `functions/api/interpret.js` and wrap the logic
in `export async function onRequestPost({ request, env })`, reading the key from
`env.OPENAI_API_KEY` rather than `process.env`.

#### Keeping the site on GitHub Pages

You can leave the pages on GitHub Pages and deploy only the function elsewhere.
Tell the frontend where it lives, either with a meta tag in `find-clothes.html`:

```html
<meta name="findwear-api" content="https://your-app.vercel.app/api/interpret">
```

or by setting `window.FINDWEAR_API` before `assets/interpret.js` loads. Then set
`ALLOWED_ORIGIN` on the function to your Pages origin, since the two are now
different origins.

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
