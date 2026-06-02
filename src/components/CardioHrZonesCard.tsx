// Heart-rate-zone time distribution for the Progress → Trends cardio
// section.
//
// hr_summary.zoneMinutes is written on every session that carries HR
// data (Apple Watch / chest strap). This component only uses rows that
// are cardio sessions, so hard lifts with watch HR do not inflate the
// Progress → Trends cardio zone breakdown.
//
// Each zone row is tappable — it expands to show which sessions
// contributed minutes to that zone, so a user can see whether their
// Zone 4 time came from intervals, a tempo run, or another cardio log.

import { useEffect, useMemo, useState } from 'react';
import { View, Text, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getTheme } from '../constants/theme';
import { AppThemeName } from '../types';
import { listWorkoutCompletions, type WorkoutCompletionRecord } from '../services/api';
import { HR_ZONE_BANDS, HR_ZONE_COLORS } from '../utils/hrZones';
import { isCardioHrZoneSource } from '../screens/progressData';

interface Props {
  authToken: string;
  themeName?: AppThemeName;
}

const WINDOW_DAYS = 30;
const MAX_CONTRIBUTORS = 8;

interface ZoneContributor {
  id: number;
  name: string;
  date: string;
  mins: number;
}

function sessionName(c: WorkoutCompletionRecord): string {
  return (c.focus_label || c.activity_subtype || 'Workout').trim();
}

function sessionDate(c: WorkoutCompletionRecord): string {
  const t = new Date(c.workout_date || c.completed_at || '').getTime();
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function CardioHrZonesCard({ authToken, themeName }: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const [rows, setRows] = useState<WorkoutCompletionRecord[]>([]);
  const [expandedZone, setExpandedZone] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    listWorkoutCompletions(authToken, { limit: 150, skip: 0 })
      .then(r => { if (!cancelled) setRows(Array.isArray(r) ? r : []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [authToken]);

  const { zoneMin, contributors } = useMemo(() => {
    const cutoff = Date.now() - WINDOW_DAYS * 86400_000;
    const totals = [0, 0, 0, 0, 0];
    const byZone: ZoneContributor[][] = [[], [], [], [], []];
    for (const c of rows) {
      const t = new Date(c.workout_date || c.completed_at || '').getTime();
      if (!Number.isFinite(t) || t < cutoff) continue;
      if (!isCardioHrZoneSource(c)) continue;
      const zm = c.hr_summary?.zoneMinutes;
      if (!Array.isArray(zm)) continue;
      for (let i = 0; i < 5; i++) {
        const m = Number(zm[i]) || 0;
        if (m <= 0) continue;
        totals[i] += m;
        byZone[i].push({ id: c.id, name: sessionName(c), date: sessionDate(c), mins: m });
      }
    }
    for (const list of byZone) list.sort((a, b) => b.mins - a.mins);
    return { zoneMin: totals, contributors: byZone };
  }, [rows]);

  if (!zoneMin.some(v => v > 0)) return null;
  const zoneMax = Math.max(1, ...zoneMin);

  return (
    <View style={{ marginTop: 14 }}>
      <Text style={{ fontSize: 11, fontWeight: '900', color: tc.textMuted, letterSpacing: 0.5, marginBottom: 8 }}>
        HEART-RATE ZONES · LAST {WINDOW_DAYS} DAYS
      </Text>
      <View style={{ gap: 8 }}>
        {HR_ZONE_BANDS.map((band, i) => {
          const mins = zoneMin[i];
          const has = mins > 0;
          const expanded = expandedZone === i;
          const list = contributors[i];
          return (
            <View key={band.zone}>
              <Pressable
                disabled={!has}
                onPress={() => setExpandedZone(expanded ? null : i)}
                accessibilityRole="button"
                accessibilityLabel={`Zone ${band.zone} ${band.label}, ${Math.round(mins)} minutes${has ? '. Tap to see contributing cardio sessions.' : ''}`}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={{ width: 72, fontSize: 11, fontWeight: '700', color: tc.textSecondary }}>
                  Z{band.zone} {band.label}
                </Text>
                <View style={{ flex: 1, height: 14, backgroundColor: tc.border, borderRadius: 7, overflow: 'hidden' }}>
                  <View style={{ width: `${Math.max(has ? 6 : 0, (mins / zoneMax) * 100)}%`, height: '100%', backgroundColor: HR_ZONE_COLORS[i], borderRadius: 7 }} />
                </View>
                <Text style={{ width: 42, fontSize: 11, fontWeight: '800', color: tc.textPrimary, textAlign: 'right' }}>
                  {Math.round(mins)}m
                </Text>
                <Ionicons
                  name={expanded ? 'chevron-up' : 'chevron-down'}
                  size={12}
                  color={has ? tc.textMuted : 'transparent'}
                />
              </Pressable>
              {expanded && (
                <View style={{ marginLeft: 80, marginTop: 7, marginBottom: 3, gap: 5 }}>
                  {list.slice(0, MAX_CONTRIBUTORS).map(ct => (
                    <View key={`${i}-${ct.id}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: HR_ZONE_COLORS[i] }} />
                      <Text numberOfLines={1} style={{ flex: 1, fontSize: 11, color: tc.textSecondary }}>
                        {ct.name}
                      </Text>
                      <Text style={{ fontSize: 10, color: tc.textMuted }}>{ct.date}</Text>
                      <Text style={{ width: 38, fontSize: 11, fontWeight: '700', color: tc.textPrimary, textAlign: 'right' }}>
                        {Math.round(ct.mins)}m
                      </Text>
                    </View>
                  ))}
                  {list.length > MAX_CONTRIBUTORS && (
                    <Text style={{ fontSize: 10, color: tc.textMuted, marginLeft: 11 }}>
                      +{list.length - MAX_CONTRIBUTORS} more session{list.length - MAX_CONTRIBUTORS === 1 ? '' : 's'}
                    </Text>
                  )}
                </View>
              )}
            </View>
          );
        })}
      </View>
      <Text style={{ fontSize: 10, color: tc.textMuted, marginTop: 8 }}>
        Tap a zone to see which cardio sessions contributed.
      </Text>
    </View>
  );
}
