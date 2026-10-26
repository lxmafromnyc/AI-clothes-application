/* =========================================================
   Fynd — what a saved fit profile can say about a chart

   Shared by Find Fit (assets/find-fit.js) and the product page's Size
   Guide (assets/product-page.js). Only a chart Fynd has checked
   finished-garment measurements for is set beside the shopper's saved
   reference garment (Account.sizing.compare: the engine's own
   comparison, read from their own profile on the server — nothing from
   the profile travels in any address). Any other chart says why it
   can't be compared; a body chart never is.

     FitCompare.show(chart, container, stillCurrent?)   (a promise)
     FitCompare.focus(container, size)

   A comparison the engine can stand behind (status "ok") is drawn
   compactly: the size it recommends, the reference it was set beside
   (brand and the size on its label), how that size differs in plain
   words, and — folded away — each compared dimension's signed
   difference (this size minus the reference: "−1.0 in chest width" is
   an inch narrower), and each measurement it still misses (the
   engine's tradeoffs). When the closest size misses every compared
   measurement's tolerance (withheld "outside-tolerance"), it is shown
   as the closest size — "not a recommendation" — with why, and the
   same differences. Every figure is the engine's own. Anything less (a
   partial comparison on too little, or none) recommends nothing and
   says there isn't enough reliable measurement evidence, then the
   engine's reason.

   Find Fit asks for its verdict layout (show(chart, container,
   stillCurrent, { verdict: true })): the same engine answer, led by
   what the shopper came for — the size, or a heading that says there
   is none and why — with a fit scale per compared measurement (tighter,
   similar or roomier; shorter, similar or longer), placed from the
   engine's own answer for each difference, the sources (each side's
   recorded origin and check, never assumed from the brand), and every
   caveat. The container says which it drew (data-verdict):

     recommended       an "ok" answer: the size, any trade-off it has
     closest-mismatch  partial, withheld "outside-tolerance": the
                       closest size, never called a recommendation
     no-recommendation partial on too little evidence
     unsupported       no checked garment measurements: a chart not
                       checked, or the engine's no-record /
                       unverified-data / crowdsourced-data /
                       category-not-covered
     body-only         only body measurements (body-chart-only)
     methods           a table that doesn't say what it measures, or
                       nothing measured the same way (nothing-comparable),
                       each measurement with the engine's reason
     needs-reference   nothing saved to compare with
     sign-in, error    signed out; an answer missing or malformed, which
                       draws no size and no figure

   Each offers only the action that can change it: the fit profile for
   methods and needs-reference, Compare for a size, nothing otherwise.
   Every word from the engine or a record is set as text. The product
   page's Size Guide keeps the layout below, with the same reasons.

   focus() adds, to a comparison already drawn, how one size differs
   from the reference, measurement by measurement — the engine's own
   figures for that size, nothing worked out here — and redraws only
   that when the size changes, without asking again. The product page's
   Size Guide uses it for the size being considered.
   ========================================================= */

(function (global) {
  'use strict';

  const doc = global.document;
  if (!doc || !global.SizeChart) return;
  const { el } = global.SizeChart;
  /* what each container last drew, so a new size redraws only its part */
  const drawn = new WeakMap();

  /* Why a chart the server called not comparable can't be set beside a
     garment, from what the chart itself says (chart.charts[].measures,
     chart.verification — api/_sizing/chart.js):
       body-only     every table describes bodies, not garments
       methods       its tables don't say whether they measure the body
                     or the garment, so how each was taken is unknown
       unsupported   anything else: no checked garment measurements
                     (a Fynd record not yet checked, or a table read from
                     a page or the shopper's browser, which nobody has) */
  function chartState(chart) {
    const kinds = (Array.isArray(chart && chart.charts) ? chart.charts : []).map((c) => c && c.measures);
    if (kinds.length && kinds.every((k) => k === 'body')) return 'body-only';
    if (!kinds.includes('finished-garment') && kinds.includes('not-stated')) return 'methods';
    return 'unsupported';
  }
  function whyNot(chart, verdict) {
    const state = chartState(chart);
    if (state === 'body-only') return verdict ? [BODY_ONLY_REST] : [BODY_ONLY_LEAD, BODY_ONLY_REST];
    if (state === 'methods') {
      return ['The page doesn’t say whether these measure the body or the garment, or how each was taken, so Fynd can’t set them beside a garment you own.']
        .concat(verdict ? ['What would change that: the brand saying what each measurement is and how it’s taken.'] : []);
    }
    if (chart && chart.verification === 'unverified') {
      return ['These measurements haven’t been checked against the brand yet, so Fynd won’t compare them with a garment you own.']
        .concat(verdict ? ['What would change that: a person checking this chart against the brand’s own page.'] : []);
    }
    return ['Fynd holds no checked garment measurements for this item, so it won’t compare it with a garment you own.']
      .concat(verdict ? ['What would change that: a checked record of this product’s garment measurements in Fynd’s catalogue.'] : []);
  }

  async function show(chart, compare, current, opts) {
    const stillCurrent = current || (() => true);
    const verdict = Boolean(opts && opts.verdict);
    /* where the fit profile's links come back to */
    const profileHref = verdict ? 'fit-profile.html?from=find-fit' : 'fit-profile.html';
    drawn.delete(compare);
    const lines = [];
    if (!chart || !chart.comparable) {
      const state = chartState(chart);
      put(compare, whyNot(chart, verdict), verdict && state === 'body-only' ? bodyOnlyActions() : [], verdict ? HEADING[state] : null, verdict && state);
      return;
    }
    const account = global.Account;
    /* a garment described on Find Fit and not saved: compared through
       the same engine, sent in the request body, by anyone */
    const unsaved = opts && opts.reference;
    let got;
    if (unsaved) {
      got = await account.sizing.compareWith(chart.productId, unsaved);
    } else {
      if (!account.state()) await account.load();
      if (!stillCurrent()) return;
      const state = account.state();
      if (!state || !state.signedIn) {
        if (verdict) {
          /* Find Fit asks for the garment right on the page */
          const p = el('p', null, 'These finished-garment measurements are checked. Describe a garment that fits you in step 1 — no account needed — and Fynd compares every size with it.');
          const go = el('p', 'fit-compare-action');
          go.append(safeLinkLocal('#ff-step-reference', 'Describe a garment that fits'));
          put(compare, [], [p, go], 'Add a garment that fits to compare', 'sign-in');
        } else {
          const p = el('p', null, 'These finished-garment measurements are checked. With a reference garment saved on ');
          p.append(safeLinkLocal(profileHref, 'your fit profile'), doc.createTextNode(', Fynd can compare every size with it.'));
          put(compare, [], [p], null, null);
        }
        return;
      }
      got = await account.sizing.compare(chart.productId);
    }
    if (!stillCurrent()) return;
    const c = got && got.ok && got.data && got.data.comparison;
    if (!c || typeof c !== 'object' || !['ok', 'partial', 'insufficient'].includes(c.status)) { failed(compare, verdict); return; }
    if (c.status === 'ok' || c.status === 'partial') {
      if (!wellFormed(c)) { failed(compare, verdict); return; }
      const outcome = outcomeOf(c);
      const lead = outcome === 'no-recommendation' ? [el('p', 'fit-compare-fallback', NOT_ENOUGH), el('p', null, c.summary)] : recommendation(c, verdict);
      const rest = [];
      if (c.reliability) rest.push(`Reliability: ${c.reliability}.`);
      (c.caveats || []).slice(0, verdict ? undefined : 2).forEach((x) => rest.push(x));
      const more = el('p');
      more.append(safeLinkLocal('compare.html', 'See every size beside your reference on Compare'));
      drawn.set(compare, { comparison: c, lead, rest, extra: [more], outcome, verdict: verdict && outcome });
      focus(compare, null);
      return;
    }
    /* insufficient: the engine's own reason (missing[0].code), as one of
       Find Fit's states, with only the action that can change it */
    const why = Array.isArray(c.missing) && c.missing[0] && typeof c.missing[0] === 'object' ? c.missing[0] : {};
    let reason = INSUFFICIENT[why.code] || 'no-recommendation';
    /* a garment described on Find Fit, but with nothing to set beside the
       item: its own measurements, or a product Fynd holds checked ones for */
    if (verdict && unsaved && reason === 'needs-reference') reason = 'needs-measurements';
    if (!verdict || reason === 'no-recommendation') lines.push(NOT_ENOUGH);
    if (verdict && reason === 'body-only') lines.push(BODY_ONLY_REST);
    else if (reason === 'needs-measurements') lines.push('Fynd compares measurements, not size labels. Add this garment’s measurements in step 1 — laid flat — or name a product Fynd holds checked measurements for.');
    else if (typeof why.message === 'string' && why.message) lines.push(why.message);
    const next = Array.isArray(c.next) && typeof c.next[0] === 'string' ? c.next[0] : null;
    if (next && ACTIONABLE[reason] && reason !== 'needs-measurements') lines.push(next);
    const extra = [];
    if (reason === 'methods' || reason === 'too-few') extra.push(notComparedList(c));
    if (verdict && reason === 'body-only') bodyOnlyActions().forEach((n) => extra.push(n));
    /* too few in common: the profile helps only where the reference is what's missing (the engine says so in next) */
    if (ACTIONABLE[reason] && (reason !== 'too-few' || next)) {
      const fix = el('p', 'fit-compare-action');
      /* on Find Fit the garment is described right there, in step 1 */
      if (verdict && (unsaved || reason === 'needs-reference')) fix.append(safeLinkLocal('#ff-step-reference', reason === 'needs-reference' ? 'Describe a garment that fits' : 'Add its measurements in step 1'));
      else fix.append(safeLinkLocal(profileHref, reason === 'needs-reference' ? 'Add a garment on your fit profile' : 'Check your reference’s measurements'));
      extra.push(fix);
    }
    put(compare, lines, extra, verdict ? HEADING[reason] : null, verdict && reason);
  }

  /* An answer that doesn't hold together draws nothing from it: no
     size, no figure — only that it couldn't be worked out. */
  function failed(compare, verdict) {
    drawn.delete(compare);
    put(compare, ['The comparison with your fit profile couldn’t be worked out just now, so no size is shown.'], [], verdict ? NO_SIZE : null, verdict && 'error');
  }

  /* Whether an ok or partial answer has what its drawing reads, each of
     the expected type: a unit, the sizes, the size it names among them,
     a reference. Anything else is refused whole, never half drawn. */
  function wellFormed(c) {
    if (c.unit !== 'in' && c.unit !== 'cm') return false;
    if (!Array.isArray(c.sizes) || !Array.isArray(c.dimensionsCompared) || !c.reference || typeof c.reference !== 'object') return false;
    if (!c.sizes.every((s) => s && typeof s.size === 'string' && s.dimensions && typeof s.dimensions === 'object')) return false;
    const named = c.status === 'ok' ? c.recommended : c.closest;
    if (c.status === 'ok' && (typeof named !== 'string' || !c.sizes.some((s) => s.size === named))) return false;
    if (c.status === 'partial' && named != null && (typeof named !== 'string' || !c.sizes.some((s) => s.size === named))) return false;
    if (c.tradeoffs !== undefined && !Array.isArray(c.tradeoffs)) return false;
    return typeof c.summary === 'string';
  }

  /* what can still be done with a body-size chart on Find Fit: see it,
     or pick a product with garment measurements (the brand browser) */
  function bodyOnlyActions() {
    const row = el('p', 'fit-compare-action');
    const details = doc.getElementById('fit-chart-details');
    if (details) {
      const view = el('button', 'link-btn fit-compare-view-chart', 'View the chart');
      view.type = 'button';
      view.addEventListener('click', () => {
        details.open = true;
        const summary = details.querySelector('summary');
        if (summary) summary.focus();
      });
      row.append(view);
    }
    const browse = doc.querySelector('.fit-brand-choice');
    if (browse) {
      if (row.childNodes.length) row.append(doc.createTextNode(' · '));
      const pick = el('button', 'link-btn fit-compare-browse', 'Try a product with garment measurements');
      pick.type = 'button';
      pick.addEventListener('click', () => browse.click());
      row.append(pick);
    }
    return row.childNodes.length ? [row] : [];
  }

  /* each measurement the engine couldn't set beside the reference, and its reason */
  function notComparedList(c) {
    const box = el('ul', 'fit-compare-not-compared');
    (Array.isArray(c.notCompared) ? c.notCompared : []).forEach((x) => {
      if (!x || !DIM_LABEL[x.dim] || typeof x.why !== 'string') return;
      const li = el('li', null, `${DIM_LABEL[x.dim]}: ${x.why}`);
      li.dataset.dim = x.dim;
      box.append(li);
    });
    return box;
  }

  /* A length as the Compare page shows it: centimetres to the
     millimetre, inches to the quarter. */
  function measure(v, unit) {
    if (typeof v !== 'number') return '—';
    if (unit === 'cm') return `${Math.round(v * 10) / 10} cm`;
    const q = Math.round(v * 4) / 4;
    const whole = Math.floor(q);
    const glyph = { 0: '', 0.25: '¼', 0.5: '½', 0.75: '¾' }[Math.round((q - whole) * 100) / 100];
    /* "¾ in", not "0¾ in"; nothing at all is "0 in" */
    return `${whole || !glyph ? whole : ''}${glyph} in`;
  }
  const DIM_LABEL = { chestWidth: 'Chest', bodyLength: 'Body length', shoulderWidth: 'Shoulders', sleeveLength: 'Sleeves' };
  const DIM_NAME = { chestWidth: 'chest width', bodyLength: 'garment length', shoulderWidth: 'shoulder width', sleeveLength: 'sleeve length' };
  const NOT_ENOUGH = 'No size recommendation: there isn’t enough reliable measurement evidence for this product and your reference.';
  const NO_SIZE = 'No size recommendation for this item';
  /* the three things a comparison can say (data-verdict in Find Fit):
       recommended        a size the engine recommends (status "ok"),
                          with any measurement it misses named
       closest-mismatch   the closest size misses every compared
                          measurement's tolerance (withheld
                          "outside-tolerance"): shown, never recommended
       no-recommendation  too little checked, comparable evidence */
  const outcomeOf = (c) => (c.status === 'ok' && c.recommended ? 'recommended'
    : c.status === 'partial' && c.withheld === 'outside-tolerance' && c.closest ? 'closest-mismatch' : 'no-recommendation');
  const TITLE = { recommended: 'Compared with your reference', 'closest-mismatch': 'No size matches your reference', 'no-recommendation': NO_SIZE };
  /* Find Fit's headings when nothing is compared, by why (data-verdict):
       unsupported      no checked garment measurements for this item
       body-only        only the body each size is cut for
       methods          measured in ways that can't be matched to the
                        reference, or not said how
       needs-reference  nothing saved to compare with */
  /* a body-size chart, in the same words wherever it can't be compared */
  const BODY_ONLY_LEAD = 'This chart measures the body, not the finished garment.';
  const BODY_ONLY_REST = 'Fynd cannot directly compare these measurements with your reference garment. No size recommendation is available from this chart alone.';
  const HEADING = {
    unsupported: 'Fynd can’t compare this item yet',
    'body-only': BODY_ONLY_LEAD,
    methods: 'These measurements can’t be matched to your reference',
    'needs-reference': 'Add a garment that fits to compare',
    'needs-measurements': 'Fynd needs this garment’s measurements',
    'too-few': 'Too few measurements in common to compare',
    'no-recommendation': NO_SIZE
  };
  /* the engine's insufficient reasons (compare(): missing[0].code) */
  const INSUFFICIENT = {
    'no-record': 'unsupported',
    'category-not-covered': 'unsupported',
    'unverified-data': 'unsupported',
    'crowdsourced-data': 'unsupported',
    'body-chart-only': 'body-only',
    'nothing-comparable': 'methods',
    'too-few-dimensions': 'too-few',
    'no-reference': 'needs-reference',
    'no-reference-measurements': 'needs-reference'
  };
  /* where the shopper's own profile can change the answer */
  const ACTIONABLE = { methods: true, 'needs-reference': true, 'needs-measurements': true, 'too-few': true };
  const GIRTH = { chestWidth: true, shoulderWidth: true };

  /* The engine's signed difference, to a tenth: "+0.5 in", "−1.0 in"
     (a true minus sign), and "0.0 in" with no sign when it rounds to
     nothing. */
  function signed(v, unit) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
    const tenth = Math.round(v * 10) / 10;
    if (tenth === 0) return `0.0 ${unit}`;
    return `${tenth > 0 ? '+' : '\u2212'}${Math.abs(tenth).toFixed(1)} ${unit}`;
  }
  /* what one compared difference measures: a chest taken around the
     body is a circumference, not a width (twice as far for the same cut) */
  const nameOf = (d, x) => (d === 'chestWidth' && x.measurement && x.measurement.method === 'garment-circumference' ? 'chest circumference' : DIM_NAME[d]);
  /* the engine's words for one difference, without its dimension name */
  const meaning = (x) => (typeof x.words === 'string' ? x.words.replace(/^[^:]+: /, '') : '');

  /* the reference, as the shopper knows it: its brand and the size on
     its label, and where its measurements came from */
  function referenceWords(ref) {
    if (ref.source === 'product' && ref.product) return `${ref.product.brand} ${ref.product.name}, size ${ref.size || '—'} (${originWords(originOf(ref.measurements), 'reference')})`;
    const named = [ref.brand, ref.size].filter(Boolean).join(' ');
    return `${named || 'Your reference garment'} (measured at home)`;
  }

  /* the engine's trade-offs that can be drawn whole — a known dimension,
     its words and its signed difference; the box shows only when one is */
  const shownTradeoffs = (c) => (Array.isArray(c.tradeoffs) ? c.tradeoffs : [])
    .filter((t) => t && DIM_LABEL[t.dim] && typeof t.words === 'string' && typeof t.difference === 'number');

  /* Each measurement of that size further from the reference than the
     engine treats as similar, with the tolerance it used — the scoring's
     working values, said to be no more than that. */
  function tradeoffList(c, size, recommended) {
    const box = el('div', 'fit-compare-tradeoffs');
    box.append(el('p', 'fit-compare-tradeoffs-title', recommended ? `Where size ${size} still differs` : `Why size ${size} isn’t recommended`));
    const ul = el('ul');
    shownTradeoffs(c).forEach((t) => {
      const li = el('li', null, `${t.words} — Fynd treats up to ${measure(t.tolerance, c.unit)} as similar`);
      li.dataset.dim = t.dim;
      li.dataset.difference = String(t.difference);
      ul.append(li);
    });
    box.append(ul);
    box.append(el('p', 'fit-compare-tradeoffs-note', '“Similar” uses Fynd’s working tolerances, not tested fit limits.'));
    return box;
  }

  /* where one compared difference falls, from the engine's own answer —
     within its tolerance is "similar", as the trade-offs say; otherwise
     its words — never from a threshold worked out here */
  function placeOf(x) {
    const said = meaning(x);
    if (x.withinTolerance === true || /the same/.test(said)) return 'same';
    if (/wider|longer/.test(said)) return 'more';
    if (/narrower|shorter/.test(said)) return 'less';
    return null;
  }

  /* each compared measurement on a three-step scale: tighter, similar,
     roomier (shorter, similar, longer for a length) */
  function fitScale(compared, row) {
    const list = el('ul', 'ff-scale');
    list.setAttribute('aria-label', 'How each measurement compares with your reference');
    compared.forEach((d) => {
      const x = row.dimensions[d];
      const place = placeOf(x);
      if (!place) return;
      const words = GIRTH[d] ? ['Tighter', 'Similar', 'Roomier'] : ['Shorter', 'Similar', 'Longer'];
      const li = el('li', 'ff-scale-row');
      li.dataset.dim = d;
      li.dataset.place = place;
      li.append(el('span', 'ff-scale-name', nameOf(d, x).replace(/^./, (ch) => ch.toUpperCase())));
      const steps = el('span', 'ff-scale-steps');
      ['less', 'same', 'more'].forEach((p, i) => {
        const step = el('span', `ff-scale-step${p === place ? ' is-here' : ''}`, words[i]);
        if (p !== place) step.setAttribute('aria-hidden', 'true');
        steps.append(step);
      });
      li.append(steps);
      list.append(li);
    });
    return list;
  }

  /* Where a side's measurements came from, as each one's record says
     (sizingSchema.measurementOf: source.origin) — never assumed from the
     brand: "official-published" (the brand's own table),
     "physical-measurement" (someone measured the garment, as the record
     names), or none known. */
  function originOf(measurements) {
    const all = Object.values(measurements && typeof measurements === 'object' ? measurements : {})
      .map((m) => m && m.source && m.source.origin).filter(Boolean);
    return all.length && all.every((o) => o === all[0]) ? all[0] : null;
  }
  function originWords(origin, side) {
    if (origin === 'official-published') return side === 'reference' ? 'published measurements' : 'published finished-garment measurements';
    if (origin === 'physical-measurement') return side === 'reference' ? 'measured from the garment' : 'finished-garment measurements taken from the garment itself';
    return side === 'reference' ? 'its recorded measurements' : 'recorded finished-garment measurements';
  }
  /* where the numbers came from, and how far each side is checked */
  function sources(c) {
    const row = c.sizes.find((s) => s.size === (c.recommended || c.closest));
    const origin = originOf(row ? Object.fromEntries(Object.entries(row.dimensions).map(([d, x]) => [d, x && x.measurement])) : null);
    const brand = c.product && typeof c.product.brand === 'string' ? c.product.brand : null;
    const item = `${brand ? `${brand}’s` : 'This item’s'} ${originWords(origin, 'item')} for this item`;
    const checked = c.dataStatus !== 'verified' ? 'not yet checked'
      : origin === 'official-published' ? 'checked against the brand’s page' : 'checked against its sources';
    const ref = c.reference.source === 'product'
      ? `your reference’s ${originWords(originOf(c.reference.measurements), 'reference')}${c.reference.product && c.reference.product.brand ? ` (${c.reference.product.brand})` : ''}`
      : 'the measurements you took of your reference at home';
    return el('p', 'ff-sources', `Sources: ${item}, ${checked}; ${ref}.`);
  }

  /* A size the engine recommends, or — when every measurement compared
     misses its tolerance — the closest one, said not to be a
     recommendation. Either way: the reference, how that size differs,
     each measurement it misses (c.tradeoffs), and its signed
     differences folded away. */
  function recommendation(c, verdict) {
    const recommended = Boolean(c.recommended);
    const size = recommended ? c.recommended : c.closest;
    const row = (c.sizes || []).find((s) => s.size === size);
    const compared = row ? c.dimensionsCompared.filter((d) => DIM_LABEL[d] && row.dimensions[d] && row.dimensions[d].compared && typeof row.dimensions[d].difference === 'number') : [];
    const nodes = [];
    if (recommended) {
      const pick = el('p', 'fit-compare-recommended');
      pick.append(doc.createTextNode('Recommended size: '), el('strong', null, size));
      nodes.push(pick);
    } else {
      const pick = el('p', 'fit-compare-closest');
      pick.append(doc.createTextNode('Closest size: '), el('strong', null, size), doc.createTextNode(' — not a recommendation'));
      nodes.push(pick);
    }
    nodes.push(el('p', 'fit-compare-reference', `Compared with: ${referenceWords(c.reference)}.`));
    nodes.push(el('p', null, c.summary));
    if (shownTradeoffs(c).length) nodes.push(tradeoffList(c, size, recommended));
    if (compared.length) {
      nodes.push(el('p', 'fit-compare-differs', `Size ${size} against your reference: ${compared.map((d) => `${nameOf(d, row.dimensions[d])} ${meaning(row.dimensions[d])}`).join(', ')}.`));
      if (verdict) nodes.push(fitScale(compared, row));
      const box = el('details', 'size-chart-details fit-compare-differences');
      box.append(el('summary', null, 'Measurement differences'));
      box.append(el('p', 'fit-compare-size-note', `Size ${size} minus your reference, in ${c.unit}: positive is larger, negative is smaller.`));
      const table = el('table', 'fit-compare-table');
      const head = el('tr');
      ['Measurement', 'Difference', 'Means'].forEach((h) => { const th = el('th', null, h); th.scope = 'col'; head.append(th); });
      const thead = el('thead');
      thead.append(head);
      const tbody = el('tbody');
      compared.forEach((d) => {
        const x = row.dimensions[d];
        const tr = el('tr');
        const th = el('th', null, nameOf(d, x).replace(/^./, (ch) => ch.toUpperCase()));
        th.scope = 'row';
        const diff = el('td', null, signed(x.difference, c.unit));
        diff.dataset.label = 'Difference';
        diff.dataset.difference = String(x.difference);
        const means = el('td', null, x.estimated ? `${meaning(x)} (estimated)` : meaning(x));
        means.dataset.label = 'Means';
        tr.dataset.dim = d;
        tr.append(th, diff, means);
        tbody.append(tr);
      });
      table.append(thead, tbody);
      const wrap = el('div', 'size-chart-scroll');
      wrap.append(table);
      box.append(wrap);
      nodes.push(box);
    }
    if (verdict) nodes.push(sources(c));
    return nodes;
  }

  /* The chosen size beside the reference: for each dimension the
     engine compared, the reference's value, this size's and the
     difference — the engine's own figures, in the comparison's unit,
     nothing worked out here. A dimension it couldn't compare says why,
     and shows no difference. */
  function focus(compare, size) {
    const d = drawn.get(compare);
    if (!d) return;
    const nodes = [];
    if (size) {
      const row = (d.comparison.sizes || []).find((s) => s.size === size);
      const unit = d.comparison.unit;
      const box = el('div', 'fit-compare-size');
      box.append(el('p', 'fit-compare-size-title', `Size ${size} beside your reference`));
      if (row) {
        const table = el('table', 'fit-compare-table');
        const head = el('tr');
        ['', 'Yours', `Size ${size}`, 'Difference'].forEach((h) => { const th = el('th', null, h); th.scope = 'col'; head.append(th); });
        const thead = el('thead');
        thead.append(head);
        const tbody = el('tbody');
        const notes = [];
        const labels = ['Yours', `Size ${size}`, 'Difference'];
        Object.keys(DIM_LABEL).filter((k) => row.dimensions[k]).forEach((k) => {
          const x = row.dimensions[k];
          const tr = el('tr');
          const th = el('th', null, DIM_LABEL[k]);
          th.scope = 'row';
          if (x.compared) {
            tr.append(th, el('td', null, measure(x.reference, unit)), el('td', null, measure(x.candidate, unit)), el('td', null, meaning(x)));
            if (x.estimated) notes.push(`${DIM_LABEL[k]}: yours is ${x.estimated}, estimated.`);
          } else {
            tr.classList.add('is-skipped');
            /* why is said once, in the engine's caveat under the table */
            tr.append(th, el('td', null, '—'), el('td', null, measure(x.candidate, unit)), el('td', null, 'Not compared'));
          }
          tbody.append(tr);
        });
        /* each value says what it is, for a phone, where the table reads as a list */
        tbody.querySelectorAll('tr').forEach((tr) => tr.querySelectorAll('td').forEach((td, i) => { td.dataset.label = labels[i]; }));
        table.append(thead, tbody);
        const wrap = el('div', 'size-chart-scroll');
        wrap.append(table);
        box.append(wrap);
        notes.forEach((t) => box.append(el('p', 'fit-compare-size-note', t)));
        if (row.unranked) box.append(el('p', null, row.unranked));
      } else {
        box.append(el('p', null, `Fynd has no garment measurements for size ${size} to set beside your reference.`));
      }
      nodes.push(box);
    }
    /* the summary (and, when recommended, the size and its differences),
       then the size being considered, then the caveats */
    const rest = d.verdict ? [limits(d.rest)] : d.rest.map((t) => el('p', null, t));
    put(compare, [], [...d.lead, ...nodes, ...rest, ...d.extra], d.verdict ? TITLE[d.outcome] : 'Compared with your reference', d.verdict);
  }

  /* the caveats, as a list a shopper can scan */
  function limits(lines) {
    const box = el('div', 'ff-limits');
    box.append(el('p', 'ff-limits-title', 'Limits of this comparison'));
    const ul = el('ul');
    lines.forEach((t) => ul.append(el('li', null, t)));
    box.append(ul);
    return box;
  }

  function safeLinkLocal(href, text) {
    const a = el('a', 'guide-link', text);
    a.href = href;
    return a;
  }

  function put(compare, lines, extra, title, verdict) {
    compare.replaceChildren(el('h3', 'fit-compare-title', title || 'Your fit profile'), ...lines.map((t) => el('p', null, t)), ...(extra || []));
    if (verdict) compare.dataset.verdict = verdict; else delete compare.dataset.verdict;
    compare.hidden = false;
  }

  global.FitCompare = { show, focus, whyNot, chartState, HEADING };
})(typeof window !== 'undefined' ? window : globalThis);
