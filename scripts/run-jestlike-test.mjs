import { pathToFileURL } from 'node:url';
import path from 'node:path';

const testPath = process.argv[2];
if (!testPath) {
  console.error('Usage: node --experimental-strip-types scripts/run-jestlike-test.mjs <test-file>');
  process.exit(1);
}

let failures = 0;
const pending = [];

function format(value) {
  return typeof value === 'string' ? `"${value}"` : JSON.stringify(value);
}

function expect(actual) {
  return {
    toBe(expected) {
      if (actual !== expected) throw new Error(`expected ${format(actual)} to be ${format(expected)}`);
    },
    toEqual(expected) {
      const a = JSON.stringify(actual);
      const b = JSON.stringify(expected);
      if (a !== b) throw new Error(`expected ${a} to equal ${b}`);
    },
    toContain(expected) {
      if (!actual?.includes?.(expected)) throw new Error(`expected ${format(actual)} to contain ${format(expected)}`);
    },
    toBeGreaterThan(expected) {
      if (!(actual > expected)) throw new Error(`expected ${format(actual)} to be greater than ${format(expected)}`);
    },
  };
}

globalThis.expect = expect;
globalThis.describe = (name, fn) => {
  console.log(`\n${name}`);
  fn();
};
globalThis.it = (name, fn) => {
  const run = Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((error) => {
      failures += 1;
      console.error(`  ✗ ${name}`);
      console.error(`    ${error?.message ?? error}`);
    });
  pending.push(run);
};

const absolute = path.resolve(process.cwd(), testPath);
await import(pathToFileURL(absolute).href);
await Promise.all(pending);

if (failures > 0) {
  console.error(`\n${path.basename(testPath)}: ${failures} failed`);
  process.exit(1);
}

console.log(`\n${path.basename(testPath)}: all passed`);
