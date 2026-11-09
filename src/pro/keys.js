'use strict';
// Build-time settings for Zovo Pro in Hex Viewer. The live public key is inside src/license/license.js (shared
// module); nothing here may hold a private key.
// TEST_PUBKEY is set only in a gate build (scripts/build.js with HEXV_TEST_PUBKEY, an SPKI base64 key): it replaces
// the live key and allows test-mode keys, so the real VS Code check can unlock Pro with a throwaway key.
// Release builds leave it empty.
/* global __HEXV_TEST_PUBKEY__ */
const TEST_PUBKEY = typeof __HEXV_TEST_PUBKEY__ !== 'undefined' ? __HEXV_TEST_PUBKEY__ : '';

// "Get Pro" page. undefined: the shared module's default (the Zovo Pro tier on GitHub Sponsors, USD 19 once).
// A Stripe Payment Link or https://license.zovo.one/buy/hex-pro goes here when that rail is live. '' = not on sale.
const PAYMENT_URL = undefined;

module.exports = { TEST_PUBKEY, PAYMENT_URL };
