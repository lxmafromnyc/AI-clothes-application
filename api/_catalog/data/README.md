# api/_catalog/data

The validated catalogues Find Fit serves, one file per source, written by
`scripts/sync-catalog.js` from an authorized feed and committed by a person
after reading the sync report and the diff.

| File | What it is |
| --- | --- |
| `uniqlo-us.json` | UNIQLO US, from the authorized feed (`api/_catalog/sources/uniqlo-us.js`) — built for UNIQLO USA's Rakuten Advertising Product Catalog. **Not present**: no feed has been authorized yet, so Find Fit lists only the products Fynd sourced itself and says its coverage is limited. Once it is, the sync workflow proposes each refresh as a pull request. |
| `uniqlo-us.status.json` | The last sync attempt: when, whether it succeeded, why not, and the last successful sync. Written by every non-dry-run sync. |

Never put test data here. A catalogue marked `"fixture": true` is refused by
`api/_catalog/store.js` at this path, and the sync refuses to write one here.
Tests point at their own files with `FYND_CATALOG_UNIQLO_US`.

Don't edit a catalogue by hand: every product is checked again when it loads,
and one that breaks a rule is left out. Change the feed and sync again.
