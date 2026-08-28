/* =========================================================
   Fynd — transactional email

   Two messages: "confirm your address" and "reset your password". Both
   carry a single-use link and nothing else of value.

   ---------------------------------------------------------
   There is no fake sender
   ---------------------------------------------------------
   If no provider is configured, `send` returns
   `{ sent: false, reason: 'not-configured' }` and the endpoints say so
   on screen, in those words. It does not log the message instead, or
   print the link to the console, or return the token to the browser for
   convenience.

   That is not caution for its own sake. A "verification email" that
   goes nowhere leaves accounts stuck unverified with no way out, and it
   looks exactly like a working system until somebody checks their
   inbox. And the two obvious shortcuts — log the link, or hand it back
   in the response — are both a way of publishing a credential that is
   supposed to be seen by one mailbox. So the unconfigured state is
   reported, loudly, and nothing is pretended.

   ---------------------------------------------------------
   Providers
   ---------------------------------------------------------
   Selected by whichever key is present, or named explicitly with
   EMAIL_PROVIDER. Both are one HTTPS POST, so neither needs a package:

     resend     RESEND_API_KEY        https://resend.com
     postmark   POSTMARK_SERVER_TOKEN https://postmarkapp.com

   EMAIL_FROM must be an address on a domain the provider has verified.
   Providers reject anything else, which is the anti-spoofing rule doing
   its job rather than a misconfiguration to work around.

   Adding a third is a `send` function and a line in PROVIDERS.

   ---------------------------------------------------------
   What is never written down
   ---------------------------------------------------------
   The link contains a token, so the message body is never logged. A
   failure logs the provider's name, the HTTP status and its error
   message — never the recipient, the subject, the body or the link.
   ========================================================= */

'use strict';

const FROM = () => String(process.env.EMAIL_FROM || '').trim();
const REPLY_TO = () => String(process.env.EMAIL_REPLY_TO || '').trim();
const BRAND = 'Fynd';

/* ---------------------------------------------------------
   Providers
   --------------------------------------------------------- */

const PROVIDERS = {
  resend: {
    name: 'resend',
    envKey: 'RESEND_API_KEY',
    async deliver(message, key) {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: message.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
          reply_to: message.replyTo || undefined
        })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        return { ok: false, status: response.status, message: payload.message || payload.name || 'rejected' };
      }
      return { ok: true, id: payload.id || null };
    }
  },

  postmark: {
    name: 'postmark',
    envKey: 'POSTMARK_SERVER_TOKEN',
    async deliver(message, key) {
      const response = await fetch('https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: {
          'X-Postmark-Server-Token': key,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify({
          From: message.from,
          To: message.to,
          Subject: message.subject,
          TextBody: message.text,
          HtmlBody: message.html,
          ReplyTo: message.replyTo || undefined,
          MessageStream: process.env.POSTMARK_MESSAGE_STREAM || 'outbound'
        })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        return { ok: false, status: response.status, message: payload.Message || 'rejected' };
      }
      return { ok: true, id: payload.MessageID || null };
    }
  }
};

const keyFor = (provider) => String(process.env[provider.envKey] || '').trim();

/* Which provider this deployment runs, or null.

   An explicit EMAIL_PROVIDER always wins, and one naming a provider
   whose key is missing selects none — so a typo shows up as "email is
   not configured" rather than quietly falling through to another
   provider that happens to have a key set. */
function provider() {
  const named = String(process.env.EMAIL_PROVIDER || '').trim().toLowerCase();
  if (named) {
    const chosen = PROVIDERS[named];
    return chosen && keyFor(chosen) ? chosen : null;
  }
  return Object.values(PROVIDERS).find((candidate) => keyFor(candidate)) || null;
}

/* Configured means a provider AND a from-address: a provider with
   nothing to send from cannot send. */
const configured = () => Boolean(provider() && FROM());

/* Why not, in one word, for the interface to explain. */
function unconfiguredReason() {
  if (!provider()) return 'no-provider';
  if (!FROM()) return 'no-from-address';
  return null;
}

const state = () => ({
  configured: configured(),
  provider: provider() ? provider().name : null,
  reason: unconfiguredReason()
});

/* ---------------------------------------------------------
   The messages
   ---------------------------------------------------------
   Plain, short, and honest about what the link does. Both are sent as
   text and HTML; the HTML is a single-column layout with inline styles,
   because email clients strip stylesheets. */

const esc = (value) => String(value == null ? '' : value)
  .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function layout({ heading, body, action, url, footer }) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#FAFAF9;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAFAF9;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#FFFFFF;border:1px solid #E6E6E3;border-radius:16px;">
        <tr><td style="padding:32px 32px 8px;">
          <div style="font:700 20px/1 Helvetica,Arial,sans-serif;color:#0F4C4C;">${BRAND}</div>
        </td></tr>
        <tr><td style="padding:16px 32px 0;">
          <h1 style="margin:0 0 12px;font:600 22px/1.2 Helvetica,Arial,sans-serif;color:#000000;">${esc(heading)}</h1>
          <p style="margin:0 0 24px;font:400 15px/1.6 Helvetica,Arial,sans-serif;color:#2B2B2B;">${esc(body)}</p>
        </td></tr>
        <tr><td style="padding:0 32px 24px;">
          <a href="${esc(url)}" style="display:inline-block;background:#0F4C4C;color:#FFFFFF;text-decoration:none;font:600 15px/1 Helvetica,Arial,sans-serif;padding:14px 24px;border-radius:12px;">${esc(action)}</a>
        </td></tr>
        <tr><td style="padding:0 32px 32px;">
          <p style="margin:0 0 8px;font:400 13px/1.6 Helvetica,Arial,sans-serif;color:#6B6B6B;">Or paste this into your browser:</p>
          <p style="margin:0 0 20px;font:400 13px/1.6 Helvetica,Arial,sans-serif;color:#0D4444;word-break:break-all;">${esc(url)}</p>
          <p style="margin:0;font:400 13px/1.6 Helvetica,Arial,sans-serif;color:#6B6B6B;">${esc(footer)}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function verificationMessage({ to, name, url, hours }) {
  const greeting = name ? `Hi ${name},` : 'Hi,';
  const footer = `This link works once and expires in ${hours} hours. If you did not create a ${BRAND} account, you can ignore this email — nothing will happen.`;
  return {
    to,
    subject: `Confirm your email for ${BRAND}`,
    text: `${greeting}\n\nConfirm your email address to finish setting up your ${BRAND} account:\n\n${url}\n\n${footer}\n`,
    html: layout({
      heading: 'Confirm your email',
      body: `${greeting} confirm this address to finish setting up your ${BRAND} account.`,
      action: 'Confirm my email',
      url,
      footer
    })
  };
}

function passwordResetMessage({ to, name, url, hours }) {
  const greeting = name ? `Hi ${name},` : 'Hi,';
  const footer = `This link works once and expires in ${hours} hour${hours === 1 ? '' : 's'}. If you did not ask to reset your password, you can ignore this email — your password will not change, and signing in still works.`;
  return {
    to,
    subject: `Reset your ${BRAND} password`,
    text: `${greeting}\n\nUse this link to choose a new ${BRAND} password:\n\n${url}\n\n${footer}\n`,
    html: layout({
      heading: 'Reset your password',
      body: `${greeting} use the button below to choose a new password.`,
      action: 'Choose a new password',
      url,
      footer
    })
  };
}

/* ---------------------------------------------------------
   Sending
   --------------------------------------------------------- */

/* Never throws. A caller's job is to report what happened, not to
   crash: an account has already been created by the time the email is
   attempted, and a provider outage must not turn that into a 500 that
   hides the account it just made. */
async function send(message) {
  const chosen = provider();
  if (!chosen || !FROM()) {
    return { sent: false, reason: unconfiguredReason(), provider: chosen ? chosen.name : null };
  }

  try {
    const result = await chosen.deliver({
      from: FROM(),
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      replyTo: REPLY_TO() || null
    }, keyFor(chosen));

    if (!result.ok) {
      /* provider, status and the provider's own words. Never the
         recipient, the subject, the body or the link. */
      console.error(`Email provider ${chosen.name} refused a message: ${result.status} ${result.message}`);
      return { sent: false, reason: 'provider-refused', provider: chosen.name };
    }

    return { sent: true, reason: null, provider: chosen.name };
  } catch (err) {
    console.error(`Email provider ${chosen.name} could not be reached:`, err && err.message);
    return { sent: false, reason: 'provider-unreachable', provider: chosen.name };
  }
}

module.exports = {
  PROVIDERS,
  provider,
  configured,
  unconfiguredReason,
  state,
  send,
  verificationMessage,
  passwordResetMessage,
  layout
};
