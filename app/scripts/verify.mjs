/**
 * One command that proves the project is sound: the test suite, the money invariants and the
 * recorded test count — with the suite executed exactly once.
 *
 * `npm run verify` used to be `test && ledger`, and the test-count check then re-ran the whole
 * suite a second time to learn how many tests there were. That doubled the wall clock of every
 * CI run for a single number, so the totals are now read off the run that already happened.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSpecTotals, checkCount } from './test-count.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: appRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const capture = (chunk) => {
      output += chunk;
      process.stdout.write(chunk);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.on('close', (code) => resolve({ code, output }));
  });
}

const tests = await run(process.execPath, [
  '--test', '--test-reporter=spec', 'tests/unit', 'tests/integration', 'tests/evals'
]);
if (tests.code !== 0) {
  console.error('\n✖ the test suite failed.');
  process.exit(1);
}

const ledger = await run(process.execPath, ['scripts/ledger-check.mjs']);
if (ledger.code !== 0) {
  console.error('\n✖ the money invariants failed.');
  process.exit(1);
}

const totals = parseSpecTotals(tests.output);
if (!totals.tests) {
  console.error('\n✖ could not read the test totals from the suite output.');
  process.exit(1);
}
if (!checkCount(totals)) {
  console.error('\n✖ the recorded test count is stale.');
  process.exit(1);
}

console.log('\n✓ verified: tests, invariants and the recorded test count all agree.');
