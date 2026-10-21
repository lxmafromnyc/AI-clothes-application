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
  const product = { name: null, brand: null, code: null, sizes: [] };
  let fit = null;
  const isProduct = (o) => o && typeof o === 'object' && /Product/.test([].concat(o['@type'] || []).join(' '));
  const str = (v) => (typeof v === 'string' || typeof v === 'number' ? fold(v, 160) || null : null);
  const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]')).slice(0, 20);
  for (const s of scripts) {
    const raw = s.textContent || '';
    if (raw.length > 300000) continue;
    let data;
    try { data = JSON.parse(raw); } catch (err) { continue; }
    const items = [].concat(data && data['@graph'] ? data['@graph'] : data);
    const found = items.find(isProduct);
    if (!found) continue;
    product.name = product.name || str(found.name);
    const brand = found.brand;
    product.brand = product.brand || str(brand && typeof brand === 'object' ? brand.name : brand);
    product.code = product.code || str(found.sku) || str(found.productID) || str(found.mpn) || str(found.productGroupID);
    const add = (v) => { const x = str(v); if (x && x.length <= 20 && !product.sizes.includes(x)) product.sizes.push(x); };
    [].concat(found.size || []).forEach(add);
    [].concat(found.hasVariant || []).forEach((v) => v && typeof v === 'object' && [].concat(v.size || []).forEach(add));
    [].concat(found.offers || []).forEach((o) => o && typeof o === 'object' && [].concat(o.size || []).forEach(add));
    const props = [].concat(found.additionalProperty || []).filter((x) => x && typeof x === 'object');
    const fitProp = props.find((x) => /^fit$/i.test(String(x.name || '')));
    if (fitProp && !fit) fit = str(fitProp.value);
  }
  product.sizes = product.sizes.slice(0, 30);
  if (!product.name) product.name = meta('meta[property="og:title"]') || text(document.querySelector('h1'), 160) || null;

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
