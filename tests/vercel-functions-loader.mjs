/**
 * Node ESM loader that intercepts '@vercel/functions' and wraps waitUntil so
 * the test can observe exactly what promise the handler hands over and prove
 * that promise RESOLVES.
 *
 * It works by resolving '@vercel/functions' to a small LOCAL SHIM module that
 * re-exports everything from the real package but overrides waitUntil.
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

export async function resolve(specifier, context, next) {
  if (specifier === '@vercel/functions') {
    // NOTE: the synchronous writeFileSync below is load-bearing. The loader
    // hook runs on a separate thread from the entry module, so without a
    // synchronous side effect the shim can still be in flight when the entry
    // imports inquiry.mjs - and the handler would bind the REAL waitUntil
    // instead of the wrapper, making the test observe nothing.
    const dir = mkdtempSync(path.join(tmpdir(), 'swain-vf-'));
    const shim = path.join(dir, 'shim.mjs');
    const realUrl = pathToFileURL(
      path.join(REPO, 'node_modules/@vercel/functions/index.js')).href;
    const realMod = await import(realUrl);
    // Only real ESM named exports are re-exportable; CJS interop names like
    // 'module.exports' are not valid ESM export names.
    const exportNames = Object.keys(realMod).filter((k) =>
      k !== 'waitUntil' && k !== 'default' &&
      /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) && k !== 'module.exports');
    const namedBlock = exportNames.map((k) => '  ' + k + ',').join('\n');
    writeFileSync(shim, `
import * as real from ${JSON.stringify(realUrl)};
// Re-export everything EXCEPT waitUntil, then export our wrapper. A plain
// 'export *' would re-export the real waitUntil and our explicit export would
// be shadowed by it, so we list the names explicitly.
export const {
${namedBlock}
} = real;
export default real.default;
export function waitUntil(promise) {
  globalThis.__OBSERVED_WAIT_UNTIL = {
    gotPromise: Boolean(promise && typeof promise.then === 'function'),
  };
  const p = Promise.resolve(promise);
  p.then(
    (v) => { globalThis.__WAIT_UNTIL_RESULT = { ok: true, value: v }; },
    (e) => { globalThis.__WAIT_UNTIL_RESULT = { ok: false, error: String(e && e.message) }; },
  );
  return real.waitUntil ? real.waitUntil(p) : p;
}
`);
    return { url: pathToFileURL(shim).href, shortCircuit: true };
  }
  return next(specifier, context);
}
