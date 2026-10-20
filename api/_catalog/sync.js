/* =========================================================
   Fynd — one catalogue sync: the last good catalogue, plus a new feed

   Given the catalogue as it stands (or none) and a feed read by
   ./import.js, this works out the next catalogue — or refuses, and the
   catalogue as it stands is kept unchanged. Pure: no file, clock or
   network is touched here (scripts/sync-catalog.js does that).

   What changes:
     added / updated   every product the feed lists, keyed by its exact
                       ID, so a product is never listed twice
     removed           a product the feed marks discontinued; one a
                       COMPLETE feed no longer lists; and one a partial
                       feed hasn't mentioned in UNSEEN_DAYS — each with
                       its reason, kept in `removed` for the record and
                       never served
     lastSuccessfulSync   set only when the sync succeeds

   What refuses the whole sync (nothing is written):
     a feed with no products at all
     more than MAX_REJECT_RATIO of its rows rejected — usually a format
       change, which would otherwise quietly empty the catalogue
     a complete feed that would remove more than MAX_REMOVAL_RATIO of
       the catalogue — usually a truncated download (--allow-mass-removal
       when it is real)
     a feed generated before the one already imported (a replay)
     a fixture feed, unless the caller says fixtures are allowed
   ========================================================= */

'use strict';

const DEFAULTS = { maxRejectRatio: 0.1, maxRemovalRatio: 0.5, massRemovalFloor: 20, unseenDays: 30, removedKept: 500 };
const VOLATILE = ['price', 'availability', 'sizeAvailability', 'variants'];
const FIELD_OF = { images: ['images'], colours: ['colours'], sizes: ['sizes'], price: ['price'], stock: ['availability', 'sizeAvailability', 'variants'] };

const DAY = 24 * 60 * 60 * 1000;

/* a product carrying only the fields the current licence covers */
function within(product, licensed) {
  const out = Object.assign({}, product);
  Object.entries(FIELD_OF).forEach(([field, keys]) => { if (!licensed.includes(field)) keys.forEach((k) => delete out[k]); });
  if (!licensed.includes('images') && Array.isArray(out.colours)) out.colours = out.colours.map((c) => Object.assign({}, c, { image: null }));
  return out;
}

const sameFacts = (a, b) => JSON.stringify(Object.assign({}, a, { firstSeenAt: 0, lastSeenAt: 0 })) === JSON.stringify(Object.assign({}, b, { firstSeenAt: 0, lastSeenAt: 0 }));

function sync(previous, imported, adapter, options) {
  const opts = Object.assign({}, DEFAULTS, options || {});
  const now = new Date(opts.now || Date.now()).toISOString();
  const { header, products, discontinued, rejected, duplicates, notes } = imported;
  const refuse = (reason, message) => ({ ok: false, reason, error: message, report: summary() });
  const prev = previous && Array.isArray(previous.products) ? previous : null;

  const counts = { added: 0, updated: 0, unchanged: 0, removed: {} };
  function summary() {
    return {
      source: adapter.id,
      feedFormat: header.format,
      feedGeneratedAt: header.generatedAt,
      complete: header.complete,
      licensed: header.licensed,
      read: products.length,
      discontinued: discontinued.length,
      rejected: rejected.length,
      rejectedRows: rejected.slice(0, 50),
      duplicates: [...new Set(duplicates)].slice(0, 50),
      duplicateCount: duplicates.length,
      notes: notes.slice(0, 50),
      noteCount: notes.length,
      added: counts.added,
      updated: counts.updated,
      unchanged: counts.unchanged,
      removed: counts.removed
    };
  }

  if (header.fixture && !opts.allowFixture) return refuse('fixture', 'This feed is marked as a fixture: it is test data, never a customer-facing catalogue.');
  if (!products.length && !discontinued.length) return refuse('empty', 'The feed has no valid products, so the catalogue was kept as it was.');
  /* rows, not products: a product-feed file has one row per variant */
  const considered = header.rows || products.length + rejected.length;
  if (considered && rejected.length / considered > opts.maxRejectRatio) {
    return refuse('too-many-rejected', `${rejected.length} of ${considered} rows were rejected (more than ${Math.round(opts.maxRejectRatio * 100)}%) — has the feed’s format changed? The catalogue was kept as it was.`);
  }
  if (prev && prev.feedGeneratedAt && header.generatedAt && Date.parse(header.generatedAt) < Date.parse(prev.feedGeneratedAt)) {
    return refuse('older-feed', `This feed was generated at ${header.generatedAt}, before the one already imported (${prev.feedGeneratedAt}).`);
  }

  const before = new Map((prev ? prev.products : []).map((p) => [p.code, p]));
  const next = new Map();
  const removed = [];
  const remove = (p, reason) => {
    removed.push({ code: p.code, name: p.name, reason, removedAt: now });
    counts.removed[reason] = (counts.removed[reason] || 0) + 1;
  };

  products.forEach((p) => {
    const old = before.get(p.code);
    const kept = Object.assign({}, p, { firstSeenAt: old ? old.firstSeenAt || now : now, lastSeenAt: now });
    if (!old) counts.added += 1;
    else if (sameFacts(within(old, header.licensed), kept)) counts.unchanged += 1;
    else counts.updated += 1;
    next.set(p.code, kept);
  });
  const gone = new Set(discontinued);
  before.forEach((old, code) => {
    if (next.has(code)) return;
    if (gone.has(code)) return remove(old, 'discontinued');
    if (header.complete) return remove(old, 'absent-from-complete-feed');
    if (!old.lastSeenAt || Date.parse(now) - Date.parse(old.lastSeenAt) > opts.unseenDays * DAY) return remove(old, `not-seen-in-${opts.unseenDays}-days`);
    /* kept from the last sync: only what the licence still covers, and
       never last time's price or stock as if it were this sync's */
    const carried = within(old, header.licensed);
    VOLATILE.forEach((k) => delete carried[k]);
    next.set(code, carried);
  });

  const lost = (counts.removed['absent-from-complete-feed'] || 0);
  if (header.complete && before.size >= opts.massRemovalFloor && lost / before.size > opts.maxRemovalRatio && !opts.allowMassRemoval) {
    return refuse('mass-removal', `This complete feed would remove ${lost} of ${before.size} products — more than ${Math.round(opts.maxRemovalRatio * 100)}%. Is the download truncated? Run again with --allow-mass-removal if it is real.`);
  }

  const catalog = {
    format: 'fynd-catalog',
    version: 1,
    about: 'Written by scripts/sync-catalog.js from an authorized feed, validated as it was read. Edit the feed, not this file.',
    source: adapter.id,
    brand: adapter.brand,
    market: adapter.market,
    sourceName: header.sourceName || opts.sourceName || null,
    sourceKind: opts.sourceKind || 'file',
    licence: header.licence || opts.licence || null,
    licensed: header.licensed,
    fixture: Boolean(header.fixture),
    feedFormat: header.format,
    feedGeneratedAt: header.generatedAt,
    feedComplete: header.complete,
    lastSuccessfulSync: now,
    products: [...next.values()].sort((a, b) => a.code.localeCompare(b.code)),
    removed: removed.concat((prev && Array.isArray(prev.removed) ? prev.removed : []).filter((r) => !next.has(r.code))).slice(0, opts.removedKept)
  };
  return { ok: true, catalog, report: Object.assign(summary(), { total: catalog.products.length, lastSuccessfulSync: now }) };
}

module.exports = { sync, within, DEFAULTS };
