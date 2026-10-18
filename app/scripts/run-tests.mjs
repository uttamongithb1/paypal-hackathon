// Expand test paths in JavaScript so the documented Node >=20.11 baseline works on all shells.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = process.argv[2] ? join('tests', process.argv[2]) : 'tests';
function discover(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = join(dir, entry.name);
    return entry.isDirectory() ? discover(file) : entry.name.endsWith('.test.mjs') ? [file] : [];
  });
}
const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...discover(root).sort()], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
