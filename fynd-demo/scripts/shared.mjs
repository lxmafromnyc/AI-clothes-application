/* What the collector and the fixture share: where things live, the
   site's own ways of writing a price and a seller, and what Fynd read
   from a request — taken from the site's code, so the film says exactly
   what the site would. */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');            /* fynd-demo/ */
export const REPO = path.resolve(ROOT, '..');            /* the site */
export const PUBLIC = path.join(ROOT, 'public');

/* the three searches the film is made of, by the slot the recorder
   saved them under */
export const SLOTS = { everyday: 'hoodie', different: 'dress', brand: 'bag' };

/* assets/app.js formatPrice: cents kept, whole amounts whole */
export function formatPrice(value) {
  if (value == null) return '';
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return '$' + (Number.isInteger(n) ? String(n) : n.toFixed(2));
}

/* assets/app.js productCard + soldAt: the top line is the brand where
   the source gives one, otherwise the retailer; the last line says where
   the link goes */
export function cardLines(item) {
  const seller = item.brand || item.retailer || '';
  let where = '';
  if (item.retailer && item.retailer !== seller) where = item.retailer;
  else {
    try { where = new URL(item.productUrl).hostname.replace(/^www\d?\./, ''); } catch (e) { where = ''; }
  }
  return { top: seller, where };
}

/* the site's local interpreter, run as the page runs it */
export function localInterpreter() {
  const g = {};
  g.global = g;
  vm.createContext(g);
  vm.runInContext(fs.readFileSync(path.join(REPO, 'assets', 'interpret.js'), 'utf8'), g);
  return g.Interpreter;
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/* what Fynd read from the request, as the film shows it: only what the
   reading actually holds, in a fixed order */
export function attributesFrom(prefs) {
  if (!prefs) return [];
  const out = [];
  if (prefs.colors && prefs.colors[0]) out.push({ label: 'Colour', value: cap(prefs.colors[0]) });
  if (prefs.fits && prefs.fits[0]) out.push({ label: 'Fit', value: cap(prefs.fits[0]) });
  const garment = (prefs.garments && prefs.garments[0]) || (prefs.categories && prefs.categories[0]);
  if (garment) out.push({ label: 'Garment', value: cap(garment) });
  if (prefs.maxPrice) out.push({ label: 'Budget', value: `Under ${formatPrice(prefs.maxPrice)}` });
  return out;
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
