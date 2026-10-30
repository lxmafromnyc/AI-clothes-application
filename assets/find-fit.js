/* =========================================================
   Fynd — Find Fit: which size of an item is most likely to fit like a
   garment the shopper already owns

   Two halves, both open from the start and given in either order:

     the item     one box (#fit-url) that takes either
                    a product link — checked as soon as it is a whole
                    link: at once when pasted, once typing pauses
                    otherwise — or
                    words — a brand or an item's name, searched in the
                    brands Find Fit lists once typing pauses
                    (Account.sizing.catalog, api/_catalog/search.js),
                    with matches to pick by click, tap or the arrow keys
                    and Enter (FindFit.select, as the brand browser in
                    assets/brand-browser.js also calls it)
     the garment  the garments saved on the fit profile, or one described
                  for this visit (assets/find-fit-reference.js)

   As soon as there is an item, Find Fit asks the server what it holds
   for it and whether it can be compared with the garment, if there is
   one yet (checking first, below). When the server says the two can be
   compared, the comparison runs on its own — the item's sizing chart
   (Account.sizing.chart or .item: api/_sizing/chart.js), then the
   engine's own comparison with the garment (assets/fit-compare.js) —
   but only after something the shopper did: a profile read on its own
   never starts one. "Compare fit" (or Enter on a link) runs it again,
   or shows the chart of an item that can't be compared.

   The result leads with the verdict: a size only where the engine
   recommends one, or a heading that says there is none and why. Every
   answer is tied to the request that asked for it: an older one never
   draws over a newer item, search or comparison. Nothing from the
   profile travels in any address; the product page stays a click away,
   without tracking parameters.

   From the Fynd browser extension (extension/), the address arrives
   carrying either a chart it read in the shopper's own browser
   (#fynd-chart=…, checked by assets/fynd-payload.js before anything is
   drawn) or just a product's address (#fynd-url=…, looked up as if it
   had been pasted). The fragment never reaches a server, and it is
   cleared from the address as soon as it is read. A chart from the
   extension is shown as read from the browser and not checked — never
   verified, never compared — with a way to look the product up in
   Fynd's catalog of checked charts.
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
  const chartBox = $('fit-chart-details');
  const picked = $('ff-picked');
  const { el, safeLink, render, renderFailure, headingFor, cleanUrl } = global.SizeChart;
  const sizingApi = () => global.Account && global.Account.sizing;

  let latest = 0;
  let lastAsked = '';
  /* a product picked from the suggestions or the brand browser:
     { brand, product, label }, until the box says something else */
  let choice = null;
  /* something the shopper did since the last comparison: the next answer
     that says the two can be compared runs one */
  let autoNext = false;

  /* ---------- checking first ----------
     As soon as there is an item Find Fit asks the server what it holds
     for it and whether it can be compared with the garment, if there is
     one yet (Account.sizing.check: Fynd's records and the engine's own
     preconditions, engine.validate — nothing fetched). The answer is said
     right under the item: ready (and compared), the garment still to
     add, or why it can't be compared — with the chart to view where there
     is one, its own page, and another product to try. Compare fit is off
     only while the server says a comparison can't happen. A refused or
     failed check is said, with Check again, and leaves Compare fit as it
     was. */
  const checkBox = $('ff-check');
  const submitButton = $('fit-url-submit');
  /* The answer is redrawn in place. Focus on one of its own controls
     (Check again, say) would fall to the page with it, so it goes back to
     the item's box instead; focus anywhere else is left where it is. */
  function setCheck(...nodes) {
    const hadFocus = checkBox.contains(doc.activeElement);
    checkBox.replaceChildren(...nodes);
    if (hadFocus) input.focus();
  }
  let blocked = false;
  /* a link the Fynd extension handed over: nothing about it is sent
     anywhere until the shopper asks (Check Fynd's catalog) or edits it */
  let quietUrl = null;
  let checkAsk = 0;
  let checkTimer = null;
  const CHECK_HEADING = {
    'invalid-url': 'That isn’t a product link Fynd can use',
    'blocked-address': 'Fynd doesn’t look up that address',
    'unsupported-retailer': 'Fynd doesn’t support this shop yet',
    'missing-target': 'We don’t have this item’s measurements yet',
    unverified: 'This item’s measurements aren’t verified yet',
    'body-only': 'This chart measures the body, not the finished garment.',
    methods: 'Measured differently from your garment',
    'missing-reference': 'Your garment’s measurements are missing',
    'general-chart': 'Only a general body-size chart for this item',
    'target-ready': 'We have this item’s measurements',
    'rate-limited': 'Too many checks just now',
    'check-failed': 'This item couldn’t be checked just now'
  };
  /* what an answer means for the shopper, said first; the server's own
     reasons stay one click away, under "Why?" */
  const CHECK_PLAIN = {
    'missing-target': 'So Fynd can’t suggest a size for it. Try another product, or view its size chart.',
    unverified: 'So Fynd won’t suggest a size from them. Try another product, or view its size chart.',
    'general-chart': 'It doesn’t give this item’s own measurements, so Fynd can’t suggest a size. Try another product.',
    'body-only': 'Fynd compares finished-garment measurements, so it can’t suggest a size from this. Try another product.'
  };
  /* The engine's reasons that are about the item alone — decided before
     any reference is read (engine.js prepare): with any other, the item
     itself holds checked garment measurements. Read from the answer,
     never worked out here. */
  const itemReady = (check) => global.FyndSuggest.heldChecked(check);
  function setBlocked(on) {
    blocked = on;
    submitButton.disabled = on;
    if (on) submitButton.setAttribute('aria-describedby', 'ff-check');
    else submitButton.removeAttribute('aria-describedby');
  }
  function clearCheck() {
    checkAsk += 1;
    setCheck();
    checkBox.hidden = true;
    delete checkBox.dataset.status;
    setBlocked(false);
    progress();
  }
  /* the item as it stands: a picked product, or a whole link — or none */
  function targetNow() {
    if (quietUrl && input.value === quietUrl) return null;
    if (choice && input.value === choice.label) return { brand: choice.brand.id, code: choice.product.code };
    const link = readLink(input.value);
    return link.error ? null : { url: link.url };
  }
  /* A new item or garment makes the last answer stale: it goes at once,
     and Compare fit is back until the new one says otherwise. A new item
     says it is being checked; a garment changed beside it doesn't. */
  function scheduleCheck(now, showing) {
    clearCheck();
    global.clearTimeout(checkTimer);
    checkTimer = global.setTimeout(() => runCheck(showing), now ? 0 : 400);
  }
  async function runCheck(showing) {
    const target = targetNow();
    if (!target) { clearCheck(); return; }
    const sizing = sizingApi();
    if (!sizing || !sizing.check) return;
    const ask = ++checkAsk;
    if (showing === true) {
      setCheck(el('p', 'size-chart-loading', 'Checking this item…'));
      checkBox.dataset.status = 'checking';
      checkBox.hidden = false;
      progress();
    }
    const reference = global.FindFitReference ? global.FindFitReference.unsaved() : null;
    const got = await sizing.check(target, reference);
    if (ask !== checkAsk) return;
    const check = got && got.ok && got.data && got.data.check;
    if (!check || typeof check !== 'object') { drawCheckFailure(got, target); return; }
    drawCheck(check, target);
  }
  /* No answer to go by — refused for now, or not reached: said, with a
     way to try again, and Compare fit left as it was. */
  function drawCheckFailure(got, target) {
    const status = got && got.status === 429 ? 'rate-limited' : 'check-failed';
    const nodes = [el('p', 'ff-check-title', CHECK_HEADING[status])];
    nodes.push(el('p', null, status === 'rate-limited'
      ? 'Fynd has had a lot of checks from here in a short time. Wait a few minutes, then check the item again.'
      : got && got.unreachable
        ? 'Fynd couldn’t be reached. Check your connection, then try again.'
        : 'Something went wrong on Fynd’s side. Try again in a moment.'));
    const actions = el('p', 'ff-check-actions');
    const again = el('button', 'btn btn-secondary ff-check-again', 'Check again');
    again.type = 'button';
    again.addEventListener('click', () => runCheck(true));
    actions.append(again);
    if (target.url) {
      const open = safeLink(target.url, 'Open product page');
      open.classList.add('ff-check-open');
      open.target = '_blank';
      open.rel = 'noopener noreferrer';
      actions.append(open);
    }
    nodes.push(actions);
    setCheck(...nodes);
    checkBox.dataset.status = status;
    checkBox.hidden = false;
    setBlocked(false);
    progress();
  }
  function drawCheck(check, target) {
    const v = check.validation && typeof check.validation === 'object' ? check.validation : null;
    const t = check.target || {};
    const ready = itemReady(check);
    let status = ['invalid-url', 'blocked-address', 'unsupported-retailer'].includes(t.status) ? t.status : (v && v.status) || 'missing-target';
    if (status === 'missing-target' && check.chart === 'general') status = 'general-chart';
    if (ready && v.code === 'no-reference') status = 'target-ready';
    if (status === 'target-ready') {
      /* nothing to compare with yet: the garment is the next step, and Compare fit waits for it */
      const next = el('p', 'ff-check-actions');
      const go = el('a', 'btn btn-secondary ff-check-edit', 'Describe your garment');
      go.href = '#ff-step-reference';
      next.append(go, ...itemActions(check, target, t));
      setCheck(
        el('p', 'ff-check-title', CHECK_HEADING['target-ready']),
        el('p', null, 'Now add a garment you own that fits well, and Fynd compares the two.'),
        next);
      checkBox.dataset.status = status;
      checkBox.hidden = false;
      setBlocked(true);
      progress();
      return;
    }
    if (check.comparable && v && v.ready) {
      setBlocked(false);
      setCheck(el('p', 'ff-check-ok', v.explanation));
      checkBox.dataset.status = 'ready';
      checkBox.hidden = false;
      progress();
      /* both halves can be compared, and the shopper asked for something since: compare */
      if (autoNext) { autoNext = false; compareNow(true); }
      return;
    }
    const nodes = [el('p', 'ff-check-title', CHECK_HEADING[status] || CHECK_HEADING['missing-target'])];
    const plain = CHECK_PLAIN[status];
    if (plain) nodes.push(el('p', 'ff-check-plain', plain));
    /* the heading already says the first sentence of a body chart's explanation */
    const said = v && typeof v.explanation === 'string'
      ? (v.explanation.startsWith(nodes[0].textContent) ? v.explanation.slice(nodes[0].textContent.length).trim() : v.explanation)
      : '';
    const why = [];
    if (said) why.push(el('p', null, said));
    else if (status === 'invalid-url') nodes.push(el('p', null, 'Paste the full address of a clothing product’s page.'));
    else if (status === 'blocked-address') nodes.push(el('p', null, 'Fynd only looks up public product pages.'));
    /* which retailer can't be read is not the same as which measurements are missing */
    if (t.pages && t.pages !== 'readable' && status !== 'invalid-url' && status !== 'blocked-address') {
      why.push(el('p', 'ff-check-access', t.pages === 'not-permitted'
        ? `${t.host || 'This shop'}’s terms don’t allow Fynd to read its pages.`
        : `Fynd doesn’t read ${t.host || 'this shop'}’s pages: it hasn’t confirmed their terms allow it.`));
    }
    const dims = v && Array.isArray(v.dimensions) ? v.dimensions.filter((d) => d && !d.compared && typeof d.why === 'string') : [];
    if ((status === 'methods' || (v && v.code === 'too-few-dimensions')) && dims.length) {
      const ul = el('ul', 'ff-check-dims');
      dims.forEach((d) => { const li = el('li', null, `${DIM_WORDS[d.dim] || d.dim}: ${d.why}`); li.dataset.dim = d.dim; ul.append(li); });
      why.push(ul);
    }
    if (v && Array.isArray(v.next) && typeof v.next[0] === 'string') why.push(el('p', 'ff-check-next', v.next[v.next.length - 1]));
    /* an answer about the item: the reasons fold away under its plain words;
       one about the garment is the shopper's to act on, so it stays open */
    if (why.length && plain) {
      const fold = el('details', 'ff-check-why');
      fold.append(el('summary', null, 'Why?'), ...why);
      nodes.push(fold);
    } else nodes.push(...why);
    /* what can still be done */
    const actions = el('p', 'ff-check-actions');
    actions.append(...itemActions(check, target, t));
    if (status === 'missing-reference' || status === 'methods') {
      const edit = el('a', 'guide-link ff-check-edit', 'Edit your garment');
      edit.href = '#ff-step-reference';
      actions.append(edit);
    }
    /* a body-size chart: another product may have the garment's own measurements */
    const browse = status === 'body-only' && doc.querySelector('.fit-brand-choice');
    if (browse) {
      const pick = el('button', 'link-btn ff-check-browse', 'Try a product with garment measurements');
      pick.type = 'button';
      pick.addEventListener('click', () => browse.click());
      actions.append(pick);
    }
    /* the item itself can't be compared: another one is the way on */
    if (!ready) {
      const another = el('button', 'link-btn ff-check-another', 'Try another product');
      another.type = 'button';
      another.addEventListener('click', tryAnother);
      actions.append(another);
    }
    if (actions.childNodes.length) nodes.push(actions);
    setCheck(...nodes);
    checkBox.dataset.status = status;
    checkBox.hidden = false;
    setBlocked(true);
    progress();
  }
  const DIM_WORDS = { chestWidth: 'Chest', bodyLength: 'Length', shoulderWidth: 'Shoulders', sleeveLength: 'Sleeves' };
  /* What can be done with the item itself, whatever else the answer
     says: its chart, where the server says there is one, and its own
     page, when the server gave an https address for it. */
  function itemActions(check, target, t) {
    const out = [];
    if (check.chart && check.chart !== 'none') {
      const view = el('button', 'btn btn-secondary ff-check-view', 'View size chart');
      view.type = 'button';
      view.addEventListener('click', () => lookupTarget(target));
      out.push(view);
    }
    if (t.url && /^https:\/\//.test(t.url)) {
      const open = safeLink(t.url, 'Open product page');
      open.classList.add('ff-check-open');
      open.target = '_blank';
      open.rel = 'noopener noreferrer';
      out.push(open);
    }
    return out;
  }
  /* "Try another product": the box, empty and ready, and nothing stale left */
  function tryAnother() {
    if (choice) unselect();
    input.value = '';
    retire();
    clearCheck();
    closeSuggest();
    say('');
    input.focus();
  }
  /* the chart, looked up as Compare fit would, even while comparing is off */
  function lookupTarget(target) {
    if (target.brand && choice) return findItem(choice.brand, choice.product);
    return target.url ? find(target.url) : undefined;
  }
  /* the comparison, for the item as it stands */
  function compareNow(quiet) {
    if (choice && input.value === choice.label) return findItem(choice.brand, choice.product, quiet);
    const link = readLink(input.value);
    return link.error ? undefined : find(link.url, quiet);
  }
  /* A different item: any comparison still on its way is for the old one,
     so it is dropped, and a result on screen for the old one goes. */
  function retire() {
    latest += 1;
    lastAsked = '';
    if (!result.hidden && result.dataset.from !== 'extension') {
      result.hidden = true;
      if (global.FindFitSave) global.FindFitSave.hide();
    }
    submitButton.disabled = blocked;
  }

  /* ---------- where the two halves stand ----------
     One line above both: the item, the garment, and the next step —
     never in the way of either. */
  const progressBox = $('ff-progress');
  function setPill(id, text) {
    const pill = $(id);
    const t = pill && pill.querySelector('.ff-progress-text');
    if (t) t.textContent = text;
  }
  function progress() {
    if (!progressBox) return;
    const status = checkBox.dataset.status;
    const text = input.value.trim();
    let item = 'empty';
    if (status === 'ready' || status === 'target-ready') item = 'ready';
    else if (status === 'checking') item = 'checking';
    else if (status === 'check-failed' || status === 'rate-limited') item = 'error';
    else if (status) item = 'blocked';
    else if (targetNow()) item = 'checking';
    else if (text) item = 'choosing';
    const ref = global.FindFitReference;
    const area = $('ff-reference');
    const savedGarments = area && area.dataset.state === 'saved';
    const garment = savedGarments || (ref && ref.current && ref.current()) ? 'ready' : 'empty';
    progressBox.dataset.item = item;
    progressBox.dataset.garment = garment;
    setPill('ff-progress-item', {
      empty: 'Item: not added yet', choosing: 'Item: pick a match or paste a link', checking: 'Item: checking…',
      ready: 'Item: measurements found', blocked: 'Item: can’t be compared yet', error: 'Item: couldn’t be checked'
    }[item]);
    setPill('ff-progress-garment', garment === 'ready' ? (savedGarments ? 'Your garment: from your fit profile' : 'Your garment: added') : 'Your garment: not added yet');
    let next = 'Add both, in any order.';
    if (item === 'blocked') next = 'Try another product to get a size.';
    else if (item === 'error') next = 'Check the item again in a moment.';
    else if (item === 'checking') next = 'Checking the item…';
    else if (item === 'ready' && garment === 'ready') next = !result.hidden && result.dataset.state === 'loading' ? 'Comparing…' : (!result.hidden ? 'Your comparison is below.' : 'Ready to compare.');
    else if (item === 'ready') next = 'Next: add a garment you own that fits well.';
    else if (garment === 'ready') next = 'Next: add the item you’re considering.';
    $('ff-progress-next').textContent = next;
  }

  /* ---------- suggestions ----------
     Words in the box are searched in Fynd's catalogue once typing pauses
     (assets/catalog-suggest.js): a size typed with them is read apart,
     only the newest answer is drawn, only products matching every word
     are offered, what the catalogue covers is said, and a link can
     always be pasted instead. A product picked is only its identity:
     whether it can be compared is the check's to say. */
  const suggest = global.FyndSuggest.attach({
    input,
    box: $('ff-suggest-box'),
    list: $('ff-suggest'),
    status: $('ff-suggest-status'),
    idPrefix: 'ff-suggest',
    onPick: (f) => select(f.brand, f.product),
    say: {
      unavailable: 'Search isn’t available right now. Paste the product’s link instead.',
      empty: (words) => `No products match “${words}”. Paste the product’s link instead.`,
      ready: (n) => `${n} matching product${n === 1 ? '' : 's'}. Not listed? Paste its link.`
    }
  });
  const closeSuggest = () => suggest.close();

  /* a whole link, as a shopper would paste or type it: a scheme, or a
     www. address; anything else in the box is words to search */
  const looksLikeLink = (text) => /^(https?:\/\/|www\.)\S+$/i.test(text) || /^[a-z0-9-]+(\.[a-z0-9-]+)+\/\S*$/i.test(text);
  /* a link still being typed — "htt", "https:/", "www" — is not words to search */
  const linkSoFar = (text) => /^(h(t(t(p(s?(:\/{0,2})?)?)?)?)?|w(w(w\.?)?)?)$/i.test(text) || /^(https?:|www\.)/i.test(text);

  /* no checked garment measurements to compare: Find Fit's own heading for it */
  const UNSUPPORTED = 'Fynd can’t compare this item yet';

  /* The result's lead: the verdict — what was found out, or why nothing
     could be — in the place a shopper looks first. */
  function verdict(title, nodes, state) {
    compare.replaceChildren(el('h3', 'fit-compare-title', title), ...nodes);
    compare.dataset.verdict = state;
    compare.hidden = false;
  }
  /* the item's chart as published, and where it came from: there to
     check, folded away under the verdict */
  function showChart(nodes) {
    body.replaceChildren(...nodes);
    chartBox.open = false;
    chartBox.hidden = false;
  }
  function hideChart() {
    body.replaceChildren();
    chartBox.hidden = true;
  }

  /* A whole http(s) link to somewhere with a name, or why not. */
  function readLink(raw) {
    let text = String(raw || '').trim();
    if (!text) return { error: 'Paste a product link, or search for a brand or item and pick a match.' };
    /* an address typed without its scheme is the https page */
    if (!/^[a-z][a-z0-9+.-]*:/i.test(text) && looksLikeLink(text)) text = `https://${text}`;
    let u;
    try { u = new URL(text); } catch (err) {
      return { error: 'That isn’t a valid product link. Paste the full address of a product page, starting with https://.' };
    }
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) {
      return { error: 'That isn’t a product page link. Paste an address starting with https:// from a clothing shop.' };
    }
    return { url: u.href };
  }

  /* "View product", and the shop it is on */
  function productLink(url) {
    const line = $('fit-result-product');
    let host = '';
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch (err) { /* shown without */ }
    line.replaceChildren(safeLink(url, 'View product'));
    if (host) line.append(el('span', 'fit-result-host', ` · ${host}`));
  }

  function say(text) {
    error.textContent = text || '';
    error.classList.toggle('show', Boolean(text));
    if (text) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }

  /* A pasted link: its chart, looked up by its address. */
  function find(url, quiet) {
    lastAsked = url;
    return lookup(url, null, 'Finding this product’s sizing chart…', 'Reading the product’s page and any size guide it links to…',
      (sizing) => sizing.chart(url), quiet);
  }

  /* A product picked in the brand browser (assets/brand-browser.js):
     its chart, asked for by the brand and the product's code. The
     server finds the product's address itself. */
  function findItem(brand, product, quiet) {
    const named = `${brand.name} · ${product.name}`;
    return lookup(product.url, Object.assign({ named }, product), named, 'Looking up this product’s sizing chart. Reading the brand’s page can take a few seconds…',
      (sizing) => sizing.item(brand.id, product.code), quiet);
  }

  /* quiet: started on its own, not by a press — focus stays where the
     shopper is, and the page moves to the result only if they aren't
     typing */
  const typing = () => Boolean(doc.activeElement && /^(INPUT|SELECT|TEXTAREA)$/.test(doc.activeElement.tagName));
  async function lookup(url, product, title, waiting, request, quiet) {
    const ask = ++latest;
    say('');
    result.hidden = false;
    result.dataset.state = 'loading';
    delete result.dataset.from;
    if (product) result.dataset.item = product.code;
    else delete result.dataset.item;
    hideChart();
    if (global.FindFitSave) global.FindFitSave.hide();
    verdict('Comparing…', [el('p', 'size-chart-loading', waiting)], 'loading');
    productLink(cleanUrl(url));
    $('fit-result-title').textContent = title;
    submitButton.disabled = true;
    progress();
    if (product && !(quiet && typing())) result.scrollIntoView({ block: 'start', behavior: 'auto' });

    const sizing = global.Account && global.Account.sizing;
    const answer = sizing ? await request(sizing) : { ok: false, unreachable: true };
    if (ask !== latest) return;
    submitButton.disabled = blocked;

    if (!(answer.ok && answer.data && answer.data.chart)) {
      result.dataset.state = 'error';
      $('fit-result-title').textContent = product ? product.named : 'Sizing chart unavailable';
      verdict(UNSUPPORTED, renderFailure(answer, url, { linked: true }), 'unsupported');
      progress();
      attempted(ask);
      return;
    }
    const chart = answer.data.chart;
    result.dataset.state = chart.status;
    /* a picked product keeps the name its brand listing gave, when its
       page couldn't say */
    $('fit-result-title').textContent = product && !(chart.product && chart.product.name) ? product.named : headingFor(chart);
    /* the server's canonical page for it, when it gave one */
    const page = chart.source && chart.source.url;
    if (page && /^https?:\/\//.test(page)) productLink(page);
    const drawn = render(chart, url, { linked: true });
    /* a chart to compare: the verdict leads, the chart folds away. No
       chart: what was found out is the verdict itself. */
    if (chart.status === 'ok' || chart.status === 'fallback') {
      showChart(drawn);
      verdict('Comparing…', [el('p', 'size-chart-loading', 'Setting this item beside your reference…')], 'loading');
    } else {
      hideChart();
      verdict(UNSUPPORTED, drawn, 'unsupported');
    }
    if (!quiet) $('fit-result-title').focus({ preventScroll: true });
    if (!(quiet && typing())) result.scrollIntoView({ block: 'start', behavior: 'auto' });
    progress();
    /* a fallback says why it can't be compared, like any body chart */
    if (chart.status === 'ok' || chart.status === 'fallback') await compareWith(chart, ask);
    progress();
    attempted(ask);
  }

  /* The comparison, only where the chart supports it: the engine's own,
     drawn by assets/fit-compare.js in Find Fit's verdict layout — with
     the saved reference, or else the garment described this visit
     (sent in the request body, kept nowhere). */
  function compareWith(chart, ask) {
    const reference = global.FindFitReference ? global.FindFitReference.unsaved() : null;
    return global.FitCompare.show(chart, compare, () => ask === latest, Object.assign({ verdict: true }, reference ? { reference } : {}));
  }

  /* once the result of a comparison is on screen, and only then: the
     offer to save this visit's garment (assets/find-fit-save.js) */
  function attempted(ask) {
    if (ask === latest && global.FindFitSave) global.FindFitSave.offer();
  }

  /* A product picked — from the suggestions or the brand browser —
     becomes the item: named in the box, with what Fynd holds for its
     sizing and its own page a click away, until the box says something
     else. It is checked at once, with nothing more to press. */
  function select(brand, product) {
    const label = `${brand.name} · ${product.name}`;
    choice = { brand, product, label };
    quietUrl = null;
    input.value = label;
    closeSuggest();
    say('');
    retire();
    const line = el('p', 'ff-picked-name');
    line.append(el('strong', null, label));
    const page = el('a', 'guide-link ff-picked-page', 'View its page');
    page.href = `product.html?${new URLSearchParams({ brand: brand.id, item: product.code })}`;
    const clear = el('button', 'ff-picked-clear', 'Clear');
    clear.type = 'button';
    clear.addEventListener('click', () => { unselect(); input.value = ''; retire(); clearCheck(); input.focus(); });
    const actions = el('p', 'ff-picked-actions');
    actions.append(page, clear);
    const facts = global.BrandBrowser && global.BrandBrowser.facts ? global.BrandBrowser.facts(product.status) : null;
    const details = el('p', 'ff-picked-detail', `Product ID ${product.code}`);
    picked.replaceChildren(line, el('p', 'ff-picked-holds', product.holdsText || ''), ...(facts ? [facts] : []), details, actions);
    picked.hidden = false;
    autoNext = true;
    scheduleCheck(true, true);
    pickedDetail(brand, product, details);
  }
  /* The picked product's own details, from the brand module
     (?brand=&detail=, the product page's source): its sizes and where
     they came from. Comparing waits on the server's check, never on this;
     if it can't be had, the product ID stays and nothing is guessed. */
  async function pickedDetail(brand, product, line) {
    const sizing = sizingApi();
    if (!sizing || typeof sizing.detail !== 'function') return;
    const asked = choice;
    const got = await sizing.detail(brand.id, product.code);
    if (choice !== asked) return;
    const d = got && got.ok && got.data && got.data.product;
    if (!d || d.code !== product.code) { picked.dataset.detail = 'unavailable'; return; }
    const parts = [`Product ID ${d.code}`];
    if (d.categoryLabel) parts.push(d.categoryLabel);
    if (d.sizes && Array.isArray(d.sizes.list) && d.sizes.list.length) parts.push(`Sizes ${d.sizes.list.join(', ')}`);
    line.textContent = parts.join(' · ');
    if (d.sizes && d.sizes.source) line.title = d.sizes.source;
    picked.dataset.detail = 'ready';
  }
  function unselect() {
    choice = null;
    delete picked.dataset.detail;
    picked.replaceChildren();
    picked.hidden = true;
  }

  function submit() {
    closeSuggest();
    /* asked for now: no second, automatic comparison after this one */
    autoNext = false;
    /* known not to be comparable: Enter shows what can still be shown —
       the item's chart, with why it isn't compared — never a comparison */
    if (blocked) {
      const target = targetNow();
      if (target) lookupTarget(target);
      return;
    }
    if (choice && input.value === choice.label) { findItem(choice.brand, choice.product); return; }
    const text = input.value.trim();
    if (text && !looksLikeLink(text) && !/^[a-z][a-z0-9+.-]*:/i.test(text)) {
      say('Pick a matching product, or paste the product’s link.');
      input.focus();
      return;
    }
    const link = readLink(input.value);
    if (link.error) { say(link.error); input.focus(); return; }
    find(link.url);
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submit();
  });
  /* A whole link pasted is a request: its measurements are read and set
     beside the garment at once, and it is checked too. A link typed is
     checked once typing pauses, and read on Enter or Compare fit; words
     are searched. */
  input.addEventListener('paste', () => {
    global.setTimeout(() => {
      const text = input.value.trim();
      if (!looksLikeLink(text)) return;
      const link = readLink(text);
      if (link.error || link.url === lastAsked) return;
      closeSuggest();
      autoNext = false;
      scheduleCheck(true, true);
      find(link.url);
    }, 0);
  });
  input.addEventListener('input', () => {
    quietUrl = null;
    if (error.textContent) say('');
    if (choice && input.value !== choice.label) unselect();
    retire();
    const text = input.value.trim();
    if (looksLikeLink(text)) {
      closeSuggest();
      autoNext = true;
      scheduleCheck(false, true);
    } else {
      global.clearTimeout(checkTimer);
      clearCheck();
      if (linkSoFar(text)) closeSuggest(); else suggest.soon(text);
    }
  });
  /* the arrow keys move through the matches; Enter picks one; Escape closes them */
  input.addEventListener('keydown', (event) => {
    if (suggest.key(event)) return;
    /* Compare fit is off for an item that can't be compared, and a form
       isn't sent by Enter while its button is off: Enter is taken here
       instead, so it still shows what can be shown — the item's chart */
    if (event.key === 'Enter' && blocked) { event.preventDefault(); submit(); }
  });
  /* a garment changed: the item is checked again with it — and, when the
     shopper changed it, compared once the two can be */
  doc.addEventListener('fynd:reference-change', (event) => {
    if (event && event.detail && event.detail.by === 'shopper') autoNext = true;
    scheduleCheck(true);
    progress();
  });

  /* A chart the Fynd extension read in this browser: checked, drawn as
     read from the browser and unverified, never compared. */
  function showExtensionChart(payload) {
    ++latest;
    const url = payload.page.url;
    lastAsked = url;
    quietUrl = url;
    clearCheck();
    input.value = url;
    say('');
    const chart = global.FyndPayload.toChart(payload);
    result.hidden = false;
    result.dataset.state = chart.status;
    result.dataset.from = 'extension';
    $('fit-result-title').textContent = headingFor(chart);
    productLink(url);
    const lookup = el('button', 'btn btn-secondary fit-catalog', 'Check Fynd’s catalog for this product');
    lookup.type = 'button';
    lookup.addEventListener('click', () => find(url));
    const offer = el('p', 'fit-catalog-line');
    offer.append(el('span', null, 'Fynd may have a checked chart for this product. '), lookup);
    showChart(render(chart, url, { linked: true }));
    /* what the chart itself is — body only, measured how it doesn't say,
       or not checked — with the same reasons a pasted link's would give */
    const state = global.FitCompare ? global.FitCompare.chartState(chart) : 'unsupported';
    verdict(global.FitCompare ? global.FitCompare.HEADING[state] : UNSUPPORTED, [
      el('p', null, 'This chart was read from the page open in your browser and hasn’t been checked, so Fynd won’t compare it with a garment you own.'),
      ...(global.FitCompare ? global.FitCompare.whyNot(chart, true) : []).map((t) => el('p', null, t)),
      offer
    ], state);
    $('fit-result-title').focus({ preventScroll: true });
    result.scrollIntoView({ block: 'start', behavior: 'auto' });
  }

  /* #fynd-chart=… or #fynd-url=…, from the extension: read once, then
     cleared from the address */
  function fromExtension() {
    const hash = global.location.hash || '';
    const chartIn = /^#fynd-chart=([A-Za-z0-9_-]{1,30000})$/.exec(hash);
    const urlIn = /^#fynd-url=([^#]{1,4000})$/.exec(hash);
    if (!chartIn && !urlIn && !/^#fynd-(chart|url)=/.test(hash)) return;
    global.history.replaceState(null, '', global.location.pathname + global.location.search);
    if (urlIn) {
      let raw = '';
      try { raw = decodeURIComponent(urlIn[1]); } catch (err) { /* refused below */ }
      const link = readLink(raw);
      if (link.error) { say(link.error); return; }
      /* the extension asked for one lookup of this product: that, and nothing more */
      quietUrl = link.url;
      input.value = link.url;
      find(link.url);
      return;
    }
    const got = chartIn && global.FyndPayload ? global.FyndPayload.decode(chartIn[1]) : { error: 'unreadable' };
    if (got.error) {
      result.hidden = false;
      result.dataset.state = 'error';
      result.dataset.from = 'extension';
      $('fit-result-title').textContent = 'This chart couldn’t be opened';
      $('fit-result-product').replaceChildren();
      hideChart();
      verdict(UNSUPPORTED, [el('p', 'size-chart-note', 'The link from the Fynd extension wasn’t a chart Fynd could read, so nothing from it is shown. Check the product page again with the extension, or paste the product’s link above.')], 'unsupported');
      return;
    }
    showExtensionChart(got.payload);
  }
  fromExtension();
  global.addEventListener('hashchange', fromExtension);

  progress();
  global.FindFit = { readLink, find, findItem, select, fromExtension };
})(typeof window !== 'undefined' ? window : globalThis);
