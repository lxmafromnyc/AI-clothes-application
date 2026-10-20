/* =========================================================
   Fynd extension — the toolbar button

   A press on Fynd's toolbar button opens the Fit panel beside the page
   and asks it to read that page. The press is what gives Fynd access to
   the tab (activeTab): nothing is read before it, and only that tab.

   sidePanel.open() must be called in the click itself, before anything
   is awaited, or Chrome refuses it as not coming from the shopper.

   The panel may not be loaded yet when the press arrives (the first
   press opens it), so the tab is also kept in session storage, which
   the panel reads as it starts. Session storage is memory only: cleared
   when the browser closes, never written to disk or synced.
   ========================================================= */

'use strict';

chrome.action.onClicked.addListener((tab) => {
  const opening = chrome.sidePanel.open({ windowId: tab.windowId });
  const pressed = { tabId: tab.id, windowId: tab.windowId, at: Date.now() };
  chrome.storage.session.set({ fyndPressed: pressed }).catch((err) => console.warn('[Fynd] could not keep the pressed tab', err));
  opening
    .then(() => chrome.runtime.sendMessage({ type: 'fynd:read', tabId: tab.id }))
    /* no panel listening yet: it reads fyndPressed as it starts */
    .catch((err) => { if (!/Receiving end does not exist/.test(String(err && err.message))) console.warn('[Fynd] opening the Fit panel failed', err); });
});
