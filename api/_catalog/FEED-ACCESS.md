# UNIQLO US catalogue feed: access status

Checked on 30 October 2026, from this repository, this session's
environment, the repository's GitHub Actions run history, and Rakuten
Advertising's public publisher documentation. Nobody signed in to a Rakuten
publisher account for this check. Repository secrets and variables can't be
listed from here either. Everything marked **UNKNOWN** or **unverified** can
only be settled from authoritative account information (the Rakuten publisher
dashboard, Fynd's records of any agreement) or from Rakuten support.

## Summary

**Whether Fynd can get an authorized UNIQLO US feed is UNKNOWN.** The places
inspected hold no evidence of a Rakuten publisher account, a UNIQLO USA
partnership, Product Catalog approval, or the credentials a sync would need.
That is absence of evidence here, **not proof that no partnership or approval
exists**: an account, an approval or repository secrets could exist outside
what was inspected. Synchronization can't begin until the items in
[What has to happen](#what-has-to-happen-before-a-sync) are confirmed or
granted.

| Question | Answer | Evidence |
| --- | --- | --- |
| Does Fynd have an active Rakuten partnership with UNIQLO USA? | **UNKNOWN.** No evidence found in what was inspected | No MID, SID or SFTP account is recorded in the repository's files or in this session's environment. Repository secrets and variables couldn't be inspected. |
| Has Product Catalog access been approved? | **UNKNOWN.** No evidence found in what was inspected | No catalogue (`data/uniqlo-us.json`) or sync status file has ever been committed. `UNIQLO catalogue sync` has 9 runs (21–29 Oct 2026), all scheduled and all skipped by the `UNIQLO_FEED_SCHEDULE` gate, with none started by hand. That establishes only that **the workflow has not executed**. It says nothing about whether an account, an approval or credentials exist. |
| Does UNIQLO USA provide a Product Catalog to publishers? | **UNKNOWN** | Third-party directories list a "UNIQLO USA" programme on Rakuten as open. Rakuten's docs say a catalogue is offered *per advertiser*: only advertisers that upload one have one. No public or authoritative source seen says whether UNIQLO USA uploads one. |
| UNIQLO USA's advertiser ID (MID) | **UNKNOWN.** Not published | Shown on the programme's page in the publisher dashboard. |
| Fynd's publisher channel ID (SID) | **UNKNOWN.** None recorded in what was inspected | Rakuten issues it with a publisher account. |

## How Rakuten delivers a Product Catalog (public documentation)

These points come from Rakuten's publisher help centre: *Product Catalog
Overview*, *Download Product Catalog Data Feed Files*, *Product Catalog Data
Feed Implementation Guidelines* and Appendices A–D. Rakuten's help site
(`pubhelp.rakutenadvertising.com`) can't be reached from this session's
network, so the pages couldn't be reread today. The repo's reader
(`rakuten.js`) was written to the December 2023 edition of the guidelines.

- **Approval is two-level.** The publisher first asks Rakuten for the
  catalogue technical set-up (an SFTP account). Then the publisher applies to
  each advertiser that offers a Product Catalog, and that advertiser approves
  it. Catalogue access can be requested when applying to the advertiser's
  programme.
- **SFTP**
  - **Host:** `aftp.linksynergy.com`, as recorded in
    `sources/uniqlo-us.js` (`RAKUTEN.host`).
  - **Login:** with the credentials Rakuten issues for the set-up.
  - **Transfer:** binary mode, since the files are gzipped. ASCII mode
    corrupts them.
  - **Connections:** no more than 5 at once.
  - **Layout:** Rakuten describes the main product catalogue files
    (`MID_SID_mp…`) in the SFTP root, and per-advertiser folders holding
    the category list and category-specific files. The actual layout of
    Fynd's account hasn't been seen.
  - **Host key:** comes from Rakuten (welcome email or support) and is
    never trusted on first use (`RAKUTEN_SFTP_HOSTKEY_SHA256`).
- **Files and formats**
  - **Full file:** `MID_SID_mp.txt.gz`, pipe-delimited, holding the
    advertiser's whole live catalogue.
  - **XML version:** `MID_SID_mp.xml.gz`, defined by Appendix C (XML
    Schema / DTD).
  - **Delta file:** `MID_SID_mp_delta.txt.gz` (or `.xml.gz`), holding only
    new and changed products since the last upload. It adds a Modification
    field (`I` / `U` / `D`).
  - **Category files** ("Product Catalog by Category"): a Product Category
    List file, plus Category-Specific Product Catalog files for chosen
    advertiser categories. They aren't available for additional feeds. Their
    exact file names weren't confirmed from public sources.
  - **Refresh:** typically daily. The actual schedule is the advertiser's.
- **Fields** (Appendix A; `*` = required by Rakuten)
  - **Record structure:** `HDR|MID|advertiser name|timestamp`, then one line
    per product record (38 fields; 39 in a delta file), then
    `TRL|record count`.
  - **What the reader takes, by position:**
    - **Name and IDs:** 2 Product Name\*, 3 SKU Number\*
    - **Categories:** 4 Primary Category\*, 5 Secondary Category (`~~`-separated)
    - **Links and images:** 6 Product URL\* (Rakuten's tracking link, with
      the advertiser's page in `murl`), 7 Product Image URL\*
    - **Descriptions:** 9 Short and 10 Long Description
    - **Prices and dates:** 13 Sale Price, 14 Retail Price, 16 End Date,
      26 Currency
    - **Brand and stock:** 17 Brand, 23 Availability
    - **Class:** 25 Class ID
    - **Clothing attributes (Class 60, Appendix B):** 30 Product Type,
      31 Size, 32 Material, 33 Color, 34 Gender, 35 Style, 36 Age
  - **There is no parent/variant group field.** Each line is one SKU. Fynd
    groups lines into products by the UNIQLO product code in the page URL
    (`E\d{6}-\d{3}`).

## What only a real UNIQLO file can answer

These shape the sync and are **unverified** until one is delivered:

- **Whether UNIQLO USA uploads a catalogue at all**, and whether it covers
  the full US range.
- **SKU granularity:** whether field 3 is per variant (colour × size) or per
  product, and its format.
- **Product URLs:** whether the `murl` in field 6 is UNIQLO's canonical
  `https://www.uniqlo.com/us/en/products/<code>/…` page. If it isn't, the
  adapter rejects every row (the sync refuses a feed with >10% rejected
  rows).
- **Images:** whether field 7 is on `image.uniqlo.com`. The adapter drops a
  photo from any other host.
- **Clothing attributes:** whether UNIQLO fills the Class 60 fields (size,
  colour, gender, age). If it doesn't, sizes and colours are absent and
  categories rely on fields 4–5 only.
- **Category paths:** the category words UNIQLO uses, which `CATEGORY_RULES`
  maps.
- **Delta and category files:** whether UNIQLO's programme offers them.
- **Licence terms:** which fields may be shown and cached, and for how long.

## Open points in the current sync, to confirm once the server can be seen

- **Download path: unverified, not known to be wrong.** The workflow
  downloads `sftp://<host>/MID_SID_mp.txt.gz` from the SFTP root. That
  matches Rakuten's description of where main product files sit (the
  advertiser folders hold category files). It still has to be confirmed
  against the real directory listing before the first run. If the file isn't
  there, the step fails plainly (curl `--fail`) rather than syncing anything
  wrong.
- **Files fetched:** only the full file is downloaded. The reader already
  handles delta files, but the workflow doesn't fetch them, and category
  files aren't read. A daily full file is enough to start; delta and
  category files are optional and shouldn't be wired until UNIQLO is known
  to offer them.

No sync code was changed for either. The catalogue and sizing architecture
(`import.js`, `sync.js`, `store.js`, `search.js`, the sizing records and
engine) needs no change to accept a real file.

## What has to happen before a sync

Each step starts by checking whether it is already done. The account holder
checks the dashboard or Fynd's records, or asks Rakuten support.

1. **Rakuten publisher account** for Fynd, with its site ID (SID): confirm
   one exists, or open one.
2. **UNIQLO USA programme:** confirm Fynd is approved, or apply.
3. **Confirm UNIQLO offers a Product Catalog** (programme page, or ask
   Rakuten / UNIQLO's programme manager). If it doesn't, there is no Rakuten
   feed. The alternatives are in the README's *Where an authorized feed
   could come from*.
4. **Product Catalog technical set-up** (SFTP account) and **UNIQLO's
   catalogue approval:** confirm both, or request them. Record UNIQLO USA's
   MID from the dashboard.
5. **Record the agreement:** the feed, the licensed fields, and display,
   caching and refresh terms.
6. **Set in the repository settings, never in code** (or confirm they're
   already there):
   - **Secrets:** `RAKUTEN_SFTP_USER`, `RAKUTEN_SFTP_PASSWORD`
   - **Variables:** `RAKUTEN_UNIQLO_MID`, `RAKUTEN_SID`,
     `RAKUTEN_SFTP_HOSTKEY_SHA256`, `UNIQLO_FEED_LICENSED_FIELDS`
7. **Check the server and the file** before relying on the workflow, using
   the dashboard or a one-off SFTP listing run by the account holder:
   - the root directory listing and the download path (see above)
   - the file names offered
   - the header's MID
   - a sample of lines against UNIQLO's pages
8. **Run `UNIQLO catalogue sync` by hand,** read the report and coverage,
   and commit the catalogue in a reviewed pull request. Only then consider
   `UNIQLO_FEED_SCHEDULE` and `UNIQLO_FEED_AUTOPR`.

Until step 8, Find Fit lists the 5 products Fynd sourced itself, and says
so. UNIQLO's catalogue availability and Fynd's approval status stay
**UNKNOWN** in this document until confirmed from authoritative account
information or Rakuten support.
