'use strict';
// Bundles the extension host and the two webviews with esbuild. No runtime dependencies.
const esbuild = require('esbuild');
const path = require('path');
const root = path.join(__dirname, '..');
const prod = process.argv.includes('--production');
const common = { bundle: true, minify: prod, sourcemap: false, legalComments: 'none', logLevel: 'warning', absWorkingDir: root };
// HEXV_TEST_PUBKEY (SPKI base64): only for a gate build that unlocks Pro with a throwaway key. Release builds leave it unset.
const testKey = process.env.HEXV_TEST_PUBKEY || '';
if (testKey) console.log('GATE BUILD: a test license key is trusted. Do not release this build.');
(async () => {
  await Promise.all([
    esbuild.build({ ...common, entryPoints: ['src/extension.js'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', target: 'node18', external: ['vscode'], define: { __HEXV_TEST_PUBKEY__: JSON.stringify(testKey) } }),
    esbuild.build({ ...common, entryPoints: ['src/webview/main.js'], outfile: 'dist/webview.js', platform: 'browser', format: 'iife', target: 'chrome110' }),
    esbuild.build({ ...common, entryPoints: ['src/webview/compare.js'], outfile: 'dist/compare.js', platform: 'browser', format: 'iife', target: 'chrome110' }),
  ]);
  const fs = require('fs');
  const kb = f => (fs.statSync(path.join(root, f)).size / 1024).toFixed(0) + ' KB';
  console.log(`built: extension ${kb('dist/extension.js')}, webview ${kb('dist/webview.js')}, compare ${kb('dist/compare.js')}`);
})().catch(e => { console.error(e); process.exit(1); });
