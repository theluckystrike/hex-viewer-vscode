'use strict';
// The USD 299 custom format offer at the moment of need (lane EXEC9, 9 Nov 2026). The same file ships in Hex Viewer
// and DOCX Viewer. One line where the viewer finds no template (Hex) or cannot render a part of the document (DOCX):
// "Request one (free), or we build it for USD 299 once." Rules:
// - The values come from factory/sprint/funding.json (custom_format_*). The line shows only while all three are set,
//   the same rule as support_block.py custom_offer(). Empty one of them there and copy it here to hide the line.
// - At most once per session (one extension host run), only after a user action, never on open, no popup, no toast.
// - No network call. The two links open in the browser only when the user clicks them. The prefilled request never
//   holds a file name or document text: only the product, the file extension or a kind of element, and the editor version.
// EXEC13 (10 Nov 2026, Hex only): a middle option between the free request and USD 299, "Template for your format in
// 2 working days: USD 49, Zovo Pro included" (MONEY5 #4). GitHub Sponsors first ("$49 one time" tier), PayPal second.
// It shows only while template_order_tier and template_order_usd are set in funding.json (and the USD 299 line shows).

// Copied from factory/sprint/funding.json. Never add a URL here that is not in funding.json.
const FUNDING_CUSTOM = {
  "custom_format_tier": "https://github.com/sponsors/theluckystrike/sponsorships?tier_id=679995",
  "custom_format_usd": 299,
  "custom_format_issues": "https://github.com/theluckystrike/zovo-plugin-factory/issues/new?template=format-request.yml",
  "template_order_tier": "https://github.com/sponsors/theluckystrike/sponsorships?tier_id=680220",
  "template_order_usd": 49,
  "paypal_me": "https://www.paypal.com/paypalme/najzzz"
};
const ORDER_TEXT = usd => `Template for your format in 2 working days: USD ${usd}, Zovo Pro included`;

/** { tier, usd, issues }, or null while one of the three values is empty or not the expected kind of link. */
function customOffer(f) {
  const raw = f || FUNDING_CUSTOM;
  const tier = typeof raw.custom_format_tier === 'string' ? raw.custom_format_tier : '';
  const issues = typeof raw.custom_format_issues === 'string' ? raw.custom_format_issues : '';
  const usd = raw.custom_format_usd;
  if (!tier.startsWith('https://github.com/sponsors/') || !issues.startsWith('https://github.com/') || !Number.isInteger(usd) || usd <= 0) return null;
  return { tier, usd, issues };
}

/** { tier, usd, paypal } for the template order, or null while one of its values is empty. paypal may be ''. */
function templateOrder(f) {
  const raw = f || FUNDING_CUSTOM;
  if (!customOffer(raw)) return null;
  const tier = typeof raw.template_order_tier === 'string' ? raw.template_order_tier : '';
  const usd = raw.template_order_usd;
  if (!tier.startsWith('https://github.com/sponsors/') || !Number.isInteger(usd) || usd <= 0) return null;
  const pp = typeof raw.paypal_me === 'string' && raw.paypal_me.startsWith('https://www.paypal.com/paypalme/') ? raw.paypal_me.replace(/\/+$/, '') : '';
  return { tier, usd, paypal: pp ? `${pp}/${usd}USD` : '' };
}

/** The line as parts: plain text and the links ({ link: 'request' | 'order' | 'orderPaypal' | 'tier' }). */
function lineParts(kind, usd, order) {
  if (kind === 'template' && order && order.usd) {
    return [{ text: 'No template for this format. ' }, { link: 'request', text: 'Request one (free)' }, { text: '. ' },
      { link: 'order', text: ORDER_TEXT(order.usd) }, ...(order.paypal ? [{ text: ' (GitHub Sponsors, or ' }, { link: 'orderPaypal', text: 'PayPal' }, { text: ')' }] : []), { text: '. Or ' },
      { link: 'tier', text: `we build it for USD ${usd} once` }, { text: '.' }];
  }
  const lead = kind === 'template' ? 'No template for this format. ' : '';
  const ask = kind === 'template' ? 'Request one (free)' : 'Request support for this (free)';
  return [{ text: lead }, { link: 'request', text: ask }, { text: ', or ' }, { link: 'tier', text: `we build it for USD ${usd} once` }, { text: '.' }];
}
const lineText = (kind, usd, order) => lineParts(kind, usd, order).map(p => p.text).join('');

/** A short, safe label for the request form: letters, digits and a few signs, at most 60 characters. */
function cleanLabel(s) {
  return String(s || '').replace(/[^\w .,+\-/()]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

/** The file extension of a path as ".abc" (lower case), or '' when there is none we can name. */
function extensionOf(p) {
  const base = String(p || '').split(/[\\/]/).pop();
  const m = /^[^.].*\.([A-Za-z0-9_-]{1,16})$/.exec(base);
  return m ? '.' + m[1].toLowerCase() : '';
}

/** The central format request form, prefilled. what = the extension or the kind of element (no file name). */
function requestUrl(offer, { product, what, editor }) {
  const sep = offer.issues.includes('?') ? '&' : '?';
  const w = cleanLabel(what);
  const title = `Format request: ${w || 'a file format'} in ${product}`;
  let u = `${offer.issues}${sep}title=${encodeURIComponent(title)}&viewer=${encodeURIComponent(product)}`;
  if (w) u += `&format=${encodeURIComponent(w)}`;
  if (editor) u += `&editor=${encodeURIComponent(cleanLabel(editor))}`;
  return u;
}

/**
 * One per extension host. claim() hands the line out once per session and returns null after that (and always
 * while a funding value is empty). open(which, ctx) opens the request form or the tier, only for a session that
 * got the line.
 */
function createCustomOffer({ vscode, product, version, funding, withOrder }) {
  const offer = customOffer(funding);
  const order = withOrder ? templateOrder(funding) : null;
  let shown = false;
  const editor = () => `${(vscode && vscode.env && vscode.env.appName) || 'VS Code'} ${(vscode && vscode.version) || ''}, ${product} ${version || ''}`.trim();
  return {
    offer,
    order,
    available: () => !!offer && !shown,
    shown: () => shown,
    claim() {
      if (!offer || shown) return null;
      shown = true;
      return order ? { usd: offer.usd, order: { usd: order.usd, paypal: !!order.paypal } } : { usd: offer.usd };
    },
    url(which, what) {
      if (!offer || !shown) return '';
      if (which === 'order') return order ? order.tier : '';
      if (which === 'orderPaypal') return order && order.paypal ? order.paypal : '';
      return which === 'tier' ? offer.tier : which === 'request' ? requestUrl(offer, { product, what, editor: editor() }) : '';
    },
    open(which, what) {
      const u = this.url(which, what);
      if (!u) return Promise.resolve(false);
      return Promise.resolve(vscode.env.openExternal(vscode.Uri.parse(u, true)));
    },
  };
}

module.exports = { FUNDING_CUSTOM, ORDER_TEXT, customOffer, templateOrder, lineParts, lineText, cleanLabel, extensionOf, requestUrl, createCustomOffer };
