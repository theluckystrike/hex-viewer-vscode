'use strict';
// Hex Viewer's Pro layer on top of the shared Zovo license module (src/license, copied unchanged from
// factory/sprint/license). The module answers isPro('hex-pro') from local caches (GitHub Sponsors unlock or an
// offline ZOVO1 license key) and owns the unlock, Get Pro and remove commands. This file adds what is Hex-specific:
// the feature texts and 3 free tries per feature.
// Rules: everything that was free stays free; nothing about Pro shows on open; a Pro feature explains itself only
// after the user clicks it with no free tries left; no network except what the user starts (the GitHub Sponsors
// unlock, or a page opened in the browser).
const { createLicense } = require('../license');
const KEYS = require('./keys');

const SKU = 'hex-pro';
// Try before buying: each Pro feature works this many times on this computer without unlocking (a local counter,
// no network, no timer). After that a click explains the feature and offers the ways to unlock.
const TRIAL_USES = 3;
const TRIAL_KEY = 'hexViewer.proTrial';

const FEATURES = {
  templates: {
    // 0.3.4 (EXEC13): the top level of the Structure view is free; this is the nested part
    title: 'Nested fields in the Structure view',
    detail: 'The Structure view shows the top level of every template for free. Zovo Pro opens every nested field: ELF program and section headers, symbol and dynamic tables, PE sections, imports and resources, Mach-O load commands, DEX and WebAssembly tables, device tree nodes, and more. Click a field to select its bytes, and export any struct as JSON or as a C struct. 26 templates ship (firmware: UF2, device tree, U-Boot uImage, Android boot.img; code: ELF, PE, Mach-O, WebAssembly, DEX, Java class; files: PNG, ZIP, PDF, SQLite, PCAP and more), and you can add your own as JSON files.',
  },
  bookmarks: {
    title: 'Bookmarks and notes',
    detail: 'Marks byte ranges with a name, a color and a note, saved per file on this computer. F2 jumps to the next bookmark. Export the list as Markdown.',
  },
  checksums: {
    title: 'Checksums',
    detail: 'Computes CRC-32, Adler-32, MD5, SHA-1, SHA-256 and SHA-512 of the selection or the whole file in one pass, 4 GB files included. Click a value to copy it.',
  },
  report: {
    title: 'Compare report export',
    detail: 'Writes every differing range of the two files to a text, CSV or JSON report, with offsets, lengths and the bytes on both sides. Works on 4 GB and larger files.',
  },
  findInFiles: {
    title: 'Find bytes in many files',
    detail: 'Searches hex bytes (with ?? wildcards), text or UTF-16 text across the files of the workspace or a folder, and lists every match with its offset. A click opens the file at the match.',
  },
};

// The facade (src/license) adds the "How to buy" paragraph: the USD 19 tier on GitHub Sponsors, PayPal USD 19 or
// USD 59 for a team of 5 (CONV2).
const PRICE_LINE = 'Zovo Pro is USD 19 once, for life, and unlocks the Pro features in every Zovo viewer. Unlock with GitHub Sponsors asks GitHub one question and sends nothing else.';
// EXEC13: one price comparison, shown only in this Pro panel (never on open, never in the README). Prices fetched from
// sweetscape.com/store on 2026-11-10 (010 Editor New User: USD 59.95 Home/Academic, USD 149.95 Commercial). Set it to
// '' when the page shows other prices.
const ANCHOR_LINE = '010 Editor costs USD 59.95 (home) or 149.95 (commercial); Zovo Pro is USD 19 once.';

function createPro({ vscode, context, prefix = 'hexViewer', productName = 'Hex Viewer', keys = KEYS, license }) {
  const emitter = new vscode.EventEmitter();
  const opts = { vscode, context, sku: SKU, name: 'Zovo', product: productName, commandPrefix: prefix };
  if (typeof keys.PAYMENT_URL === 'string') opts.paymentUrl = keys.PAYMENT_URL;
  if (keys.TEST_PUBKEY) { opts.publicKey = keys.TEST_PUBKEY; opts.allowTest = true; } // gate builds only
  const lic = license || createLicense(opts);
  lic.onDidChange(() => emitter.fire(lic.isPro(SKU)));

  const trialUsed = feature => Number((context.globalState.get(TRIAL_KEY) || {})[feature]) || 0;
  const trialLeft = feature => (FEATURES[feature] ? Math.max(0, TRIAL_USES - trialUsed(feature)) : 0);
  const trials = () => Object.fromEntries(Object.keys(FEATURES).map(f => [f, trialLeft(f)]));
  async function useTrial(feature) {
    const m = { ...(context.globalState.get(TRIAL_KEY) || {}) };
    m[feature] = trialUsed(feature) + 1;
    await context.globalState.update(TRIAL_KEY, m);
    const left = trialLeft(feature);
    vscode.window.setStatusBarMessage(`${productName}: free try of ${(FEATURES[feature] || { title: 'this feature' }).title.toLowerCase()}, ${left} left on this computer.`, 6000);
    emitter.fire(lic.isPro(SKU));
  }

  /** Explain a Pro feature (one modal, only after the user clicked it) with the ways to unlock. True when unlocked. */
  async function explain(feature) {
    const f = FEATURES[feature] || { title: 'This feature', detail: '' };
    const tried = trialUsed(feature) >= TRIAL_USES ? `You have used the ${TRIAL_USES} free tries of this feature on this computer.\n\n` : '';
    return lic.requirePro(f.title, `${tried}${f.detail}\n\n${PRICE_LINE}${ANCHOR_LINE ? '\n\n' + ANCHOR_LINE : ''}\n\nEverything else in ${productName} stays free: viewing, find, go to offset, the data inspector, editing, insert and delete, and compare.`);
  }

  /** Licensed, or a free try is left (used up here). Otherwise the explanation. */
  async function gate(feature) {
    if (lic.isPro(SKU)) { lic.refresh(); return true; }
    if (trialLeft(feature) > 0) { await useTrial(feature); return true; }
    return explain(feature);
  }

  /** Licensed or a free try left: the caller asks its questions first and calls useTrial() when the action runs. */
  async function allowed(feature) {
    if (lic.isPro(SKU)) { lic.refresh(); return true; }
    if (trialLeft(feature) > 0) return true;
    return explain(feature);
  }

  context.subscriptions.push(emitter);
  return {
    get licensed() { return lic.isPro(SKU); },
    ready: lic.ready,
    gate, allowed, explain, trialLeft, trials, useTrial,
    getPro: () => lic.getPro(),
    payWithPayPal: () => lic.payWithPayPal(),
    unlock: railId => lic.unlock(railId),
    enterKey: () => lic.unlock('license-key'),
    removeKey: () => lic.remove(),
    handleUri: uri => lic.handleUri(uri),
    onDidChange: emitter.event,
    features: FEATURES,
    license: lic,
    get onSale() { return keys.PAYMENT_URL !== ''; },
  };
}

module.exports = { createPro, FEATURES, SKU, TRIAL_USES, ANCHOR_LINE };
