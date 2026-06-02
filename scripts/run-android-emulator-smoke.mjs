#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const androidHome = process.env.ANDROID_HOME || path.join(os.homedir(), 'Library/Android/sdk');
const avdName = process.env.AVD_NAME || 'Thallo_API_36';
const appId = process.env.APP_ID || 'com.thallo.app';
const apkPath = path.resolve(process.env.APK_PATH || path.join(repoRoot, 'android/app/build/outputs/apk/release/app-release.apk'));
const flowPath = path.resolve(process.env.MAESTRO_FLOW || path.join(repoRoot, '.maestro/flows/android-release-launch.yaml'));
const artifactsDir = path.join(repoRoot, '.maestro/artifacts');
const screenshotPath = path.join(artifactsDir, 'android-release-launch.png');

const adb = path.join(androidHome, 'platform-tools/adb');
const emulator = path.join(androidHome, 'emulator/emulator');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: { ...process.env, ANDROID_HOME: androidHome, ANDROID_SDK_ROOT: androidHome },
  });
  if (result.status !== 0) {
    const stderr = result.stderr ? `\n${result.stderr.trim()}` : '';
    throw new Error(`${command} ${args.join(' ')} failed${stderr}`);
  }
  return result.stdout || '';
}

function requireFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found at ${filePath}`);
  }
}

function connectedDevices() {
  const output = run(adb, ['devices'], { capture: true });
  return output
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial && state === 'device')
    .map(([serial]) => serial);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForBoot(serial) {
  run(adb, ['-s', serial, 'wait-for-device']);
  for (let i = 0; i < 120; i += 1) {
    const booted = run(adb, ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'], { capture: true }).trim();
    if (booted === '1') return;
    await sleep(2000);
  }
  throw new Error(`Timed out waiting for ${serial} to boot`);
}

async function ensureDevice() {
  run(adb, ['start-server']);
  const existing = process.env.ANDROID_SERIAL || connectedDevices()[0];
  if (existing) {
    await waitForBoot(existing);
    return existing;
  }

  requireFile(emulator, 'Android emulator');
  console.log(`[android-smoke] starting emulator ${avdName}`);
  const child = spawn(emulator, [
    '-avd', avdName,
    '-no-window',
    '-no-audio',
    '-no-snapshot',
    '-no-boot-anim',
    '-gpu', 'swiftshader_indirect',
    '-camera-back', 'none',
    '-camera-front', 'none',
  ], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ANDROID_HOME: androidHome, ANDROID_SDK_ROOT: androidHome },
  });
  child.unref();

  run(adb, ['wait-for-device']);
  const serial = connectedDevices()[0];
  if (!serial) throw new Error('Emulator started but no adb device is connected');
  await waitForBoot(serial);
  return serial;
}

function assertNoLaunchCrash(serial) {
  const logcat = run(adb, ['-s', serial, 'logcat', '-d', '-t', '700'], { capture: true });
  const crashLines = logcat
    .split('\n')
    .filter((line) => /FATAL EXCEPTION|AndroidRuntime|Process: com\.thallo\.app|com\.facebook\.react\.common/i.test(line));
  if (crashLines.length) {
    throw new Error(`Launch crash detected:\n${crashLines.slice(-40).join('\n')}`);
  }
}

async function main() {
  requireFile(adb, 'adb');
  requireFile(apkPath, 'APK');

  fs.mkdirSync(artifactsDir, { recursive: true });
  const serial = await ensureDevice();
  console.log(`[android-smoke] using ${serial}`);

  run(adb, ['-s', serial, 'install', '-r', apkPath]);
  run(adb, ['-s', serial, 'shell', 'am', 'force-stop', appId]);
  run(adb, ['-s', serial, 'logcat', '-c']);
  run(adb, ['-s', serial, 'shell', 'am', 'start', '-W', '-n', `${appId}/.MainActivity`]);
  await sleep(8000);

  const pid = run(adb, ['-s', serial, 'shell', 'pidof', appId], { capture: true }).trim();
  if (!pid) throw new Error(`${appId} did not stay running after launch`);
  assertNoLaunchCrash(serial);

  const screenshot = spawnSync(adb, ['-s', serial, 'exec-out', 'screencap', '-p'], {
    cwd: repoRoot,
    encoding: 'buffer',
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, ANDROID_HOME: androidHome, ANDROID_SDK_ROOT: androidHome },
  });
  if (screenshot.status !== 0) {
    const stderr = screenshot.stderr?.toString('utf8').trim();
    throw new Error(`Failed to capture Android screenshot${stderr ? `: ${stderr}` : ''}`);
  }
  fs.writeFileSync(screenshotPath, screenshot.stdout);
  console.log(`[android-smoke] screenshot: ${screenshotPath}`);

  if (fs.existsSync(flowPath) && spawnSync('maestro', ['--version'], { stdio: 'ignore' }).status === 0) {
    run('maestro', ['--device', serial, 'test', flowPath]);
  } else {
    console.log('[android-smoke] Maestro not available or flow missing; skipped UI assertions');
  }
}

main().catch((err) => {
  console.error(`[android-smoke] ${err.message}`);
  process.exit(1);
});
