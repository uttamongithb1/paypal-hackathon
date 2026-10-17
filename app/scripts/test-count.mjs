/**
 * One source of truth for "how many tests does this repo have".
 *
 * The count was hardcoded in three places (the storefront build info, the /how-it-works page and
 * the README) and had already drifted twice — 93 → 97 → 104. A stale number on a judge's screen
 * is a false claim about the project, so the number is now generated from the suite itself and
 * `npm run verify` fails when the recorded value does not match reality.
 *
 *   node scripts/test-count.mjs --write   # re-record after adding or removing tests
 *   node scripts/test-count.mjs --check   # what `npm run verify` runs
 *
 * `--counts=<tests>,<suites>` reuses totals from a run that already happened, so the suite is
 * never executed twice in one verification.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(appRoot, 'test-count.json');

/** Run the suite with the TAP reporter and read the totals off the summary. */
export function runSuite() {
  const result = spawnSync(
    process.execPath,
    ['--test', '--test-reporter=tap', 'tests/unit', 'tests/integration', 'tests/evals'],
    { cwd: appRoot, encoding: 'utf8' }
  );
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const tests = Number(output.match(/^# tests (\d+)$/m)?.[1] ?? 0);
  const suites = Number(output.match(/^# suites (\d+)$/m)?.[1] ?? 0);
  const pass = Number(output.match(/^# pass (\d+)$/m)?.[1] ?? 0);
  const fail = Number(output.match(/^# fail (\d+)$/m)?.[1] ?? 0);
  if (!tests) {
    console.error(output.slice(-4000));
    throw new Error('Could not read the test totals from the suite output.');
  }
  return { tests, suites, pass, fail };
}

/** Read the totals out of a spec-reporter run, which prints "ℹ tests N". */
export function parseSpecTotals(output) {
  return {
    tests: Number(output.match(/^(?:#|ℹ)\s*tests\s+(\d+)\s*$/m)?.[1] ?? 0),
    suites: Number(output.match(/^(?:#|ℹ)\s*suites\s+(\d+)\s*$/m)?.[1] ?? 0),
    fail: Number(output.match(/^(?:#|ℹ)\s*fail\s+(\d+)\s*$/m)?.[1] ?? 0)
  };
}

/** Compare the recorded count with the suite's. Returns true when they agree. */
export function checkCount(counts) {
  const existing = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) : null;
  if (!existing || existing.count !== counts.tests) {
    console.error(
      `✖ test-count.json says ${existing?.count ?? 'nothing'}, but the suite runs ${counts.tests} tests.\n`
      + '  Run: node scripts/test-count.mjs --write'
    );
    return false;
  }
  console.log(`✓ test-count.json matches the suite (${counts.tests} tests, ${counts.suites} suites)`);
  return true;
}

export function writeCount(counts) {
  const record = { count: counts.tests, suites: counts.suites, updatedAt: new Date().toISOString() };
  fs.writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`✓ recorded ${record.count} tests across ${record.suites} suites → test-count.json`);
}

/** CLI entry point — only when this file is run directly, never on import. */
function main() {
  const mode = process.argv.includes('--write') ? 'write' : 'check';
  const reuse = process.argv.find((a) => a.startsWith('--counts='))?.slice('--counts='.length);
  const [tests, suites] = reuse ? reuse.split(',').map(Number) : [];
  const counts = reuse ? { tests, suites, fail: 0 } : runSuite();
  if (counts.fail > 0) {
    console.error(`✖ ${counts.fail} test(s) failed — the count was not recorded.`);
    process.exit(1);
  }
  if (mode === 'write') {
    writeCount(counts);
    return;
  }
  process.exit(checkCount(counts) ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
