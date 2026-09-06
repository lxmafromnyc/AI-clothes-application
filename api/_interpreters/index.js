/* =========================================================
   Fynd — interpreter registry (evaluation only)

   /api/interpret runs on OpenAI. It always has, and nothing here
   changes that: this module answers "did somebody explicitly ask for a
   different model", and the answer in production — where AI_PROVIDER is
   not set — is null, which leaves the endpoint on the code path it has
   always been on.

   ---------------------------------------------------------
   How one is selected
   ---------------------------------------------------------
     AI_PROVIDER unset, or "openai"   the built-in OpenAI path, unchanged
     AI_PROVIDER=gemini               api/_interpreters/gemini.js
     AI_PROVIDER=anything-else        nothing, so /api/interpret answers
                                      503 and the page reads the request
                                      locally and says so

   That last rule is the same one api/_providers/product-source.js
   applies to PRODUCT_SOURCE, and for the same reason: a typo should be
   visible as a 503 rather than quietly answered by a different provider
   than the one named.

   An alternative interpreter returns the SAME raw object the OpenAI
   path returns. api/interpret.js shapes it with its own
   shapePreferences(), so the JSON the browser and /api/search receive is
   identical whichever model produced it.

   ---------------------------------------------------------
   Adding one
   ---------------------------------------------------------
     1. write api/_interpreters/<name>.js exporting
        { name, configured(), async interpret({ query, vocabulary, systemPrompt }) }
        where interpret resolves to { ok: true, raw, tokens } or
        { ok: false, reason }
     2. require it below and add it to INTERPRETERS
     3. set its credentials, and AI_PROVIDER=<name>, on the deployment
        that is testing it — never on production

   Removing one is the same three lines in reverse. Removing the whole
   experiment is deleting this directory and the marked block in
   api/interpret.js.
   ========================================================= */

'use strict';

const gemini = require('./gemini');

/* The provider /api/interpret is built around. It has no adapter here
   on purpose: its code stays where it always was, in api/interpret.js. */
const BUILT_IN = 'openai';

const INTERPRETERS = {
  [gemini.name]: gemini
};

/* Selected by a name nothing is registered under. It is configured()
   false, so the endpoint answers 503 — the visible typo above. */
const UNRECOGNISED = Object.freeze({
  name: 'unrecognised',
  configured: () => false,
  async interpret() { return { ok: false, reason: 'not-configured' }; }
});

const text = (v) => (v === undefined || v === null ? '' : String(v).trim());

/* null means "OpenAI, on the built-in path" — the production answer. */
function getInterpreter() {
  const requested = text(process.env.AI_PROVIDER).toLowerCase();
  if (!requested || requested === BUILT_IN) return null;
  return INTERPRETERS[requested] || UNRECOGNISED;
}

module.exports = {
  getInterpreter,
  registerInterpreter: (adapter) => { INTERPRETERS[adapter.name] = adapter; },
  BUILT_IN,
  INTERPRETERS,
  UNRECOGNISED
};
