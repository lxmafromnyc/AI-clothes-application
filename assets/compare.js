/* =========================================================
   Fynd — compare before buying

   Four steps, on one page, for hoodies and sweatshirts:

     1  your fit reference   a hoodie or sweatshirt you own and like, as
                             the fit profile holds it (garments.<type>:
                             favorite and anchor). Shown here, read only:
                             it is added, edited, replaced and removed on
                             the fit profile page, the one place sizing
                             information is managed, which this page
                             links to at that type's card.
     2  a product            what Fynd has sizing for, of that type, each
                             saying whether it can be compared
     3  the comparison       the server's (api/size-recommendation.js,
                             compare=1): every size beside the reference,
                             in the reference's unit unless another is
                             chosen. Nothing is worked out on this page;
                             it only says what came back.
     4  fit feedback         how a size fitted once tried, kept on the
                             account with consent, one entry per product
                             and size, editable and removable

   Signed out, the page says why it needs an account and shows nothing
   else. A failed save keeps every answer on screen and says so.
   ========================================================= */

(function (global) {
  'use strict';

  const doc = global.document;
  const root = doc && doc.getElementById('compare-root');
  if (!root) return;
  const Schema = global.FitProfileSchema;
  const $ = (id) => doc.getElementById(id);

  const TYPES = { hoodies: 'hoodie', sweatshirts: 'sweatshirt' };
  const DIMS = ['chestWidth', 'bodyLength', 'shoulderWidth', 'sleeveLength'];
  const DIM_LABEL = { chestWidth: 'Chest, flat', bodyLength: 'Body length', shoulderWidth: 'Shoulders', sleeveLength: 'Sleeves' };
  const RELIABILITY = {
    high: 'Reliability: high — all four measurements compared, from checked data.',
    medium: 'Reliability: medium — see the limits below.',
    low: 'Reliability: low — treat this as a rough guide; see the limits below.'
  };

  let type = 'hoodies';
  let profile = null;
  let products = [];
  let feedback = { consent: { store: false }, entries: [] };
  let selected = null;
  let comparison = null;
  /* the server's decision: the only authority for a size marked recommended */
  let decision = null;
  let showUnit = null;
  let editingFeedback = null;
  let busy = false;

  /* ---------- small helpers ---------- */

  const el = (tag, cls, text) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  };
  const show = (id, on) => { $(id).hidden = !on; };
  const note = (text, warn) => {
    const n = $('compare-note');
    n.textContent = text || '';
    n.className = `billing-note${warn ? ' billing-note--warn' : ''}`;
    n.hidden = !text;
  };
  const failure = (result, fallback) => (result.unreachable ? 'Fynd could not be reached. Check your connection and try again.' : (result.data && result.data.error) || fallback);

  /* a measurement as a shopper reads it: "64.5 cm", "25¾ in" */
  function measure(v, unit) {
    if (typeof v !== 'number') return '—';
    if (unit === 'cm') return `${Math.round(v * 10) / 10} cm`;
    const q = Math.round(v * 4) / 4;
    const whole = Math.floor(q);
    const glyph = { 0: '', 0.25: '¼', 0.5: '½', 0.75: '¾' }[Math.round((q - whole) * 100) / 100];
    return `${whole}${glyph} in`;
  }

  const entryOf = (t) => (profile && profile.garments && profile.garments[t]) || null;
  const anchorOf = (t) => { const e = entryOf(t); return e && e.favorite !== 'none' ? e.anchor : null; };

  /* ---------- 1  the reference ---------- */

  function renderReference() {
    const a = anchorOf(type);
    const word = TYPES[type];
    const list = $('ref-saved-list');
    list.replaceChildren();
    const row = (label, value) => {
      if (!value) return;
      list.append(el('dt', null, label), el('dd', null, value));
    };
    if (a && (a.brand || a.size || a.product || a.measurements)) {
      row('Brand', a.brand || 'Not said');
      row('Size on the label', a.size || 'Not sure');
      if (a.product) row('Product', a.product.name || a.product.url);
      const m = a.measurements;
      if (m) DIMS.forEach((d) => row(DIM_LABEL[d], typeof m[d] === 'number' ? measure(m[d], m.unit) : 'Not measured'));
      const said = Schema.describeFavorite(entryOf(type));
      if (said && said.likes) row('What matters most', said.likes);
      if (said && said.answer) row('Fit', entryOf(type).favorite === 'close' ? 'Close to how I like it' : 'Exactly how I like it');
      if (a.notes) row('Notes', a.notes);
      $('ref-saved-hint').textContent = m ? '' : `Add its measurements on your fit profile to compare precisely: a brand and size alone aren't a measurement.`;
      show('ref-saved-hint', !m);
      show('ref-saved', true);
      show('ref-empty', false);
    } else {
      $('ref-empty-text').textContent = `No ${word} reference yet. You can still look at products — but measuring a ${word} you own is what makes the comparison precise.`;
      show('ref-saved', false);
      show('ref-empty', true);
    }
    /* managed on the fit profile, opened at this type's card */
    ['ref-edit', 'ref-add'].forEach((id) => { $(id).href = `fit-profile.html?for=${type}`; });
  }

  function clearErrors(form) {
    form.querySelectorAll('.profile-error').forEach((p) => { p.textContent = ''; });
    form.querySelectorAll('[aria-invalid]').forEach((c) => c.removeAttribute('aria-invalid'));
  }

  /* server errors, each beside its field; any without one, at the foot */
  function paintErrors(form, errors, prefix, foot) {
    const rest = [];
    errors.forEach((e) => {
      const name = prefix && e.field.startsWith(prefix) ? e.field.slice(prefix.length) : e.field;
      const wrap = form.querySelector(`[data-field="${name}"]`) || form.querySelector(`[data-field="${name.split('.').slice(0, 2).join('.')}"]`);
      if (!wrap) { rest.push(e.message); return; }
      wrap.querySelector('.profile-error').textContent = e.message;
      const control = wrap.querySelector('input, select, textarea');
      if (control) control.setAttribute('aria-invalid', 'true');
    });
    foot.textContent = rest.join(' ');
  }

  /* ---------- 2  the products ---------- */

  function badgeFor(p) {
    if (p.comparable) return ['Measurements checked', 'compare-badge compare-badge--good'];
    if (!p.verified) return ['Not checked yet', 'compare-badge'];
    return ['Body chart only — can’t compare', 'compare-badge'];
  }

  function renderProducts() {
    const list = $('product-list');
    const mine = products.filter((p) => p.category === type);
    list.replaceChildren(...mine.map((p) => {
      const li = el('li');
      const button = el('button', 'compare-product');
      button.type = 'button';
      button.dataset.product = p.id;
      button.setAttribute('aria-pressed', String(selected === p.id));
      const [badge, cls] = badgeFor(p);
      button.append(el('span', 'compare-product-brand', p.brand), el('span', 'compare-product-name', p.name), el('span', cls, badge));
      li.append(button);
      return li;
    }));
    if (!mine.length) list.append(el('li', 'detail-text', `Fynd has no ${TYPES[type]}s with sizing yet.`));
  }

  /* ---------- 3  the comparison ---------- */

  async function loadComparison(id, unit) {
    selected = id;
    renderProducts();
    const result = await global.Account.sizing.compare(id, unit || showUnit);
    if (!result.ok || !result.data || !result.data.comparison) {
      note(`The comparison could not be loaded. ${failure(result, 'Try again in a moment.')}`, true);
      return;
    }
    comparison = result.data.comparison;
    const d = result.data.decision;
    decision = d && typeof d === 'object' && ['OK', 'NO_MATCH', 'INSUFFICIENT_DATA'].includes(d.outcome) ? d : null;
    renderComparison();
    renderFeedback();
  }

  function cellFor(d) {
    const td = el('td');
    if (!d) return td;
    if (!d.compared) {
      td.append(el('span', 'compare-value', d.candidate !== null && d.candidate !== undefined ? measure(d.candidate, comparison.unit) : '—'));
      td.append(el('span', 'compare-diff compare-diff--none', 'not compared'));
      return td;
    }
    td.append(el('span', 'compare-value', measure(d.candidate, comparison.unit)));
    td.append(el('span', 'compare-diff', d.words.replace(/^[^:]+: /, '')));
    return td;
  }

  function renderComparison() {
    const c = comparison;
    const product = products.find((p) => p.id === selected) || {};
    show('result-section', true);
    $('result-title').textContent = `${c.product ? `${c.product.brand} ${c.product.name}` : `${product.brand} ${product.name}`}: each size`;
    const insufficient = c.status === 'insufficient';
    /* a size is recommended only when the decision says OK; otherwise the decision's own words say why not */
    const ok = Boolean(decision && decision.outcome === 'OK');
    const why = decision && Array.isArray(decision.messages) ? decision.messages.filter((m) => typeof m === 'string') : [];
    $('result-summary').textContent = insufficient ? `${c.missing[0].message}${c.next && c.next.length ? ` ${c.next.join(' ')}` : ''}`
      : ok ? c.summary : (why.join(' ') || 'No size recommendation for this item.');
    /* a reliability belongs to a recommendation: none is said without one */
    $('result-reliability').textContent = insufficient || !ok ? '' : RELIABILITY[c.reliability];
    show('result-reliability', !insufficient && ok);
    show('result-units', !insufficient);
    show('result-table-wrap', !insufficient);
    doc.querySelectorAll('input[name="showUnit"]').forEach((r) => { r.checked = r.value === c.unit; });

    const body = $('result-table').querySelector('tbody');
    body.replaceChildren();
    if (!insufficient) {
      const refRow = el('tr', 'compare-row--reference');
      const th = el('th', null, 'Your reference');
      th.scope = 'row';
      refRow.append(th, ...DIMS.map((d) => el('td', null, measure(c.reference.values[d], c.unit))));
      body.append(refRow);
      c.sizes.forEach((s) => {
        const tr = el('tr');
        const head = el('th', null, s.size);
        head.scope = 'row';
        if (ok && s.size === decision.size) { tr.className = 'compare-row--best'; head.append(el('span', 'compare-tag', 'Recommended')); }
        else if (decision && decision.outcome === 'NO_MATCH' && s.size === decision.closest) { tr.className = 'compare-row--best'; head.append(el('span', 'compare-tag', 'Closest — not recommended')); }
        tr.append(head, ...DIMS.map((d) => cellFor(s.dimensions[d])));
        body.append(tr);
      });
    }

    const missing = $('result-missing');
    missing.replaceChildren(...(c.notCompared || []).map((x) => el('li', null, `${DIM_LABEL[x.dim]}: not compared — ${x.why}.`)));

    const ctx = c.context || {};
    const list = $('result-context-list');
    list.replaceChildren();
    const add = (label, value) => { if (value) list.append(el('dt', null, label), el('dd', null, value)); };
    const p = ctx.product || ctx;
    if (p && (p.fabric || p.stretch)) {
      add('Its fit, in the brand’s words', p.fit);
      add('Fabric', p.fabric);
      add('Stretch', p.stretch);
      add('Sleeves', p.construction);
      add('Construction', p.constructionNotes);
    }
    if (ctx.reference) {
      add('Your reference’s fabric', ctx.reference.fabric);
      add('Your reference’s stretch', ctx.reference.stretch);
    } else if (!insufficient) {
      add('Your reference’s fabric', 'not known — Fynd only knows what you measured');
    }
    show('result-context', list.children.length > 0);

    $('result-method').textContent = c.method || '';
    $('result-caveats').replaceChildren(...(c.caveats || []).concat(c.notes || []).map((x) => el('li', null, x)));
    show('result-caveats-wrap', Boolean(c.method || (c.caveats && c.caveats.length)));
    const url = (c.product && c.product.url) || product.url;
    $('result-link').href = url || '#';
    show('result-link', Boolean(url));
  }

  /* ---------- 4  fit feedback ---------- */

  const ISSUE_WORDS = { 'too-wide': 'too wide', 'too-narrow': 'too narrow', 'too-long': 'too long', 'too-short': 'too short' };

  function describeEntry(e) {
    const how = e.asExpected === true ? 'fitted as expected' : e.asExpected === false
      ? `didn’t fit as expected${e.issues && e.issues.length ? `: ${e.issues.map((x) => ISSUE_WORDS[x]).join(', ')}` : ''}`
      : `overall ${String(e.overall || '').replace('-', ' ')}`;
    return `${e.sizeTried} — ${how}${e.notes ? ` · “${e.notes}”` : ''}${e.reference ? ' · compared with your reference' : ''}`;
  }

  function renderFeedback() {
    const product = products.find((p) => p.id === selected);
    if (!product) { show('feedback-section', false); return; }
    show('feedback-section', true);
    const sizes = product.sizes || [];
    const pick = $('fb-size');
    pick.replaceChildren(new Option('Choose', ''), ...sizes.map((s) => new Option(s, s)));
    pick.disabled = false;
    const named = decision && (decision.outcome === 'OK' ? decision.size : decision.outcome === 'NO_MATCH' ? decision.closest : null);
    if (named) pick.value = named;
    const mine = feedback.entries.filter((e) => e.productId === selected);
    $('feedback-saved').replaceChildren(...mine.map((e) => {
      const li = el('li', 'compare-feedback-entry');
      li.append(el('span', null, describeEntry(e)));
      const edit = el('button', 'link-btn', 'Edit');
      edit.type = 'button';
      edit.dataset.edit = e.id;
      const del = el('button', 'link-btn', 'Delete');
      del.type = 'button';
      del.dataset.delete = e.id;
      li.append(' ', edit, ' ', del);
      return li;
    }));
    show('fb-consent-wrap', !feedback.consent.store);
    show('fb-reference-wrap', Boolean(anchorOf(type) || anchorOf(type === 'hoodies' ? 'sweatshirts' : 'hoodies')));
    resetFeedbackForm();
  }

  function resetFeedbackForm() {
    editingFeedback = null;
    doc.querySelectorAll('input[name="fbExpected"]').forEach((r) => { r.checked = false; });
    doc.querySelectorAll('input[name="fbIssue"]').forEach((c) => { c.checked = false; });
    $('fb-notes').value = '';
    show('fb-issues-field', false);
    $('fb-save').textContent = 'Save feedback';
    clearErrors($('feedback-form'));
    $('fb-error').textContent = '';
  }

  function editFeedback(id) {
    const e = feedback.entries.find((x) => x.id === id);
    if (!e) return;
    editingFeedback = id;
    $('fb-size').value = e.sizeTried;
    /* an entry stays with its size: a different size is new feedback */
    $('fb-size').disabled = true;
    doc.querySelectorAll('input[name="fbExpected"]').forEach((r) => { r.checked = (r.value === 'yes') === (e.asExpected === true) && e.asExpected !== null; });
    doc.querySelectorAll('input[name="fbIssue"]').forEach((c) => { c.checked = (e.issues || []).includes(c.value); });
    $('fb-notes').value = e.notes || '';
    $('fb-reference').checked = Boolean(e.reference);
    show('fb-issues-field', e.asExpected === false);
    $('fb-save').textContent = 'Update feedback';
    $('fb-size').focus();
  }

  async function submitFeedback(event) {
    event.preventDefault();
    if (busy) return;
    const form = $('feedback-form');
    clearErrors(form);
    $('fb-error').textContent = '';
    const expected = doc.querySelector('input[name="fbExpected"]:checked');
    const entry = {
      productId: selected,
      sizeTried: $('fb-size').value,
      asExpected: expected ? expected.value === 'yes' : null,
      issues: expected && expected.value === 'no' ? Array.from(doc.querySelectorAll('input[name="fbIssue"]:checked')).map((c) => c.value) : [],
      notes: $('fb-notes').value.trim() || null,
      withReference: !$('fb-reference-wrap').hidden && $('fb-reference').checked,
      recommendedSize: decision && decision.outcome === 'OK' ? decision.size : null
    };
    if (!feedback.consent.store) {
      if (!$('fb-consent').checked) { $('fb-error').textContent = 'Tick “Keep my fit feedback on my account” to save it.'; return; }
      const consent = await global.Account.fitProfile.feedback.consent({ store: true });
      if (!consent.ok) { $('fb-error').textContent = failure(consent, 'Your choice was not saved. Try again in a moment.'); return; }
      feedback = consent.data.feedback;
    }
    busy = true;
    $('fb-save').disabled = true;
    const api = global.Account.fitProfile.feedback;
    const result = editingFeedback
      ? await api.update(editingFeedback, Object.assign({}, entry, { productId: undefined, sizeTried: undefined }))
      : await api.add(entry);
    busy = false;
    $('fb-save').disabled = false;
    if (!result.ok) {
      const errors = (result.data && result.data.errors) || [];
      paintErrors(form, errors, '', $('fb-error'));
      if (!errors.length) $('fb-error').textContent = `Your feedback was not saved. ${failure(result, 'Try again in a moment.')}`;
      return;
    }
    feedback = result.data.feedback;
    note(result.data.updated ? 'Your feedback is updated. Thank you.' : 'Your feedback is saved. Thank you.');
    renderFeedback();
  }

  async function deleteFeedback(id) {
    const result = await global.Account.fitProfile.feedback.remove(id);
    if (!result.ok) { note(`Your feedback was not deleted. ${failure(result, 'Try again in a moment.')}`, true); return; }
    feedback = result.data.feedback;
    note('Your feedback is deleted.');
    renderFeedback();
  }

  /* ---------- wiring ---------- */

  function wire() {
    doc.querySelectorAll('input[name="refType"]').forEach((r) => r.addEventListener('change', () => {
      type = r.value;
      selected = null;
      comparison = null;
      decision = null;
      show('result-section', false);
      show('feedback-section', false);
      renderReference();
      renderProducts();
    }));
    $('product-list').addEventListener('click', (event) => {
      const b = event.target.closest('[data-product]');
      if (b) loadComparison(b.dataset.product);
    });
    doc.querySelectorAll('input[name="showUnit"]').forEach((r) => r.addEventListener('change', () => {
      showUnit = r.value;
      if (selected) loadComparison(selected, showUnit);
    }));
    doc.querySelectorAll('input[name="fbExpected"]').forEach((r) => r.addEventListener('change', () => {
      show('fb-issues-field', r.value === 'no' && r.checked);
      if (r.value === 'yes') doc.querySelectorAll('input[name="fbIssue"]').forEach((c) => { c.checked = false; });
    }));
    $('feedback-form').addEventListener('submit', submitFeedback);
    $('feedback-saved').addEventListener('click', (event) => {
      const edit = event.target.closest('[data-edit]');
      const del = event.target.closest('[data-delete]');
      if (edit) editFeedback(edit.dataset.edit);
      if (del) deleteFeedback(del.dataset.delete);
    });
  }

  /* ---------- start ---------- */

  async function start() {
    wire();
    if (!global.Account) { show('compare-loading', false); note('This page did not load completely. Reload it to try again.', true); return; }
    await global.Account.load();
    const state = global.Account.state();
    show('compare-loading', false);
    if (!state || !state.signedIn) { show('compare-signed-out', true); root.dataset.ready = 'true'; return; }
    const [p, list, fb] = await Promise.all([global.Account.fitProfile.read(), global.Account.sizing.products(), global.Account.fitProfile.feedback.read()]);
    if (!p.ok || !list.ok) {
      note(`Your fit profile or Fynd’s product sizing could not be loaded. ${failure(!p.ok ? p : list, 'Reload the page to try again.')}`, true);
      root.dataset.ready = 'true';
      return;
    }
    profile = p.data.profile || Schema.empty();
    products = (list.data.products || []).filter((x) => TYPES[x.category]);
    if (fb.ok && fb.data && fb.data.feedback) feedback = fb.data.feedback;
    /* the type with a reference already, if only one has */
    if (!anchorOf('hoodies') && anchorOf('sweatshirts')) {
      type = 'sweatshirts';
      doc.querySelectorAll('input[name="refType"]').forEach((r) => { r.checked = r.value === type; });
    }
    show('compare-app', true);
    renderReference();
    renderProducts();
    root.dataset.ready = 'true';
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start);
  else start();
})(typeof window !== 'undefined' ? window : globalThis);
