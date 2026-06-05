#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.EAS_BUILD_PLATFORM && process.env.EAS_BUILD_PLATFORM !== 'ios') {
  console.log(`Skipping iOS build-version sync for ${process.env.EAS_BUILD_PLATFORM}.`);
  process.exit(0);
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plistBuddy = '/usr/libexec/PlistBuddy';
const appPlist = path.join(projectRoot, 'ios/Thallo/Info.plist');
const pbxprojPath = path.join(projectRoot, 'ios/Thallo.xcodeproj/project.pbxproj');
const plists = [
  appPlist,
  path.join(projectRoot, 'targets/resttimer-widget/Info.plist'),
  path.join(projectRoot, 'targets/thallo-watch/Info.plist'),
  path.join(projectRoot, 'targets/thallo-watch-complication/Info.plist'),
];

function plistValue(file, key) {
  return execFileSync(plistBuddy, ['-c', `Print :${key}`, file], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function setPlistValue(file, key, value) {
  try {
    execFileSync(plistBuddy, ['-c', `Set :${key} ${value}`, file], { stdio: 'ignore' });
  } catch {
    execFileSync(plistBuddy, ['-c', `Add :${key} string ${value}`, file], { stdio: 'ignore' });
  }
}

const buildNumber = process.env.IOS_BUILD_NUMBER || process.argv[2] || plistValue(appPlist, 'CFBundleVersion');
if (!/^\d+(?:\.\d+){0,2}$/.test(buildNumber)) {
  throw new Error(`Unexpected iOS CFBundleVersion: ${buildNumber}`);
}

const pbxproj = fs.readFileSync(pbxprojPath, 'utf8');
const updatedPbxproj = pbxproj.replace(
  /CURRENT_PROJECT_VERSION = [^;]+;/g,
  `CURRENT_PROJECT_VERSION = ${buildNumber};`
);

if (updatedPbxproj !== pbxproj) {
  fs.writeFileSync(pbxprojPath, updatedPbxproj);
}

for (const plist of plists) {
  setPlistValue(plist, 'CFBundleVersion', buildNumber);
}

console.log(`Synced iOS app, widget, and watch build versions to ${buildNumber}.`);
