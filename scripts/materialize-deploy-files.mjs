import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

const root = process.cwd();
const restoreFromHead = process.argv.includes('--restore-from-head');
const restoreFromIpaArgIndex = process.argv.indexOf('--restore-from-ipa');
const restoreFromIpaPath = restoreFromIpaArgIndex >= 0 ? resolve(root, process.argv[restoreFromIpaArgIndex + 1] ?? 'build-latest.ipa') : null;
const restoreFromDirArgIndex = process.argv.indexOf('--restore-from-dir');
const restoreFromDirPath = restoreFromDirArgIndex >= 0 ? resolve(root, process.argv[restoreFromDirArgIndex + 1] ?? '') : null;
const rootFiles = [
  '.easignore',
  '.fingerprintignore',
  'app.config.js',
  'app.json',
  'babel.config.js',
  'eas.json',
  'metro.config.js',
  'package-lock.json',
  'package.json',
  'tsconfig.json',
];
const roots = ['app', 'src', 'public', 'assets', 'modules', 'targets', 'ios'];
const excluded = new Set([
  'assets/full-library.zip',
  'assets/images/card-backgrounds/workout-card-rest-day-male.jpg',
  'assets/images/equipment/pec_deck_machine_alt_2.png',
  'assets/images/equipment/plate_loaded_chest_press_machine_alt_3.png',
  'assets/images/equipment/yoga_mat_alt_1.png',
  'assets/images/landing-photos/pexels-hiking-forest-woman.jpg',
  'assets/images/landing-photos/pexels-neon-gym-woman-11896016.jpg',
  'ios/.xcode.env.local',
  'ios/Thallo/Images.xcassets/SplashScreenLogo.imageset/SplashScreenLogo.png',
  'targets/resttimer-widget/Assets.xcassets/AppIcon.appiconset/ItunesArtwork@2x.png',
]);

const ignoredPrefixes = [
  'assets/test/',
  'ios/Pods/',
  'ios/build/',
  'ios/DerivedData/',
  'dist/',
  'dist-web/',
  'build/',
];

const localFallbacks = new Map([
  [
    'targets/resttimer-widget/Assets.xcassets/AppIcon.appiconset/MarketingIcon-1024.png',
    'targets/resttimer-widget/Assets.xcassets/AppIcon.appiconset/ItunesArtwork@2x.png',
  ],
]);

function normalize(file) {
  return relative(root, file).split(sep).join('/');
}

function isIgnored(relPath) {
  return excluded.has(relPath) || relPath.includes('/__tests__/') || ignoredPrefixes.some((prefix) => relPath.startsWith(prefix));
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = resolve(dir, entry.name);
    const relPath = normalize(fullPath);
    if (isIgnored(relPath)) {
      continue;
    }
    if (entry.isDirectory()) {
      yield* walk(fullPath);
    } else if (entry.isFile()) {
      yield fullPath;
    }
  }
}

function* deployFiles() {
  for (const relPath of rootFiles) {
    if (isIgnored(relPath)) {
      continue;
    }
    const file = resolve(root, relPath);
    try {
      if (statSync(file).isFile()) {
        yield file;
      }
    } catch {}
  }

  for (const rootDir of roots) {
    yield* walk(resolve(root, rootDir));
  }
}

function hasPlaceholderStats(stats) {
  return stats.size > 0 && stats.blocks === 0;
}

function canReadFullFile(file, expectedSize) {
  try {
    const bytes = execFileSync('/bin/cat', [file], {
      cwd: root,
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: Math.max(expectedSize + 1024, 1024 * 1024),
      timeout: 3000,
    });
    return bytes.length === expectedSize;
  } catch {
    return false;
  }
}

function requestProviderDownload(file) {
  return false;
}

function writeAtomically(file, bytes) {
  const temp = `${file}.materialize-${process.pid}.tmp`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(temp, bytes);
  renameSync(temp, file);
}

let indexMetadata = null;

function loadIndexMetadata() {
  if (indexMetadata) {
    return indexMetadata;
  }

  indexMetadata = new Map();
  let index;
  try {
    index = readFileSync(resolve(root, '.git/index'));
  } catch {
    return indexMetadata;
  }

  if (index.toString('utf8', 0, 4) !== 'DIRC') {
    return indexMetadata;
  }

  const version = index.readUInt32BE(4);
  if (version !== 2 && version !== 3) {
    return indexMetadata;
  }

  const entryCount = index.readUInt32BE(8);
  let offset = 12;
  for (let i = 0; i < entryCount && offset + 62 <= index.length; i += 1) {
    const entryStart = offset;
    const mtimeSeconds = index.readUInt32BE(offset + 8);
    const size = index.readUInt32BE(offset + 36);
    offset += 60;
    const flags = index.readUInt16BE(offset);
    offset += 2;
    if (flags & 0x4000) {
      offset += 2;
    }

    const nameLength = flags & 0x0fff;
    const pathStart = offset;
    let pathEnd;
    if (nameLength < 0x0fff) {
      pathEnd = pathStart + nameLength;
      offset = pathEnd + 1;
    } else {
      pathEnd = index.indexOf(0, pathStart);
      if (pathEnd < 0) {
        break;
      }
      offset = pathEnd + 1;
    }

    const indexRelPath = index.toString('utf8', pathStart, pathEnd);
    indexMetadata.set(indexRelPath, { mtimeSeconds, size });

    const padding = (8 - ((offset - entryStart) % 8)) % 8;
    offset += padding;
  }

  return indexMetadata;
}

function getIndexedMetadata(relPath) {
  return loadIndexMetadata().get(relPath) ?? null;
}

function isIndexedCleanPlaceholder(relPath, stats, expectedSize) {
  const indexed = getIndexedMetadata(relPath);
  return Boolean(indexed && indexed.size === expectedSize);
}

function restoreFromRestoreDir(file, relPath, stats, expectedSize) {
  if (!restoreFromDirPath || !isIndexedCleanPlaceholder(relPath, stats, expectedSize)) {
    return false;
  }

  try {
    const sourcePath = resolve(restoreFromDirPath, relPath);
    const source = statSync(sourcePath);
    if (source.size !== expectedSize || hasPlaceholderStats(source)) {
      return false;
    }
    const bytes = readFileSync(sourcePath);
    if (bytes.length !== expectedSize) {
      return false;
    }
    writeAtomically(file, bytes);
    return true;
  } catch {
    return false;
  }
}

function restoreIndexedCleanFile(file, relPath, stats, expectedSize) {
  if (!restoreFromHead) {
    return false;
  }

  try {
    if (!isIndexedCleanPlaceholder(relPath, stats, expectedSize)) {
      return false;
    }
    const bytes = execFileSync('git', ['show', `:${relPath}`], {
      cwd: root,
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15000,
    });
    if (bytes.length !== expectedSize) {
      return false;
    }
    writeAtomically(file, bytes);
    return true;
  } catch {
    return false;
  }
}

function restoreExpoAssetFromIpa(file, relPath, expectedSize) {
  if (!restoreFromIpaPath || !relPath.startsWith('assets/')) {
    return false;
  }

  try {
    const bytes = execFileSync('unzip', ['-p', restoreFromIpaPath, `Payload/Thallo.app/assets/${relPath}`], {
      cwd: root,
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
      timeout: 15000,
    });
    if (bytes.length !== expectedSize) {
      return false;
    }
    writeAtomically(file, bytes);
    return true;
  } catch {
    return false;
  }
}

function restoreLocalFallback(file, relPath, expectedSize) {
  const fallbackRelPath = localFallbacks.get(relPath);
  if (!fallbackRelPath) {
    return false;
  }

  try {
    const fallbackPath = resolve(root, fallbackRelPath);
    const fallback = statSync(fallbackPath);
    if (fallback.size !== expectedSize || hasPlaceholderStats(fallback)) {
      return false;
    }
    const bytes = execFileSync('/bin/cat', [fallbackPath], {
      cwd: root,
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 8000,
    });
    if (bytes.length !== expectedSize) {
      return false;
    }
    writeAtomically(file, bytes);
    return true;
  } catch {
    return false;
  }
}

function restoreLocalXcodeEnv(file, relPath, expectedSize) {
  if (relPath !== 'ios/.xcode.env.local') {
    return false;
  }

  const base = 'export NODE_BINARY=$(command -v node)';
  if (base.length + 1 > expectedSize) {
    return false;
  }
  const bytes = Buffer.from(`${base}${' '.repeat(expectedSize - base.length - 1)}\n`);
  writeAtomically(file, bytes);
  return true;
}

let checked = 0;
let materialized = 0;
const failed = [];

for (const file of deployFiles()) {
  checked += 1;
  const relPath = normalize(file);
  const before = statSync(file);
  if (!hasPlaceholderStats(before)) {
    continue;
  }

  if (
    !restoreExpoAssetFromIpa(file, relPath, before.size) &&
    !restoreLocalFallback(file, relPath, before.size) &&
    !restoreLocalXcodeEnv(file, relPath, before.size) &&
    !restoreFromRestoreDir(file, relPath, before, before.size) &&
    !restoreIndexedCleanFile(file, relPath, before, before.size)
  ) {
    if (requestProviderDownload(file)) {
      const downloaded = statSync(file);
      if (downloaded.size === before.size && !hasPlaceholderStats(downloaded)) {
        materialized += 1;
        continue;
      }
    }
    failed.push(relPath);
    continue;
  }

  const after = statSync(file);
  if (after.size === before.size && !hasPlaceholderStats(after)) {
    materialized += 1;
  } else {
    failed.push(relPath);
  }
}

for (const rootDir of roots) {
  const temp = resolve(root, `${rootDir}.materialize-${process.pid}.tmp`);
  try {
    unlinkSync(temp);
  } catch {}
}

if (failed.length) {
  console.error(`[materialize] ${failed.length} file-provider placeholder(s) could not be materialized:`);
  for (const relPath of failed.slice(0, 80)) {
    console.error(`  ${relPath}`);
  }
  if (failed.length > 80) {
    console.error(`  ... ${failed.length - 80} more`);
  }
  process.exit(1);
}

console.log(`[materialize] checked ${checked} deploy files; materialized ${materialized} placeholder(s).`);
