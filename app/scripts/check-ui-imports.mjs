/**
 * Static import-graph check for shop/js.
 *
 * The storefront is plain ES modules loaded straight by the browser, with no bundler and no build
 * step. That means a typo in an import — a renamed export, a wrong relative path — produces a blank
 * view and a single console error, and nothing on the server side notices: every API test still
 * passes while the page is dead.
 *
 * This walks every module, resolves every relative import, and asserts each named import is actually
 * exported by its target. Cheap, and it catches the one class of bug the test suite is blind to.
 *
 *   node scripts/check-ui-imports.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'shop', 'js');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));

const source = new Map(files.map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));

/** Every name a module exports, whether declared inline or via an export list. */
function exportsOf(src) {
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  return names;
}

const exported = new Map([...source].map(([f, src]) => [f, exportsOf(src)]));

let problems = 0;
const fail = (msg) => {
  console.log(`  ✗ ${msg}`);
  problems += 1;
};

console.log('\nStorefront import graph\n');

for (const [file, src] of source) {
  for (const m of src.matchAll(/import\s+(?:([A-Za-z0-9_$]+)\s*,\s*)?(?:\{([^}]*)\})?\s*from\s*'(\.[^']+)'/g)) {
    const [, , named = '', spec] = m;
    const target = spec.replace(/^\.\//, '');
    if (!source.has(target)) {
      fail(`${file}: cannot resolve '${spec}'`);
      continue;
    }
    for (const raw of named.split(',')) {
      const name = raw.trim().split(/\s+as\s+/)[0].trim();
      if (!name) continue;
      if (!exported.get(target).has(name)) {
        fail(`${file}: imports {${name}} from '${spec}', which exports [${[...exported.get(target)].join(', ')}]`);
      }
    }
  }
}

if (problems === 0) {
  console.log(`  ✓ ${files.length} modules, every relative import resolves and every named import exists\n`);
} else {
  console.log(`\n  ${problems} problem(s) — a broken import blanks the whole view at runtime.\n`);
  process.exit(1);
}
