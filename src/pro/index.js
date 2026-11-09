'use strict';
// Hex Viewer Pro in the extension host: the license state, the "this is a Pro feature" explanation, and the
// Get Pro / Enter key commands. Rules: everything that was free stays free; a Pro action without a license
// explains itself once per click (no popup on open, no counter, no reminder); the only outbound action is the
// payment page, opened by the user's click. The key is checked offline and kept in VS Code's SecretStorage.
const crypto = require('crypto');
const { verifyKey, cleanKey } = require('./license');
const KEYS = require('./keys');

const SKU = 'hex-pro';
const SECRET = 'zovo.license.' + SKU;

const FEATURES = {
  templates: {
    title: 'Binary templates and the Structure view',
    detail: 'Hex Viewer Pro reads the file with a template and shows its fields as a tree: names, offsets, values and enums, with a click to select the bytes. 20 templates ship (PNG, JPEG, GIF, BMP, ICO, TIFF, WebP, WAV, FLAC, MP4, ZIP, GZIP, TAR, PDF, SQLite, ELF, PE, Mach-O, Java class, PCAP), and you can add your own as JSON files. Export any struct as JSON or as a C struct.',
  },
  bookmarks: {
    title: 'Bookmarks and notes',
    detail: 'Hex Viewer Pro marks byte ranges with a name, a color and a note, saved per file on this computer. F2 jumps to the next bookmark. Export the list as Markdown.',
  },
  report: {
    title: 'Compare report export',
    detail: 'Hex Viewer Pro writes every differing range of the two files to a text, CSV or JSON report, with offsets, lengths and the bytes on both sides. Works on 4 GB and larger files.',
  },
  findInFiles: {
    title: 'Find bytes in many files',
    detail: 'Hex Viewer Pro searches hex bytes (with ?? wildcards), text or UTF-16 text across the files of the workspace or a folder, and lists every match with its offset. A click opens the file at the match.',
  },
};

function createPro({ vscode, context, prefix = 'hexViewer', productName = 'Hex Viewer', keys = KEYS }) {
  const emitter = new vscode.EventEmitter();
  const state = { licensed: false, payload: null, loaded: false };
  const publicKeys = () => keys.PUBLIC_KEYS.filter(Boolean);

  async function load() {
    try {
      const key = await context.secrets.get(SECRET);
      const r = key ? verifyKey(key, SKU, publicKeys()) : { ok: false };
      state.licensed = !!r.ok; state.payload = r.ok ? r.payload : null;
    } catch { state.licensed = false; }
    state.loaded = true;
    emitter.fire(state.licensed);
    return state.licensed;
  }

  function installId() {
    let id = context.globalState.get('zovo.installId');
    if (!id) { id = crypto.randomUUID(); context.globalState.update('zovo.installId', id); }
    return id;
  }

  /** The payment page with a random install id (no name, no email, nothing about the machine). */
  function paymentUrl() {
    if (!keys.PAYMENT_URL) return '';
    const u = new URL(keys.PAYMENT_URL);
    u.searchParams.set('client_reference_id', installId());
    return u.toString();
  }

  async function getPro() {
    const url = paymentUrl();
    if (!url) {
      await vscode.window.showInformationMessage(`${productName} Pro is not on sale yet. Everything else in ${productName} stays free.`);
      return false;
    }
    return vscode.env.openExternal(vscode.Uri.parse(url));
  }

  async function enterKey() {
    const input = await vscode.window.showInputBox({
      title: `${productName} Pro: enter your license key`,
      prompt: 'Paste the key from the page you saw after paying. It is checked on this computer; nothing is sent.',
      placeHolder: 'eyJza3UiOiJoZXgtcHJvIi...',
      ignoreFocusOut: true,
      validateInput: v => { if (!cleanKey(v)) return null; const r = verifyKey(v, SKU, publicKeys()); return r.ok ? null : r.reason; },
    });
    if (input === undefined || !cleanKey(input)) return false;
    const r = verifyKey(input, SKU, publicKeys());
    if (!r.ok) { vscode.window.showErrorMessage(r.reason); return false; }
    await context.secrets.store(SECRET, cleanKey(input));
    state.licensed = true; state.payload = r.payload;
    emitter.fire(true);
    vscode.window.showInformationMessage(`${productName} Pro is on. Thank you for supporting the project.`);
    return true;
  }

  async function removeKey() {
    const pick = await vscode.window.showWarningMessage(`Remove the ${productName} Pro key from this computer?`, { modal: true }, 'Remove');
    if (pick !== 'Remove') return false;
    await context.secrets.delete(SECRET);
    state.licensed = false; state.payload = null;
    emitter.fire(false);
    return true;
  }

  /** True when licensed. Otherwise explains the feature (modal, only because the user clicked it) and offers both ways in. */
  async function gate(feature) {
    if (state.licensed) return true;
    const f = FEATURES[feature] || { title: 'This feature', detail: '' };
    const pick = await vscode.window.showInformationMessage(`${f.title} is part of ${productName} Pro`, {
      modal: true,
      detail: `${f.detail}\n\nEverything else in ${productName} stays free: viewing, find, go to offset, the data inspector, editing, insert and delete, and compare. Your key is checked on this computer; nothing is sent.`,
    }, 'Get Pro', 'Enter Key');
    if (pick === 'Get Pro') { await getPro(); return false; }
    if (pick === 'Enter Key') return enterKey();
    return false;
  }

  context.subscriptions.push(
    emitter,
    vscode.commands.registerCommand(`${prefix}.getPro`, () => getPro()),
    vscode.commands.registerCommand(`${prefix}.enterLicenseKey`, () => enterKey()),
    vscode.commands.registerCommand(`${prefix}.removeLicenseKey`, () => removeKey()),
  );
  // A key entered in another window shows up here too.
  if (context.secrets.onDidChange) context.subscriptions.push(context.secrets.onDidChange(e => { if (e.key === SECRET) load(); }));
  const ready = load();

  return {
    get licensed() { return state.licensed; },
    ready, gate, getPro, enterKey, removeKey, load,
    onDidChange: emitter.event,
    features: FEATURES,
    get onSale() { return !!keys.PAYMENT_URL; },
  };
}

module.exports = { createPro, FEATURES, SKU };
