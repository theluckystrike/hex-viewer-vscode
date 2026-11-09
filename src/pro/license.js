'use strict';
// Offline license check for Zovo Pro add-ons. A key is "<payload>.<signature>", both base64url; the payload is
// JSON { sku, iat, exp?, sid?, eh? } and the signature is Ed25519 over the payload bytes. Only public keys ship
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
  const m = /^([A-Za-z0-9_-]{8,})\.([A-Za-z0-9_-]{40,})$/.exec(key);
  if (!m) return { ok: false, reason: 'This does not look like a license key. Copy the whole key from the page you saw after paying.' };
  const body = b64u(m[1]), sig = b64u(m[2]);
  let good = false;
  for (const pk of publicKeys || []) {
    try {
      const k = /BEGIN PUBLIC KEY/.test(pk) ? crypto.createPublicKey(pk) : crypto.createPublicKey({ key: Buffer.from(pk, 'base64'), format: 'der', type: 'spki' });
      if (crypto.verify(null, body, k, sig)) { good = true; break; }
    } catch { /* a bad key in the list is skipped */ }
  }
  if (!good) return { ok: false, reason: 'This key is not valid. It may be cut off or changed. Copy it again from the page you saw after paying.' };
  let p;
  try { p = JSON.parse(body.toString('utf8')); } catch { return { ok: false, reason: 'This key is damaged.' }; }
  if (!p || typeof p.sku !== 'string') return { ok: false, reason: 'This key is damaged.' };
  if (p.sku !== sku && !BUNDLES.includes(p.sku)) return { ok: false, reason: `This key is for ${p.sku}, not for this extension.` };
  if (p.exp !== undefined) {
    const exp = typeof p.exp === 'number' ? p.exp * (p.exp < 1e12 ? 1000 : 1) : Date.parse(p.exp);
    if (!Number.isFinite(exp)) return { ok: false, reason: 'This key is damaged.' };
    if (exp < now) return { ok: false, reason: `This key ended on ${new Date(exp).toISOString().slice(0, 10)}. Renew it on the same page where you bought it.`, expired: true, payload: p };
  }
  return { ok: true, payload: p };
}

/** Sign a payload (tests and the signing service only). */
function signKey(payload, privateKeyPem) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const sig = crypto.sign(null, body, crypto.createPrivateKey(privateKeyPem));
  const u = b => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${u(body)}.${u(sig)}`;
}

module.exports = { verifyKey, signKey, cleanKey, BUNDLES };
