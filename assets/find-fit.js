/* =========================================================
   Fynd — Find Fit: a product's link in, its sizing chart out

   The home page's one box takes a link to a clothing product. When a
   whole link is pasted, or Enter or "Find sizing chart" is pressed —
   never on each keystroke — the link goes to the server
   (Account.sizing.chart: /api/size-recommendation?chart=, which reads
   only public pages, on its own side; see api/_sizing/chart.js) and the
   answer is drawn here by assets/size-chart.js: the chart as published,
   what it measures, where it came from, or why there isn't one. The
   link the shopper gave stays beside the answer it produced.

   No account is needed. Signed in, a chart Fynd has checked
   finished-garment measurements for is also set beside the shopper's
   saved reference garment (Account.sizing.compare: the engine's own
   comparison, read from their own profile on the server — nothing from
   the profile travels in any address). Any other chart says why it
   can't be compared; a chart is never a recommendation by itself.
   ========================================================= */

(function (global) {
  'use strict';

  const doc = global.document;
  const form = doc && doc.getElementById('fit-url-form');
  if (!form || !global.SizeChart) return;

  const $ = (id) => doc.getElementById(id);
  const input = $('fit-url');
  const error = $('fit-url-error');
  const result = $('fit-result');
  const body = $('fit-result-body');
  const compare = $('fit-compare');
  const { el, safeLink, render, renderFailure } = global.SizeChart;

  let latest = 0;
  let lastAsked = '';

  /* A whole http(s) link to somewhere with a name, or why not. */
  function readLink(raw) {
    const text = String(raw || '').trim();
    if (!text) return { error: 'Paste a link to a clothing product’s page first.' };
    let u;
    try { u = new URL(text); } catch (err) {
      return { error: 'That isn’t a valid product link. Paste the full address of a product page, starting with https://.' };
    }
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) {
      return { error: 'That isn’t a product page link. Paste an address starting with https:// from a clothing shop.' };
    }
    return { url: u.href };
  }

  function say(text) {
    error.textContent = text || '';
    error.classList.toggle('show', Boolean(text));
    if (text) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }

  async function find(url) {
    const ask = ++latest;
    lastAsked = url;
    say('');
    result.hidden = false;
    result.dataset.state = 'loading';
    compare.hidden = true;
    compare.replaceChildren();
    const asked = $('fit-result-asked');
    asked.replaceChildren(el('span', null, 'Sizing for '), safeLink(url, url));
    $('fit-result-title').textContent = 'Finding this product’s sizing chart…';
    body.replaceChildren(el('p', 'size-chart-loading', 'Reading the product’s page and any size guide it links to…'));
    $('fit-url-submit').disabled = true;

    const sizing = global.Account && global.Account.sizing;
    const answer = sizing ? await sizing.chart(url) : { ok: false, unreachable: true };
    if (ask !== latest) return;
    $('fit-url-submit').disabled = false;

    if (!(answer.ok && answer.data && answer.data.chart)) {
      result.dataset.state = 'error';
      $('fit-result-title').textContent = 'No sizing chart';
      body.replaceChildren(...renderFailure(answer, url));
      return;
    }
    const chart = answer.data.chart;
    result.dataset.state = chart.status;
    $('fit-result-title').textContent = global.SizeChart.headingFor(chart);
    body.replaceChildren(...render(chart, url));
    $('fit-result-title').focus({ preventScroll: true });
    result.scrollIntoView({ block: 'start', behavior: 'auto' });
    if (chart.status === 'ok') compareWith(chart, ask);
  }

  /* The fit profile's part: only where the chart supports it. */
  async function compareWith(chart, ask) {
    const kinds = (chart.charts || []).map((c) => c.measures);
    const lines = [];
    if (!chart.comparable) {
      if (kinds.includes('finished-garment') || kinds.includes('not-stated')) {
        lines.push(chart.verification === 'unverified'
          ? 'These measurements haven’t been checked against the brand yet, so Fynd won’t compare them with a garment you own.'
          : 'Fynd can’t compare this chart with a garment you own yet: it can’t confirm exactly how each measurement was taken, and two garments are only comparable when measured the same way.');
      } else {
        lines.push('This chart describes bodies, not garments, so it can’t be set beside a garment you own.');
      }
      show(lines);
      return;
    }
    const account = global.Account;
    if (!account.state()) await account.load();
    if (ask !== latest) return;
    const state = account.state();
    if (!state || !state.signedIn) {
      const p = el('p', null, 'These finished-garment measurements are checked. With a reference garment saved on ');
      p.append(safeLinkLocal('fit-profile.html', 'your fit profile'), doc.createTextNode(', Fynd can compare every size with it.'));
      show([], [p]);
      return;
    }
    const got = await account.sizing.compare(chart.productId);
    if (ask !== latest) return;
    const c = got.ok && got.data && got.data.comparison;
    if (!c) { show(['The comparison with your fit profile couldn’t be worked out just now.']); return; }
    if (c.status === 'ok' || c.status === 'partial') {
      lines.push(c.summary);
      if (c.reliability) lines.push(`Reliability: ${c.reliability}.`);
      (c.caveats || []).slice(0, 2).forEach((x) => lines.push(x));
      const more = el('p');
      more.append(safeLinkLocal('compare.html', 'See every size beside your reference on Compare'));
      show(lines, [more], 'Compared with your reference');
      return;
    }
    (c.missing || []).slice(0, 1).forEach((m) => lines.push(m.message));
    (c.next || []).slice(0, 1).forEach((n) => lines.push(n));
    const fix = el('p');
    fix.append(safeLinkLocal('fit-profile.html', 'Open your fit profile'));
    show(lines, [fix]);
  }

  function safeLinkLocal(href, text) {
    const a = el('a', 'guide-link', text);
    a.href = href;
    return a;
  }

  function show(lines, extra, title) {
    compare.replaceChildren(el('h3', 'fit-compare-title', title || 'Your fit profile'), ...lines.map((t) => el('p', null, t)), ...(extra || []));
    compare.hidden = false;
  }

  function submit() {
    const link = readLink(input.value);
    if (link.error) { say(link.error); input.focus(); return; }
    find(link.url);
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submit();
  });
  /* a whole link pasted is a request; typing one is not, until Enter */
  input.addEventListener('paste', () => {
    global.setTimeout(() => {
      const link = readLink(input.value);
      if (!link.error && link.url !== lastAsked) find(link.url);
    }, 0);
  });
  input.addEventListener('input', () => { if (error.textContent) say(''); });

  global.FindFit = { readLink, find };
})(typeof window !== 'undefined' ? window : globalThis);
