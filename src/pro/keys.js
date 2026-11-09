'use strict';
// Public keys that sign Hex Viewer Pro licenses, and the payment page. Set by the release from the shared
// license module (factory/sprint/license, lane PAY1). Only public keys belong here, never a private key.
// __HEXV_TEST_PUBKEY__ is set only by a gate build (scripts/build.js with HEXV_TEST_PUBKEY) so the real
// VS Code check can unlock Pro with a throwaway key; release builds leave it empty.
/* global __HEXV_TEST_PUBKEY__ */
const TEST = typeof __HEXV_TEST_PUBKEY__ !== 'undefined' ? __HEXV_TEST_PUBKEY__ : '';

const PUBLIC_KEYS = [
  // production key from PAY1 goes here
  TEST,
];

// Stripe Payment Link for Hex Viewer Pro (from PAY1). Empty: "Get Pro" says Pro is not on sale yet.
const PAYMENT_URL = '';

module.exports = { PUBLIC_KEYS, PAYMENT_URL };
