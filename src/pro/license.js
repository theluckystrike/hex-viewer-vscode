'use strict';
// Offline license check for Zovo Pro add-ons. Two key layouts are accepted:
//   "<payload>.<signature>"           signature: Ed25519 over the payload bytes
//   "<PREFIX>.<payload>.<signature>"  signature: Ed25519 over the ASCII text "<PREFIX>.<payload>" (as in the
//                                     XLSX viewer's TVPRO1 keys), for example ZPRO1.<payload>.<sig>
// The payload is base64url JSON with the product in "sku" or "product", and an optional end date in "exp"
// (seconds, milliseconds or a date) or "expires" (YYYY-MM-DD or null for lifetime). Only public keys ship
// in the extension; the private key never leaves the signing service. No network: the check runs on this machine.
// Kept free of the vscode module so tests can call it. When the shared module factory/sprint/license lands, its
// verify() replaces this file with the same exports.
const crypto = require('crypto');

// SKUs that unlock a product: its own SKU and the all-products bundle.
const BUNDLES = ['zovo-pro', 'zovo-all'];

const b64u = s => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/** Pull the key out of pasted text: tolerates spaces, line breaks, quotes and a "key:" prefix. */
function cleanKey(text) {
  const t = String(text || '').trim().replace(/^["'`]|["'`]$/g, '').replace(/^[A-Za-z ]*key\s*[:=]\s*/i, '').replace(/\s+/g, '');
  return t.length > 4096 ? '' : t;
}

/**
 * Check `text` against `publicKeys` (PEM or base64 DER SPKI) for `sku`. Returns { ok: true, payload } or
 * { ok: false, reason } with a sentence a user can act on.
 */
function verifyKey(text, sku, publicKeys, now = Date.now()) {
  const key = cleanKey(text);
  const m = /^(?:([A-Z][A-Z0-9]{1,15})\.)?([A-Za-z0-9_-]{8,})\.([A-Za-z0-9_-]{40,})$/.exec(key);
  if (!m) return { ok: false, reason: 'This does not look like a license key. Copy the whole key from the page you saw after paying.' };
  const body = b64u(m[2]), sig = b64u(m[3]);
  const signed = m[1] ? Buffer.from(`${m[1]}.${m[2]}`, 'ascii') : body;
  let good = false;
  for (const pk of publicKeys || []) {
    try {
      const k = /BEGIN PUBLIC KEY/.test(pk) ? crypto.createPublicKey(pk) : crypto.createPublicKey({ key: Buffer.from(pk, 'base64'), format: 'der', type: 'spki' });
      if (sig.length === 64 && crypto.verify(null, signed, k, sig)) { good = true; break; }
    } catch { /* a bad key in the list is skipped */ }
  }
  if (!good) return { ok: false, reason: 'This key is not valid. It may be cut off or changed. Copy it again from the page you saw after paying.' };
  let p;
  try { p = JSON.parse(body.toString('utf8')); } catch { return { ok: false, reason: 'This key is damaged.' }; }
  const product = p && (typeof p.sku === 'string' ? p.sku : p.product);
  if (typeof product !== 'string') return { ok: false, reason: 'This key is damaged.' };
  if (product !== sku && !BUNDLES.includes(product)) return { ok: false, reason: `This key is for ${product}, not for this extension.` };
  const end = p.exp !== undefined && p.exp !== null ? p.exp : p.expires;
  if (end !== undefined && end !== null) {
    const exp = typeof end === 'number' ? end * (end < 1e12 ? 1000 : 1) : /^\d{4}-\d{2}-\d{2}$/.test(end) ? Date.parse(end + 'T23:59:59Z') : Date.parse(end);
    if (!Number.isFinite(exp)) return { ok: false, reason: 'This key is damaged.' };
    if (exp < now) return { ok: false, reason: `This key ended on ${new Date(exp).toISOString().slice(0, 10)}. Renew it on the same page where you bought it.`, expired: true, payload: p };
  }
  return { ok: true, payload: p };
}

/** Sign a payload (tests and the signing service only). */
function signKey(payload, privateKeyPem, prefix) {
  const u = b => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const signed = prefix ? Buffer.from(`${prefix}.${u(body)}`, 'ascii') : body;
  const sig = crypto.sign(null, signed, crypto.createPrivateKey(privateKeyPem));
  return `${prefix ? prefix + '.' : ''}${u(body)}.${u(sig)}`;
}

module.exports = { verifyKey, signKey, cleanKey, BUNDLES };
