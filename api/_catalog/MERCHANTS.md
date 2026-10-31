# Merchant-supplied catalogues

A participating merchant can give Fynd its own products directly, as an
authorized CSV or JSON export. Fynd checks every row, writes a catalogue
snapshot and a report, and a person reviews both before anything is
committed. No feed provider, paid catalogue or website reading is
involved. A merchant's file is the only source of its products.

## What is reused

| Component | Role for a merchant |
| --- | --- |
| `import.js` | Reads the export: one row per variant (CSV, TSV, JSON array or JSON Lines), or the structured Fynd catalogue feed. Rows are grouped by `item_group_id`. |
| `product.js` | Checks every product: its code, name, URL, image hosts and line, and drops any field the authorization doesn't cover. |
| `sync.js` | Merges the export with the last snapshot. It refuses a malformed, truncated or mass-removing export, and any fixture. |
| `store.js` | Re-checks the committed snapshot when it loads. It refuses a fixture at the customer-facing path. |
| `search.js` | Search, filters (category, line, brand, colour, size, in stock), sorting and pages. |
| `scripts/sync-catalog.js` | The CLI, with `--merchant`. |

The new parts are small:

- **`sources/merchant.js`:** builds a source from a merchant's config instead of code.
- **`merchants/index.js`:** the registry of listed merchants.
- **`api/_sizing/brands/merchant.js`:** serves a merchant's snapshot to Find Fit.

## The merchant config: `api/_catalog/merchants/<id>.json`

One reviewed file per merchant. `validateConfig` names every problem with it.

```json
{
  "format": "fynd-merchant",
  "version": 1,
  "id": "example-outfitters",
  "name": "Example Outfitters",
  "market": "US",
  "currency": "USD",
  "brands": ["Example Outfitters"],
  "productPages": { "hosts": ["www.example-outfitters.com"], "codeInPath": true },
  "imageHosts": ["images.example-outfitters.com"],
  "categories": { "Fleece": "sweatshirts-hoodies" },
  "authorization": {
    "grantedBy": "Name, role, at the merchant",
    "reference": "The agreement or written permission",
    "grantedAt": "2026-11-01",
    "expiresAt": null,
    "licensedFields": ["images", "colours", "sizes", "stock"]
  }
}
```

- **`id`:** lower-case words joined by hyphens, 2–30 characters. It's both the snapshot's file name and the brand id Find Fit browses.
- **`brands`:** every brand the merchant may list. A retailer may list several. Each product names one of them, or may name none when there's only one.
- **`productPages.hosts`, `imageHosts`:** the https hosts the merchant's product pages and photos live on.
  - A page on any other host rejects its product.
  - A photo on any other host is dropped (the product stays).
  - With `codeInPath`, a page whose path doesn't carry the product code rejects its product.
- **`categories`:** optional. Maps the merchant's own category words to a Fynd category, checked before the general rules. Anything unmatched is filed under "other".
- **`authorization`:** who granted the data, under what agreement, and from when to when. Nothing is imported or served outside those dates.
  - `licensedFields` is everything beyond the core fields (code, name, URL, category, line).
  - Price and stock are kept only when licensed, and shown only for 48 hours after an import.
  - `--licensed` can narrow this list, never widen it.
- **`fixture: true`:** only for a test merchant. See [Test data never reaches customers](#test-data-never-reaches-customers).

## The export

### One row per variant (CSV, TSV, JSON array or JSON Lines)

A header row is required. `id`, `title` and `link` are required columns.

| Column | Meaning |
| --- | --- |
| `merchant` | optional; when given, must be the config's `id` |
| `brand` | one of the config's `brands` (may be empty when there is only one) |
| `id` | the variant's own ID (SKU), unique in the file |
| `item_group_id` | the product code: capital letters, digits and hyphens, 3–31 characters (`NW-HD-1001`) |
| `title` | the product name: plain text, ≤ 160 characters |
| `description` | optional, plain text, ≤ 2,000 characters (licensed: `description`) |
| `link` | the product page, https on a product-page host |
| `image_link`, `additional_image_link` | photos on an image host; the second may list several, comma-separated (licensed: `images`) |
| `product_type` | the merchant's category path, e.g. `Men > Tops > Hoodies` |
| `gender`, `age_group` | the sizing line: men, women, unisex, kids or baby |
| `color`, `color_code` | the colour's name and short code (licensed: `colours`) |
| `size` | the size label as sold: a label, never a measurement (licensed: `sizes`) |
| `price`, `sale_price` | `68.00 USD` (licensed: `price`) |
| `availability` | `in stock`, `limited`, `out of stock`, `preorder` (licensed: `stock`) |

### Structured JSON

The Fynd catalogue feed (`format: "fynd-catalog-feed"`, `version: 1`) has one entry per product. Its colours, sizes and variants are given inside the entry. `source.merchant`, when given, must be the config's `id`. `complete: true` says the file lists every live product.

The fixtures in `scripts/fixtures/merchant/` are worked examples of both formats.

## What is refused, and how it's reported

- **Refused row by row, each with its reason:**
  - a row for another merchant
  - a product code not in the format
  - a second row with the same SKU
  - the same colour and size twice for one product
  - another brand for a product already seen
- **Refused product by product, naming the file rows it came from:**
  - a page off-host, or without its code
  - a name with markup
  - no sizing line
  - a brand the merchant may not list
  - a product listed twice in the structured JSON
- **Dropped with a note, keeping the product:**
  - an off-host photo
  - an unreadable price or sale price
  - any field the authorization doesn't cover
- **Refusing the whole import, so the last snapshot is kept:**
  - more than 10% of rows rejected
  - a complete export that would remove more than half the catalogue
  - an older export than the one already imported
  - an authorization that doesn't cover today

## Sizing is separate from listing

A merchant's product is listed whether or not Fynd can size it. Sizing comes only from Fynd's sizing records, matched by brand, market and exact product code, and every size answer comes from the server's decision policy (`api/_sizing/decision.js`).

A size label is never treated as a measurement. A product with no record shows "No saved chart". Its sizing decision is `INSUFFICIENT_DATA` with reason `no-record`.

## The workflow (MVP, by hand)

1. **The merchant supplies an authorized export**, and the written permission it rests on.

2. **Write `api/_catalog/merchants/<id>.json`**, with the authorization as granted.

3. **Import it.** First check without writing anything:

   ```
   node scripts/sync-catalog.js --merchant api/_catalog/merchants/<id>.json \
     --file <export.csv> --complete --dry-run --report <id>-report.json
   ```

   Then write the snapshot: drop `--dry-run`. This writes `api/_catalog/data/<id>.json` and `<id>.status.json`.

4. **Review the report and the snapshot's diff.** Check:
   - rejected rows and their reasons
   - the notes
   - coverage by category and line
   - a few products against the merchant's own pages

5. **List the merchant** in `api/_catalog/merchants/index.js` `COMMITTED`:

   ```js
   { config: require('./<id>.json'), committed: () => require('../data/<id>.json') }
   ```

   Then commit all three files in one reviewed pull request.

6. **Each refresh** repeats steps 3–4, with its own pull request.

## Test data never reaches customers

- **A test merchant is marked `"fixture": true`.** Its import is test data whatever the file says, and:
  - The CLI refuses to write its catalogue or status anywhere in `api/_catalog/data/`.
  - The registry refuses a fixture in `COMMITTED`.
  - The registry loads test merchants only from `FYND_TEST_MERCHANTS`, and ignores that variable in a deployment (`VERCEL` set, or `NODE_ENV=production`).
  - `store.js` refuses a fixture snapshot at the customer-facing path.
- **The fixtures themselves are clearly fake.** Their merchant and brand names start with "FIXTURE", and every host is on the reserved `.example` domain, which can never be a real site.
- **The test suite checks all of this** (`scripts/test-merchant-catalog.js`), and that no file in `api/` carries fixture data.
