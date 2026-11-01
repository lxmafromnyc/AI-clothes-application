/* Fynd's site, and its API: the one host the extension talks to (the
   manifest's host_permissions name it, and nothing else). The panel asks
   it for the shopper's saved garments and for the comparison; the shopper
   signs in on the site itself. To try a Vercel preview instead, put its
   address here, add it to host_permissions in manifest.json, and reload
   the extension on chrome://extensions — and the API must allow this
   extension's origin (api/_cors.js). */
const FYND_SITE = 'https://ai-clothes-application.vercel.app';
const FYND_API = FYND_SITE;
