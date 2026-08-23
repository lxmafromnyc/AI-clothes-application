/* =========================================================
   FindWear — search attachments

   Lets someone drop photos or documents onto the search box, or pick
   them with a button, and shows what they attached before they search.

   ---------------------------------------------------------
   What this does and does not do
   ---------------------------------------------------------
   Files are held in the page and nothing is sent anywhere until the
   search is submitted. Even then only a manifest travels — each file's
   name, type and size — because nothing on the server can read a file
   yet. The bytes stay in the browser.

   That is deliberate. Sending megabytes to an endpoint that discards
   them would cost the shopper's bandwidth and put their photos on a
   server for no purpose. When the backend can actually use them,
   `manifest()` is the one function that has to change.

   The interface says so too: an attached file is never presented as
   something that influenced the results.

   ---------------------------------------------------------
   Limits
   ---------------------------------------------------------
   Checked here, in the browser, so someone learns immediately rather
   than after a failed request. A server that later accepts uploads must
   check them again — a client-side limit is a courtesy, not a control.
   ========================================================= */

(function (global) {
  'use strict';

  const MAX_FILES = 8;
  const MAX_FILE_BYTES = 10 * 1024 * 1024;   /* 10 MB each */
  const MAX_TOTAL_BYTES = 40 * 1024 * 1024;  /* 40 MB together */

  /* Types that can be shown as a picture, and types that can only be
     named. Both are accepted; only the first gets a thumbnail. */
  const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/heic', 'image/heif', 'image/bmp'];
  const DOC_TYPES = [
    'application/pdf', 'text/plain', 'text/csv', 'application/rtf', 'text/rtf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.oasis.opendocument.text'
  ];

  /* Some browsers hand over an empty `type` — for a file from a phone,
     or an extension the OS does not know. The extension is then the only
     evidence there is, so it is read rather than rejecting a real photo. */
  const EXT_TYPES = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
    gif: 'image/gif', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif', bmp: 'image/bmp',
    pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', rtf: 'application/rtf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    odt: 'application/vnd.oasis.opendocument.text'
  };

  /* what the file picker offers, and what a drop is checked against */
  const ACCEPT_ATTR = IMAGE_TYPES.concat(DOC_TYPES).join(',') + ',' + Object.keys(EXT_TYPES).map((e) => '.' + e).join(',');

  const extensionOf = (name) => {
    const match = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    return match ? match[1] : '';
  };

  /* The type to judge a file by: what the browser said, or what the
     extension implies when it said nothing. */
  function typeOf(file) {
    const declared = String((file && file.type) || '').toLowerCase();
    if (declared) return declared;
    return EXT_TYPES[extensionOf(file && file.name)] || '';
  }

  const isImage = (file) => IMAGE_TYPES.indexOf(typeOf(file)) !== -1;
  const isDocument = (file) => DOC_TYPES.indexOf(typeOf(file)) !== -1;

  /* A short label for a chip: PDF, JPEG, DOCX. Falls back to the
     extension so an unusual-but-accepted file still reads sensibly. */
  function labelFor(file) {
    const subtype = (typeOf(file).split('/')[1] || '').replace(/^x-/, '');
    /* a short subtype reads well as-is: PDF, PNG, CSV. The Office types
       do not — "vnd.openxmlformats-officedocument…" is not a label — so
       the extension is used, which is what someone would call it. */
    if (subtype && subtype.length <= 5 && !/^vnd\./.test(subtype)) return subtype.toUpperCase();
    const ext = extensionOf(file && file.name);
    if (ext) return ext.toUpperCase();
    return subtype ? subtype.slice(0, 5).toUpperCase() : 'FILE';
  }

  function formatSize(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n < 0) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  }

  /* Judges one file against the rules, in the order someone would care
     about: is it a kind we take, is it too big on its own, does it fit
     alongside what is already attached. Returns null when it is fine. */
  function reject(file, existing) {
    const already = Array.isArray(existing) ? existing : [];

    if (!isImage(file) && !isDocument(file)) {
      return `${file.name} is a ${labelFor(file)} file, which FindWear does not take.`;
    }
    if (Number(file.size) > MAX_FILE_BYTES) {
      return `${file.name} is ${formatSize(file.size)}. The limit is ${formatSize(MAX_FILE_BYTES)} per file.`;
    }
    if (already.length >= MAX_FILES) {
      return `You can attach up to ${MAX_FILES} files.`;
    }
    const total = already.reduce((sum, f) => sum + Number(f.size || 0), 0) + Number(file.size || 0);
    if (total > MAX_TOTAL_BYTES) {
      return `That would be ${formatSize(total)} altogether. The limit is ${formatSize(MAX_TOTAL_BYTES)}.`;
    }
    return null;
  }

  /* Same file dropped twice is the same file. Name, size and last
     modified together are as close to identity as a browser offers. */
  const identityOf = (file) => `${file.name}|${file.size}|${file.lastModified || 0}`;

  /* Sorts a batch into what can be kept and what cannot, applying the
     limits cumulatively so the second of two oversized files is judged
     against the first having been accepted. */
  function sift(files, existing) {
    const kept = [];
    const errors = [];
    const seen = new Set((existing || []).map(identityOf));

    for (const file of Array.from(files || [])) {
      if (seen.has(identityOf(file))) continue;             /* already attached */
      const problem = reject(file, (existing || []).concat(kept));
      if (problem) { errors.push(problem); continue; }
      seen.add(identityOf(file));
      kept.push(file);
    }
    return { kept, errors };
  }

  /* What travels with the search. Names, types and sizes only — never
     the contents, which nothing can read yet. */
  const manifest = (files) => (files || []).map((file) => ({
    name: String(file.name || ''),
    type: typeOf(file),
    size: Number(file.size) || 0,
    kind: isImage(file) ? 'image' : 'document'
  }));

  const LOGIC = {
    MAX_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES, ACCEPT_ATTR,
    typeOf, isImage, isDocument, labelFor, formatSize, reject, sift, manifest, identityOf
  };

  /* ---------------------------------------------------------
     The control
     --------------------------------------------------------- */

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function create(options) {
    const opts = options || {};
    const zone = opts.zone;
    const input = opts.input;
    const listEl = opts.list;
    const errorEl = opts.error;
    if (!zone || !input || !listEl) return null;

    let files = [];
    /* object URLs have to be handed back or the page holds the file in
       memory for as long as it is open */
    const previews = new Map();

    const setError = (message) => {
      if (!errorEl) return;
      errorEl.textContent = message || '';
      errorEl.classList.toggle('show', Boolean(message));
    };

    function render() {
      listEl.hidden = files.length === 0;
      listEl.innerHTML = files.map((file, i) => {
        const thumb = isImage(file)
          ? `<img class="attachment-thumb" src="${esc(previews.get(identityOf(file)) || '')}" alt="">`
          : `<span class="attachment-kind">${esc(labelFor(file))}</span>`;
        return `<li class="attachment" data-index="${i}">
          ${thumb}
          <span class="attachment-meta">
            <span class="attachment-name" title="${esc(file.name)}">${esc(file.name)}</span>
            <span class="attachment-size">${esc(labelFor(file))} &middot; ${esc(formatSize(file.size))}</span>
          </span>
          <button class="attachment-remove" type="button" data-remove="${i}" aria-label="Remove ${esc(file.name)}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        </li>`;
      }).join('');
      if (typeof opts.onChange === 'function') opts.onChange(files.slice());
    }

    function add(fileList) {
      const { kept, errors } = sift(fileList, files);
      kept.forEach((file) => {
        if (isImage(file) && global.URL && global.URL.createObjectURL) {
          previews.set(identityOf(file), global.URL.createObjectURL(file));
        }
      });
      files = files.concat(kept);
      setError(errors.length ? errors[0] : '');
      render();
      return kept.length;
    }

    function removeAt(index) {
      const file = files[index];
      if (!file) return;
      const key = identityOf(file);
      if (previews.has(key)) {
        if (global.URL && global.URL.revokeObjectURL) global.URL.revokeObjectURL(previews.get(key));
        previews.delete(key);
      }
      files.splice(index, 1);
      setError('');
      render();
    }

    function clear() {
      previews.forEach((url) => { if (global.URL && global.URL.revokeObjectURL) global.URL.revokeObjectURL(url); });
      previews.clear();
      files = [];
      setError('');
      render();
    }

    /* --- drag and drop ---
       dragenter/dragover both have to be cancelled or the browser opens
       the file instead of letting the page have it. A counter keeps the
       highlight steady while the pointer crosses child elements, which
       each fire their own leave event. */
    let depth = 0;
    const isFileDrag = (e) => Boolean(e.dataTransfer) &&
      Array.from(e.dataTransfer.types || []).indexOf('Files') !== -1;

    zone.addEventListener('dragenter', (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      depth += 1;
      zone.classList.add('is-dragover');
    });
    zone.addEventListener('dragover', (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      zone.classList.add('is-dragover');
    });
    zone.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) zone.classList.remove('is-dragover');
    });
    zone.addEventListener('drop', (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      depth = 0;
      zone.classList.remove('is-dragover');
      add(e.dataTransfer.files);
    });

    /* --- the picker --- */
    input.setAttribute('accept', ACCEPT_ATTR);
    input.setAttribute('multiple', 'multiple');
    input.addEventListener('change', () => {
      add(input.files);
      /* cleared so choosing the same file twice in a row still fires */
      input.value = '';
    });

    listEl.addEventListener('click', (e) => {
      const button = e.target.closest && e.target.closest('[data-remove]');
      if (!button) return;
      removeAt(Number(button.getAttribute('data-remove')));
    });

    render();

    return {
      add,
      removeAt,
      clear,
      files: () => files.slice(),
      count: () => files.length,
      manifest: () => manifest(files)
    };
  }

  global.Attachments = Object.assign({ create }, LOGIC);
  if (typeof module !== 'undefined' && module.exports) module.exports = global.Attachments;
})(typeof window !== 'undefined' ? window : globalThis);
