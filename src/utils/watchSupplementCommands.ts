import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  getTodaySupplements,
  logDose,
  logSupplementGroup,
  unlogDose,
  type TodayStackItem,
} from '../services/api';
import { pushSupplementsToWatch } from './watchSync';

export type WatchSupplementCommandName =
  | 'toggle_supplement'
  | 'take_supplement_group'
  | 'take_all_supplements';

const SUPPLEMENT_COMMANDS = new Set<WatchSupplementCommandName>([
  'toggle_supplement',
  'take_supplement_group',
  'take_all_supplements',
]);

export function isWatchSupplementCommand(command: string): command is WatchSupplementCommandName {
  return SUPPLEMENT_COMMANDS.has(command as WatchSupplementCommandName);
}

export async function processWatchSupplementCommand(
  token: string,
  command: string,
  payload: Record<string, any>,
): Promise<void> {
  if (!isWatchSupplementCommand(command)) return;
  if (!(await watchCommandUserAllowed(payload))) return;

  if (command === 'toggle_supplement') {
    const id = Number(payload?.id ?? 0);
    if (!id) return;
    const taken = payload?.taken === true || String(payload?.taken).toLowerCase() === 'true';
    if (taken) {
      const current = await getTodaySupplements(token);
      const item = current.find(candidate => candidate.id === id);
      if (item?.logs_today?.find(log => !log.skipped)) {
        await pushSupplementsToWatch(supplementsForWatch(current), undefined, { force: true });
        return;
      }
      await logDose(token, id, { skipped: false });
    } else {
      await unlogDose(token, id);
    }
    await pushTodaySupplementsSnapshot(token);
    return;
  }

  if (command === 'take_supplement_group') {
    const groupLabel = typeof payload?.groupLabel === 'string' ? payload.groupLabel.trim() : '';
    const timing = typeof payload?.timing === 'string' ? payload.timing.trim() : '';
    if (!groupLabel && !timing) return;
    await logSupplementGroup(token, groupLabel ? { group_label: groupLabel } : { timing });
    await pushTodaySupplementsSnapshot(token);
    return;
  }

  const current = await getTodaySupplements(token);
  for (const item of current) {
    const logs = item.logs_today || [];
    if (logs.find(log => !log.skipped)) continue;
    if (logs.find(log => log.skipped)) continue;
    await logDose(token, item.id, { skipped: false });
  }
  await pushTodaySupplementsSnapshot(token);
}

export async function pushTodaySupplementsSnapshot(token: string): Promise<void> {
  const fresh = await getTodaySupplements(token);
  await pushSupplementsToWatch(supplementsForWatch(fresh), undefined, { force: true });
}

export function supplementsForWatch(items: TodayStackItem[]) {
  return items.map(item => ({
    id: item.id,
    name: item.custom_name || 'Supplement',
    dose: `${item.dose_amount}${item.dose_unit}`,
    timing: item.timing ?? null,
    groupLabel: item.group_label ?? null,
    taken: !!(item.logs_today || []).find(log => !log.skipped),
    skipped: !!(item.logs_today || []).find(log => log.skipped),
  }));
}

async function watchCommandUserAllowed(payload: Record<string, any>): Promise<boolean> {
  const commandUserId = typeof payload?.userId === 'string' && payload.userId.trim()
    ? payload.userId.trim()
    : null;
  if (!commandUserId) return true;
  const currentUserId = await AsyncStorage.getItem('last_user_id').catch(() => null);
  return !currentUserId || currentUserId === commandUserId;
}
