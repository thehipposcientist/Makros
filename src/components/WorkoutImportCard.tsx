// "You have workouts in Apple Health that aren't logged in Thallo" card.
// One-tap import. Each row has its own import button and auto-dismisses after.

import { useCallback, useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getTheme, radius } from '../constants/theme';
import { AppThemeName, HealthSummary } from '../types';
import { detectUnloggedWorkouts, importCandidate, ImportCandidate } from '../utils/workoutAutoImport';

interface Props {
  healthSummary?: HealthSummary | null;
  themeName?: AppThemeName;
  onImported?: () => void;
}

export default function WorkoutImportCard({ healthSummary, themeName, onImported }: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;

  const [candidates, setCandidates] = useState<ImportCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    const raw = healthSummary?.workoutDetails ?? [];
    if (raw.length === 0) { setCandidates([]); return; }
    const found = await detectUnloggedWorkouts(raw, 7);
    setCandidates(found);
  }, [healthSummary?.workoutDetails]);

  useEffect(() => { refresh(); }, [refresh]);

  const handleImport = async (c: ImportCandidate) => {
    setLoading(true);
    try {
      await importCandidate(c);
      setDismissed(prev => new Set(prev).add(c.externalId));
      onImported?.();
    } catch (e: any) {
      Alert.alert('Import failed', String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  };

  const visible = candidates.filter(c => !dismissed.has(c.externalId));
  if (visible.length === 0) return null;

  const formatWhen = (iso: string) => {
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const yesterday = d.toDateString() === new Date(now.getTime() - 86400000).toDateString();
    if (sameDay) return `Today, ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
    if (yesterday) return `Yesterday, ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  };

  return (
    <View style={{
      backgroundColor: tc.surface, borderRadius: radius.lg, padding: 14, marginBottom: 12,
      borderWidth: 1, borderColor: tc.primary + '44',
    }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10 }}>
        <Ionicons name="cloud-download-outline" size={16} color={tc.primary} />
        <Text style={{ fontSize: 13, fontWeight: '700', color: tc.textPrimary, flex: 1 }}>
          {visible.length} workout{visible.length !== 1 ? 's' : ''} from Apple Health
        </Text>
        <Text style={{ fontSize: 10, color: tc.textMuted }}>Not in Thallo</Text>
      </View>
      {visible.slice(0, 5).map((c, i) => (
        <View
          key={c.externalId}
          style={{
            flexDirection: 'row', alignItems: 'center', gap: 8,
            paddingVertical: 8,
            borderTopWidth: i > 0 ? 1 : 0,
            borderTopColor: tc.border + '44',
          }}
        >
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 13, fontWeight: '600', color: tc.textPrimary }}>{c.activityName}</Text>
            <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 1 }}>
              {formatWhen(c.startDate)} · {c.durationMin} min
              {c.calories ? ` · ${Math.round(c.calories)} cal` : ''}
              {c.distanceMiles != null && c.distanceMiles > 0 ? ` · ${c.distanceMiles.toFixed(1)} mi` : ''}
            </Text>
          </View>
          <TouchableOpacity
            disabled={loading}
            onPress={() => handleImport(c)}
            style={{
              paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8,
              backgroundColor: tc.primary,
              opacity: loading ? 0.6 : 1,
            }}
          >
            <Text style={{ fontSize: 12, fontWeight: '700', color: '#fff' }}>Import</Text>
          </TouchableOpacity>
        </View>
      ))}
    </View>
  );
}
