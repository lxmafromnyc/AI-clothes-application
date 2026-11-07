# Fynd — manual test in your own Chrome

A step-by-step check of the whole workflow on **real retailer pages**: save a
hoodie you own, open five product pages, let Fynd read each sizing chart, check
every value against the retailer's chart, compare sizes, and leave purchase
feedback. Record each retailer in the [results table](#results-table).

Nothing here has been run on a real retailer page before. Every automated test
so far used invented fixture pages. This test is what establishes real-world
behaviour, so record what actually happens, including failures.

Time: about 15 minutes to set up, then 10–15 minutes per retailer.

---

## 0. Before you start

**You need:**

- Chrome 116 or later on a computer (not a phone).
- Node.js 18 or later, and Git (only to run Fynd locally; no `npm install`).
- A hoodie or sweatshirt you own and like the fit of, a flat surface and a
  tape measure.

### 0.1 Get this branch's code on your computer

The purchase-feedback form and its server support exist only as
**uncommitted changes** in the cloud session that prepared this guide. Nothing
was pushed. Use **one** of these routes:

- **Route A: authorize a push.** Ask Claude to commit and push
  `claude/wonderful-darwin-m23i2b`, then:

  ```bash
  git clone https://github.com/lxmafromnyc/AI-clothes-application.git fynd-test
  ```

  ```bash
  cd fynd-test
  ```

  ```bash
  git checkout claude/wonderful-darwin-m23i2b
  ```

- **Route B: apply the patch file** (`fynd-uncommitted.patch`, provided with
  this guide) to `main`, without anything being pushed:

  ```bash
  git clone https://github.com/lxmafromnyc/AI-clothes-application.git fynd-test
  ```

  ```bash
  cd fynd-test
  ```

  ```bash
  git apply /path/to/fynd-uncommitted.patch
  ```

Without either route you can still test steps 1–6 with the code on `main`,
but the extension will show no purchase-feedback form.

### 0.2 Choose where Fynd's server runs

The extension talks to one Fynd server, set in `extension/config.js`.

| Mode | Server | Steps 1–6 | Step 7 (feedback) |
|---|---|---|---|
| **Local (recommended)** | Fynd's own handlers on your computer, with this branch's code | Yes | Yes |
| Live | `https://ai-clothes-application.vercel.app`, presumably running `main` | Yes | **No.** The live server doesn't yet accept feedback for products outside Fynd's records |

**Start the local server** from the `fynd-test` folder (the same command works
in Terminal, Command Prompt and PowerShell):

```bash
node -e "const http=require('http');const L=http.Server.prototype.listen;http.Server.prototype.listen=function(p,...a){return L.call(this,8787,...a)};require('./scripts/find-fit-demo-server.js')().then(s=>console.log('Fynd local on http://localhost:'+s.address().port))"
```

It prints `Fynd local on http://localhost:8787`. Leave it running.

- It keeps accounts, garments and feedback **in memory only**. Stopping it
  erases them, and you'd sign up and save your garment again.
- It has no product search and no AI. That's intended: the core workflow must
  work without them.
- It can't read retailer pages itself; only the extension can.

---

## 1. Load the unpacked extension

**Local mode:** make a separate copy of the extension, so the repository stays
unchanged:

1. Copy the `extension` folder somewhere outside `fynd-test`, e.g.
   `~/fynd-extension-local`.
2. In the copy, edit `config.js`. Change the `FYND_SITE` line to:

   ```js
   const FYND_SITE = 'http://localhost:8787';
   ```

3. In the copy, edit `manifest.json`. Add the local server to
   `host_permissions`:

   ```json
   "host_permissions": [
     "https://ai-clothes-application.vercel.app/*",
     "http://localhost/*"
   ],
   ```

(Live mode: skip the copy and use `fynd-test/extension` as it is.)

Then, in Chrome:

1. Go to `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and choose the folder from above.
3. Check the card: **Fynd — Fit panel**, version **0.5.0**, ID
   `jnjodlmanmolanoodeojaeajcjdhbjdd`. The ID must match: it's the only
   extension origin Fynd's server accepts.
4. Pin **Fynd** from the puzzle-piece menu.

If you edit any file in the folder later, click the reload icon on Fynd's
card.

---

## 2. Sign in and save your reference hoodie

1. In the same Chrome profile, open `http://localhost:8787/account.html`
   (live mode: `https://ai-clothes-application.vercel.app/account.html`) and
   create an account. Locally no email is sent; the unverified account works
   for this test.
2. Open `fit-profile.html` on the same server and go to the **Hoodies** card
   (or **Sweatshirts**, if your reference is a crewneck).
3. Answer **"Yes, I have the perfect fit"**, then fill in the brand, the size
   on its label and **Sized as**.
4. Open **Its product and measurements**, choose **cm** or **in**, and enter
   the four measurements. Measure the garment empty, laid flat on a table,
   smoothed but not stretched, with the hem and cuffs relaxed. Measure each
   twice:

   | Measurement | How to take it |
   |---|---|
   | Chest width | Flat, armpit seam to armpit seam, straight across (half the chest, not around) |
   | Body length | From the high point of the shoulder (where shoulder seam meets collar or hood) straight down to the hem |
   | Shoulder width | Shoulder seam to shoulder seam, across the back |
   | Sleeve length | From the shoulder seam to the end of the cuff |

   These are the methods your saved garment records. Fynd compares a
   retailer's measurement only when the retailer measures it the same way.
5. Click **Save profile**, reload the page and check every value came back
   unchanged.

**Pass:** the card shows your hoodie, with the brand, size and four values you
entered, after a reload.

---

## 3. The five retailer pages

The expectations below come from Fynd's own records of these products, copied
from the brands' pages in October 2026. Pages change, so treat them as
predictions to check, not facts.

| # | Product | Address | What Fynd's records predict |
|---|---|---|---|
| 1 | UNIQLO Sweat Pullover Hoodie (E475378) | `https://www.uniqlo.com/us/en/products/E475378-000/00` | Garment chart in the size guide's **Product Size** tab. Chest flat, length, shoulder seam to seam; sleeve from the **centre back**, so the sleeve won't be compared with your shoulder-to-cuff sleeve |
| 2 | Zara Basic Heavyweight Hoodie | `https://www.zara.com/us/en/basic-heavyweight-hoodie-p00761810.html` | Garment measurements published |
| 3 | Nike Club Pullover Fleece Hoodie (FN3859) | `https://www.nike.com/t/club-mens-pullover-fleece-hoodie-00eeWNwD` | **Body** chart only. The correct result is that Fynd refuses to compare it |
| 4 | Carhartt Loose Fit Midweight Hoodie (K121) | Search carhartt.com for "K121" | **Body** chart only (one chest value per size). Fynd should refuse |
| 5 | Your choice: a hoodie or sweatshirt from a shop you buy from | — | Unknown. A shop that publishes garment measurements in a table is the most useful test |

Pages 3 and 4 test that Fynd **refuses** what it can't compare reliably. A
refusal there is a success; a size recommendation would be a failure.

---

## 4. Activate Fynd and extract the chart

For each page:

1. Open the product page. Close any cookie banner, and pick a region or
   country if asked.
2. Many shops load the chart only when you open it, so open the page's **Size
   guide / Size chart** first, and the garment (product) measurements tab if
   there is one (UNIQLO: **Product Size**).
3. Click **Fynd** in the toolbar. The side panel opens and reads the page.
4. **Product:** check the name, brand and kind of garment (Hoodie or
   Sweatshirt), correct anything wrong, then click **This is the product**.
5. **Measurements:** Fynd lists the tables it found, each labelled
   *Garment measurements*, *Body measurements* or *Doesn't say*.
   - Choose the garment table, then **Use this chart**.
   - "No size chart found": open the size guide on the page, then **Read the
     page again**.
   - Only *Body measurements*: correct behaviour. Fynd can't compare a body
     chart with a garment. Record it and go to the results table.
   - Locally there's no AI, so a chart Fynd can't read on its own says the
     AI reading isn't available and keeps Fynd's own reading for you to
     correct. Record that as partial.

---

## 5. Check the extracted values against the retailer's chart

Put the panel's **Check the measurements** table beside the retailer's chart
(a screenshot of each helps) and check:

- [ ] **Every size** the retailer lists is there, in the same order, and none
      is invented.
- [ ] **Every value** matches the retailer's cell exactly. Count mismatches
      (wrong number, value in the wrong column, a size shifted by a row).
- [ ] **Unit:** cm or in as the retailer states. Fynd never guesses a unit; if
      the chart doesn't say, you choose.
- [ ] **What each column measures** (chest, length, shoulder, sleeve) is right.
- [ ] **How each is measured** (the dropdown beside each column) matches the
      retailer's wording:
  - "½ chest", "pit to pit", "chest width" → **Flat, armpit to armpit**
  - "chest circumference" → **All the way around**
  - "shoulder width", "seam to seam" → **Seam to seam**
  - "from the high point of the shoulder", "HPS" → **Top of the shoulder to
    hem**
  - "sleeve from shoulder" → **Shoulder seam to cuff**
  - "from centre back" → **Centre back of the neck to hem / to cuff**
  - no wording → **The chart doesn't say**, which Fynd will not compare
- [ ] Ranges ("56–58"), words or blanks are flagged, not silently used.
- [ ] Any confirmation box ("These are the garment's own measurements…",
      "I've checked these…") appears only when the chart leaves that unsaid.

Correct anything wrong in the panel. Fynd marks it as your correction. Then
tick the confirmations it asks for.

---

## 6. Compare the sizes with your saved garment

1. Click **Choose your garment**, pick your saved hoodie or sweatshirt, then
   **Compare every size**.
2. Record the result exactly as shown:
   - **OK:** the size that meets Fynd's comparison criteria.
   - **NO_MATCH:** no size meets them; the closest is shown, marked *not a
     recommendation*.
   - **INSUFFICIENT_DATA:** why, measurement by measurement. No size is shown.
3. Check the table: each size's difference from your garment (+ larger,
   − smaller), with *similar* where it's within tolerance.
4. Spot-check one size by hand: retailer value minus your garment's value, per
   measurement, after converting units if they differ (1 in = 2.54 cm). It
   should match Fynd's figure to 0.1.
5. Check that only measurements taken the same way were compared. UNIQLO's
   sleeve, measured from the centre back, should be listed as **not compared**.
6. Judge the result: from what you know of your hoodie and the brand, is the
   suggested size believable? Is the reliability (at most *medium* for a
   page-read chart) and what's said about uncertainty honest?

---

## 7. Submit purchase feedback

You likely haven't bought these items, so this checks that the flow works.
Mark it as a test in your notes.

1. Under the result, open **Bought it? Tell Fynd how it fit**.
2. Check the size list holds exactly the sizes just compared, with the
   recommended one first.
3. Choose a size and one or more of: **Just right**, **Too tight**, **Too
   loose**, **Too short**, **Too long**. "Just right" clears the others, and
   choosing a problem clears "Just right".
4. The first time, tick **Keep my fit feedback on my Fynd account**, then
   **Save how it fit**. Expect **"Saved: how size … fit. Thank you."**
5. Save again for the same size with a different answer. Expect **"Updated:
   …"**, not a second entry.
6. Check what was stored: in the same Chrome, open
   `http://localhost:8787/api/fit-profile?part=feedback`. Each entry should
   show:
   - the product's link (no `utm_` tracking);
   - the brand and name;
   - `category`, `sizeTried` and `issues`;
   - `reference`: a copy of your saved garment.

   Fynd's own pages don't list feedback for these products yet; this address
   is the way to see it.
7. Optional: sign out at `account.html`, return to the panel, and open the
   form again. It should say to sign in, and save nothing.

---

## Results table

**How to grade each retailer:**

- **Success:** either a garment chart read with every value, unit and method
  correct (or only trivially fixed) and a believable, honestly explained
  result; or a body-only chart correctly refused.
- **Partial:** it worked only after you opened something by hand,
  re-entered values, fixed more than one value, or set more than one method;
  or the result was INSUFFICIENT_DATA where a comparison seemed possible.
- **Failure:** no chart found where the retailer clearly publishes one, wrong
  values not flagged, a body chart used as a garment's, a size recommended
  from incompatible measurements, or a crash or error.

| # | Retailer · product | Chart found (garment / body / none) | Sizes & values correct (mismatches) | Unit & methods correct | Fixes you made | Result (OK size / NO_MATCH / INSUFFICIENT) | Believable? | Feedback saved & updated | Overall (Success / Partial / Failure) | Notes, with screenshot names |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | UNIQLO · Sweat Pullover Hoodie | | | | | | | | | |
| 2 | Zara · Basic Heavyweight Hoodie | | | | | | | | | |
| 3 | Nike · Club Pullover Fleece Hoodie | | | | | | | | | |
| 4 | Carhartt · K121 Midweight Hoodie | | | | | | | | | |
| 5 | | | | | | | | | | |

**Once for the whole session:**

| Check | Result |
|---|---|
| Extension loaded, version 0.5.0, ID `jnjodlmanmolanoodeojaeajcjdhbjdd` | |
| Reference hoodie saved and still there after a reload | |
| Mode used (local / live) | |
| Chrome version, operating system | |
| Date tested | |

---

## If something goes wrong

- **The panel says "Sign in to Fynd":** sign in at the server's
  `account.html` in the same Chrome profile, then **Try again**. In local mode
  the extension copy must point at `http://localhost:8787` (step 1).
- **Nothing happens on clicking Fynd:** at `chrome://extensions`, open
  **Errors** on Fynd's card; reload the extension and the product page.
- **"Fynd couldn't be reached":** check the local server is still running.
- **You restarted the local server:** accounts, garments and feedback are
  gone. Sign up and save the garment again.
- **The page loads its chart in a pop-up or iframe and Fynd finds nothing:**
  record it as a failure for that retailer, with a screenshot. That's exactly
  what this test is meant to find.

When you're done, stop the server with Ctrl+C. To remove the test extension,
click **Remove** on its card.
