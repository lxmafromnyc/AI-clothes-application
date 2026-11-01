/* =========================================================
   Fynd extension — what is read from the page, and nothing more

   fyndCollect runs once in the page open in the active tab, only when
   the shopper presses "Check sizing with Fynd" (popup.js passes it to
   chrome.scripting.executeScript under the activeTab grant that press
   gives). It must stand alone: Chrome serialises the function itself,
   so it may use nothing from outside its own body.

   It reads, as plain text and within fixed limits:
     * the page's address, its canonical address and title
     * the product's name, brand, code and sizes from the page's own
       structured data (JSON-LD), or its og: tags and main heading
     * a fit the page states under a "Fit" label
     * up to 12 tables (<table>, or ARIA role="table"/"grid" built from
       other elements): their cells, caption and the words just before
       them (in a tabbed size guide, its tab's name), whether each is in
       view, and whether it sits in an open dialog (a size guide the
       shopper opened)
     * up to 3 links whose words say "size guide" / "size chart", and
       the words of up to 3 buttons that do (to say what to open)

   It never reads form fields or anything typed, skips any table holding
   a form control, clicks nothing, opens nothing, and runs nothing it
   finds: JSON-LD is parsed as data. What it returns stays in the Fit
   panel (or the popup) unless the shopper chooses "Open in Find Fit".
   ========================================================= */

/* exported fyndCollect */
function fyndCollect() {
  'use strict';
  const MAX_TABLES = 12;
  const MAX_ROWS = 41;
  const MAX_COLUMNS = 12;
  const MAX_CELL = 60;
  /* the same words assets/sizing-tables.js calls a size guide link */
  const GUIDE_WORDS = /\bsize[\s_-]*(guide|chart|table|info|information)\b|\bsizing( guide| chart| info)?\b|\bmeasurement guide\b|\bfind your size\b/i;

  const fold = (s, max) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max || 160);
  const text = (n, max) => (n ? fold(n.textContent, max) : '');
  const meta = (sel) => {
    const m = document.querySelector(sel);
    return m ? fold(m.getAttribute('content'), 200) : '';
  };
  const webUrl = (href) => {
    try {
      const u = new URL(href, location.href);
      return /^https?:$/.test(u.protocol) ? u.href : null;
    } catch (err) {
      return null;
    }
  };

  /* ---- the product, from the page's own structured data ---- */
  /* `from` says where each part came from: the page's structured data
     (JSON-LD), its meta tags, its visible heading or its size picker */
  const product = { name: null, brand: null, code: null, sku: null, color: null, url: null, sizes: [], variants: [], from: {} };
  let fit = null;
  const isProduct = (o) => o && typeof o === 'object' && /Product/.test([].concat(o['@type'] || []).join(' '));
  const str = (v) => (typeof v === 'string' || typeof v === 'number' ? fold(v, 160) || null : null);
  const named = (v) => str(v && typeof v === 'object' ? v.name : v);
  const inStock = (o) => {
    const a = o && typeof o === 'object' ? String(o.availability || '') : '';
    return !a ? null : /InStock|LimitedAvailability|PreOrder|OnlineOnly/i.test(a) ? true : /OutOfStock|SoldOut|Discontinued/i.test(a) ? false : null;
  };
  const addSize = (v, from) => {
    const x = str(v);
    if (x && x.length <= 20 && !product.sizes.includes(x)) { product.sizes.push(x); product.from.sizes = product.from.sizes || from; }
  };
  const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]')).slice(0, 20);
  for (const s of scripts) {
    const raw = s.textContent || '';
    if (raw.length > 300000) continue;
    let data;
    try { data = JSON.parse(raw); } catch (err) { continue; }
    const items = [].concat(data && data['@graph'] ? data['@graph'] : data);
    const found = items.find(isProduct);
    if (!found) continue;
    if (!product.name && str(found.name)) { product.name = str(found.name); product.from.name = 'json-ld'; }
    if (!product.brand && named(found.brand)) { product.brand = named(found.brand); product.from.brand = 'json-ld'; }
    product.code = product.code || str(found.productGroupID) || str(found.productID) || str(found.sku) || str(found.mpn);
    product.sku = product.sku || str(found.sku);
    product.color = product.color || str(found.color);
    product.url = product.url || (typeof found.url === 'string' ? webUrl(found.url) : null);
    [].concat(found.size || []).forEach((v) => addSize(v, 'json-ld'));
    /* each variant: its own size, colour, code and whether it's in stock */
    const variants = [].concat(found.hasVariant || []).filter((v) => v && typeof v === 'object').slice(0, 60);
    variants.forEach((v) => {
      const offer = [].concat(v.offers || [])[0];
      product.variants.push({ sku: str(v.sku), size: str([].concat(v.size || [])[0]), color: str(v.color), available: inStock(offer) });
      [].concat(v.size || []).forEach((x) => addSize(x, 'json-ld'));
    });
    [].concat(found.offers || []).forEach((o) => {
      if (!o || typeof o !== 'object') return;
      [].concat(o.size || []).forEach((x) => addSize(x, 'json-ld'));
      if (o.sku && (o.size || o.color)) product.variants.push({ sku: str(o.sku), size: str([].concat(o.size || [])[0]), color: str(o.color), available: inStock(o) });
    });
    const props = [].concat(found.additionalProperty || []).filter((x) => x && typeof x === 'object');
    const fitProp = props.find((x) => /^fit$/i.test(String(x.name || '')));
    if (fitProp && !fit) fit = str(fitProp.value);
  }
  product.variants = product.variants.slice(0, 60);
  if (product.code) product.from.code = 'json-ld';
  if (!product.name) {
    const og = meta('meta[property="og:title"]');
    const h1 = text(document.querySelector('h1'), 160);
    product.name = og || h1 || null;
    if (product.name) product.from.name = og ? 'meta' : 'heading';
  }
  if (!product.brand) {
    const brandMeta = meta('meta[property="product:brand"]') || meta('meta[itemprop="brand"]') || meta('meta[name="brand"]');
    const brandEl = document.querySelector('[itemprop="brand"]');
    const b = brandMeta || (brandEl ? fold(brandEl.getAttribute('content') || brandEl.textContent, 80) : '');
    if (b) { product.brand = b; product.from.brand = 'meta'; }
  }

  /* ---- the sizes and colour the page offers, from its own pickers ----
     a group the page labels "size" (a fieldset's legend, a radio group's
     or select's label) — each option's words, and whether it's on offer;
     the colour chosen in a group labelled "colour". Nothing is clicked,
     and no value the shopper typed is read: only the options' labels. */
  const labelled = (el) => fold([el.getAttribute('aria-label'), el.getAttribute('name'), el.id, el.querySelector && text(el.querySelector('legend, [role="heading"]'), 40),
    el.getAttribute('aria-labelledby') && text(document.getElementById(el.getAttribute('aria-labelledby')), 40)].filter(Boolean).join(' '), 120);
  const SIZE_GROUP = /\bsize\b/i;
  const COLOUR_GROUP = /\bcolou?r\b/i;
  const LOOKS_SIZE = /^(?:[2-6]?x{0,4}[sml]|xx?s|xx?l|[2-6]xl|one size|os|\d{1,3}(?:\s*[x/×]\s*\d{1,2})?)$/i;
  const optionWords = (el) => fold(el.getAttribute('aria-label') || el.getAttribute('data-size') || el.getAttribute('value') || el.textContent, 20);
  const offered = (el) => !(el.disabled || el.getAttribute('aria-disabled') === 'true' || /\b(disabled|unavailable|sold-?out|out-of-stock)\b/i.test(el.className || ''));
  const pageSizes = [];
  const groups = Array.from(document.querySelectorAll('fieldset, [role="radiogroup"], [role="group"], [role="listbox"], select, [data-size-picker]')).slice(0, 30)
    .filter((g) => SIZE_GROUP.test(labelled(g)) || g.hasAttribute('data-size-picker'));
  groups.forEach((g) => {
    const opts = g.tagName === 'SELECT' ? Array.from(g.options) : Array.from(g.querySelectorAll('input[type="radio"], [role="radio"], [role="option"], button, label')).slice(0, 40);
    opts.forEach((o) => {
      /* a label around its own control: the control says whether it's on offer, so it is read instead */
      if (o.tagName === 'LABEL' && o.querySelector('input, [role="radio"], [role="option"], button')) return;
      const label = o.tagName === 'INPUT' ? (o.id && document.querySelector(`label[for="${CSS.escape(o.id)}"]`)) || o.closest('label') : null;
      let words = o.tagName === 'INPUT' ? fold((label && label.textContent) || o.getAttribute('value'), 20) : optionWords(o);
      words = words.replace(/\s*\((sold out|out of stock|unavailable)\)\s*$/i, '');
      if (!LOOKS_SIZE.test(words) || pageSizes.some((x) => x.size === words)) return;
      pageSizes.push({ size: words, available: offered(o) });
    });
  });
  Array.from(document.querySelectorAll('button[data-size], [role="radio"][data-size]')).slice(0, 40).forEach((o) => {
    const words = fold(o.getAttribute('data-size'), 20);
    if (LOOKS_SIZE.test(words) && !pageSizes.some((x) => x.size === words)) pageSizes.push({ size: words, available: offered(o) });
  });
  product.pageSizes = pageSizes.slice(0, 30);
  if (!product.sizes.length && pageSizes.length) { pageSizes.forEach((x) => addSize(x.size, 'page')); }
  product.sizes = product.sizes.slice(0, 30);
  if (!product.color) {
    const colourGroup = Array.from(document.querySelectorAll('fieldset, [role="radiogroup"], [role="listbox"], [data-colour-picker], [data-color-picker]')).slice(0, 30)
      .find((g) => COLOUR_GROUP.test(labelled(g)) || g.hasAttribute('data-colour-picker') || g.hasAttribute('data-color-picker'));
    const chosen = colourGroup && colourGroup.querySelector('[aria-checked="true"], [aria-pressed="true"], [aria-selected="true"], input[type="radio"]:checked');
    const words = chosen ? fold(chosen.getAttribute('aria-label') || chosen.getAttribute('title') || (chosen.id && (document.querySelector(`label[for="${CSS.escape(chosen.id)}"]`) || {}).textContent) || chosen.getAttribute('value') || chosen.textContent, 40) : '';
    if (words) { product.color = words; product.from.color = 'page'; }
  } else product.from.color = 'json-ld';

  /* ---- a fit the page states under its own "Fit" label ---- */
  if (!fit) {
    for (const label of Array.from(document.querySelectorAll('dt, th')).slice(0, 300)) {
      if (!/^fit:?$/i.test(text(label, 10))) continue;
      const value = label.tagName === 'DT' ? label.nextElementSibling : label.parentElement && label.parentElement.querySelector('td');
      const said = text(value, 40);
      if (said) { fit = said; break; }
    }
  }

  /* ---- tables ---- */
  const inView = (el) => {
    if (!el.getClientRects().length) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };
  /* the tab a tab panel belongs to (role="tab"), by the panel's
     aria-labelledby or the tab's aria-controls: its name, or '' */
  const tabOf = (panel) => {
    if (!panel) return '';
    const ids = fold(panel.getAttribute('aria-labelledby'), 200).split(' ').filter(Boolean);
    const named = ids.map((id) => text(document.getElementById(id), 60)).filter(Boolean).join(' ');
    if (named) return named;
    const tab = panel.id && Array.from(document.querySelectorAll('[role="tab"][aria-controls]')).slice(0, 50)
      .find((t) => t.getAttribute('aria-controls').split(/\s+/).includes(panel.id));
    return text(tab, 60);
  };
  /* the words just before a table: its heading, a tab's name — never
     past another table, so a "Body size" heading over one table doesn't
     speak for the "Product size" table that follows it. In a tab panel,
     only the panel's own words and its tab's name: the tab list beside
     it names every tab, so it would speak for all of them */
  const wordsBefore = (table) => {
    let heading = '';
    const parts = [];
    const panel = table.closest('[role="tabpanel"]');
    const tab = tabOf(panel);
    let node = table;
    for (let steps = 0; node && steps < 12 && parts.join(' ').length < 300; steps++) {
      const prev = node.previousElementSibling;
      if (prev) {
        node = prev;
        if (prev.matches('table, [role="table"], [role="grid"]') || prev.querySelector('table, [role="table"], [role="grid"]')) break;
        if (prev.tagName === 'SCRIPT' || prev.tagName === 'STYLE') continue;
        const t = text(prev, 300);
        if (t) parts.unshift(t);
        if (!heading && /^H[1-6]$/.test(prev.tagName)) heading = t;
      } else {
        if (node.parentElement === panel) break;
        node = node.parentElement;
        if (!node || node === document.body) break;
      }
    }
    const words = fold(parts.join(' '), 300);
    return { before: tab ? fold(`${tab} ${words.slice(-(299 - tab.length))}`, 300) : words.slice(-300), heading: heading || tab || null, tab: tab || null };
  };
  /* A size chart is a <table>, or a grid built from other elements with
     the standard ARIA table roles (role="table" or "grid", its rows
     role="row", its cells role="cell", "gridcell", "columnheader" or
     "rowheader") — how many shops draw theirs. Each is read the same way. */
  const CELL_ROLES = '[role="cell"], [role="gridcell"], [role="columnheader"], [role="rowheader"]';
  const rowsOf = (table) => (table.tagName === 'TABLE'
    ? Array.from(table.rows).map((tr) => Array.from(tr.cells))
    : Array.from(table.querySelectorAll('[role="row"]')).filter((r) => r.closest('table, [role="table"], [role="grid"]') === table)
      .map((r) => Array.from(r.querySelectorAll(CELL_ROLES)).filter((c) => c.closest('[role="row"]') === r)));
  const tables = [];
  const found = Array.from(document.querySelectorAll('table, [role="table"], [role="grid"]'))
    .filter((t) => t.tagName === 'TABLE' || !t.closest('table'))
    .slice(0, 40);
  for (const table of found) {
    if (tables.length >= MAX_TABLES) break;
    if (table.querySelector('input, select, textarea, button')) continue;
    const rows = rowsOf(table).slice(0, MAX_ROWS)
      .map((cells) => cells.slice(0, MAX_COLUMNS).map((cell) => text(cell, MAX_CELL)))
      .filter((cells) => cells.some(Boolean));
    if (rows.length < 2) continue;
    const around = wordsBefore(table);
    tables.push({
      rows,
      caption: text(table.tagName === 'TABLE' ? table.caption : document.getElementById(table.getAttribute('aria-labelledby') || '') || null, 160) || fold(table.getAttribute('aria-label'), 160) || null,
      before: around.before,
      heading: around.heading,
      tab: around.tab,
      visible: inView(table),
      inDialog: Boolean(table.closest('dialog[open], [role="dialog"], [aria-modal="true"]'))
    });
  }

  /* ---- links to the retailer's own size guide ---- */
  const guides = [];
  for (const a of Array.from(document.querySelectorAll('a[href]')).slice(0, 2000)) {
    if (guides.length >= 3) break;
    const words = `${text(a, 80)} ${fold(a.getAttribute('aria-label'), 80)} ${fold(a.getAttribute('title'), 80)}`;
    if (!GUIDE_WORDS.test(words)) continue;
    const url = webUrl(a.getAttribute('href'));
    if (url && !guides.some((g) => g.url === url)) guides.push({ url, text: text(a, 80) || null });
  }

  /* size-guide buttons (many shops open their guide from a button, not a
     link): their words only, to tell the shopper what to open */
  const guideButtons = [];
  for (const b of Array.from(document.querySelectorAll('button, [role="button"], summary')).slice(0, 2000)) {
    if (guideButtons.length >= 3) break;
    const words = text(b, 80) || fold(b.getAttribute('aria-label'), 80);
    if (words && GUIDE_WORDS.test(words) && !guideButtons.includes(words)) guideButtons.push(words);
  }

  const canonical = document.querySelector('link[rel="canonical"]');
  return {
    url: location.href,
    canonical: canonical ? webUrl(canonical.getAttribute('href')) : null,
    title: fold(document.title, 160) || null,
    retailer: meta('meta[property="og:site_name"]') || location.hostname.replace(/^www\d?\./, ''),
    product,
    fit,
    tables,
    guides,
    guideButtons,
    dialogOpen: Boolean(document.querySelector('dialog[open], [role="dialog"], [aria-modal="true"]'))
  };
}
