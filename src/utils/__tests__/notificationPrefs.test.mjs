import { isHourInQuietWindow } from '../notificationPrefs.ts';

function assert(condition, label, detail = '') {
  if (!condition) {
    console.error(`  ✗ ${label}${detail ? `: ${detail}` : ''}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
}

console.log('[notificationPrefs] quiet-hours tests');

assert(!isHourInQuietWindow(22, { enabled: false, startHour: 22, endHour: 7 }), 'disabled quiet hours never suppress');
assert(isHourInQuietWindow(22, { enabled: true, startHour: 22, endHour: 7 }), 'overnight window includes start hour');
assert(isHourInQuietWindow(2, { enabled: true, startHour: 22, endHour: 7 }), 'overnight window wraps through midnight');
assert(!isHourInQuietWindow(7, { enabled: true, startHour: 22, endHour: 7 }), 'overnight window excludes end hour');
assert(isHourInQuietWindow(14, { enabled: true, startHour: 14, endHour: 16 }), 'same-day window includes start hour');
assert(!isHourInQuietWindow(16, { enabled: true, startHour: 14, endHour: 16 }), 'same-day window excludes end hour');
assert(!isHourInQuietWindow(10, { enabled: true, startHour: 10, endHour: 10 }), 'same start/end is treated as no quiet window');

if (process.exitCode) {
  console.error('[notificationPrefs] FAILED');
} else {
  console.log('[notificationPrefs] all passed');
}
