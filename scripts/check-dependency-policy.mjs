import { readFileSync, existsSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
if (!existsSync('package-lock.json')) {
  throw new Error('package-lock.json is required; use npm ci for reproducible installs.');
}

const blockedSpecs = [
  /^\*$/,
  /^latest$/,
  /^next$/,
  /^git\+/,
  /^github:/,
  /^https?:/,
];

const allowedFileDeps = new Set([
  'thallo-healthkit',
  'thallo-live-activity',
  'thallo-watch-bridge',
]);

const sections = ['dependencies', 'devDependencies', 'optionalDependencies'];
const violations = [];

for (const section of sections) {
  const deps = pkg[section] ?? {};
  for (const [name, spec] of Object.entries(deps)) {
    if (typeof spec !== 'string') {
      violations.push(`${section}.${name}: non-string version spec`);
      continue;
    }
    if (spec.startsWith('file:') && allowedFileDeps.has(name)) continue;
    if (blockedSpecs.some(re => re.test(spec))) {
      violations.push(`${section}.${name}: blocked floating/remote spec "${spec}"`);
    }
  }
}

if (violations.length) {
  console.error('[dependency-policy] blocked dependency specs:');
  for (const violation of violations) console.error(` - ${violation}`);
  process.exit(1);
}

console.log('[dependency-policy] package specs are locked by package-lock and avoid blocked floating/remote specs');
