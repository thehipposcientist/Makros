import { Alert, Platform } from 'react-native';
import { loadWorkoutHistory } from './workoutHistory';
import { loadWeightHistory } from './weightHistory';

async function shareCSV(filename: string, content: string): Promise<void> {
  try {
    const Sharing = require('expo-sharing') as typeof import('expo-sharing');
    const FS = require('expo-file-system') as typeof import('expo-file-system');

    const dir = FS.documentDirectory ?? FS.cacheDirectory;
    if (!dir) {
      Alert.alert('Not supported', 'File storage is not available. Try sharing a screenshot instead.');
      return;
    }

    const path = dir + filename;
    await FS.writeAsStringAsync(path, content);

    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(path, {
        mimeType: 'text/csv',
        UTI: 'public.comma-separated-values-text',
        dialogTitle: `Share ${filename}`,
      });
    } else {
      Alert.alert('Exported', `File saved as ${filename}`);
    }
  } catch (e: any) {
    console.log('[export] error:', e);
    Alert.alert('Export failed', e?.message ?? 'Could not export data.');
  }
}

export async function exportWorkoutHistory(): Promise<void> {
  const history = await loadWorkoutHistory();
  if (!history.length) {
    Alert.alert('No data', 'Complete a workout first to have data to export.');
    return;
  }
  const rows = ['Date,Focus,Duration (min),Exercises,Sets,Completed'];
  for (const s of history) {
    const date = s.date.slice(0, 10);
    const dur = Math.round((s.durationSeconds || 0) / 60);
    const exCount = (s.exercises ?? []).length;
    const setCount = (s.exercises ?? []).reduce((sum, ex) => sum + (ex.sets?.length ?? 0), 0);
    rows.push(`${date},"${s.focus}",${dur},${exCount},${setCount},${s.completed}`);
  }
  await shareCSV('thallo_workouts.csv', rows.join('\n'));
}

export async function exportWeightHistory(): Promise<void> {
  const history = await loadWeightHistory();
  if (!history.length) {
    Alert.alert('No data', 'Log your weight first to have data to export.');
    return;
  }
  const rows = ['Date,Weight (lbs),Source'];
  for (const e of history) {
    rows.push(`${e.date},${e.weightLbs},${e.source ?? 'manual'}`);
  }
  await shareCSV('thallo_weight.csv', rows.join('\n'));
}
