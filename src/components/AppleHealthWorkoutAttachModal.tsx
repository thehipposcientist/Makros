import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { AppThemeName, WorkoutSession } from '../types';
import {
  getLastHealthKitError,
  isHealthKitAvailable,
  requestHealthPermissions,
} from '../services/appleHealth';
import { getTheme } from '../constants/theme';
import { formatDistance, type DistanceUnit } from '../utils/units';
import {
  findAppleHealthWorkoutLinkCandidates,
  linkAppleHealthWorkoutToSession,
  type AppleHealthWorkoutLinkCandidate,
} from '../utils/appleHealthWorkoutLink';

type Props = {
  visible: boolean;
  session: WorkoutSession | null;
  authToken?: string | null;
  themeName?: AppThemeName | string;
  distanceUnit?: DistanceUnit;
  age?: number | null;
  onClose: () => void;
  onAssigned: (session: WorkoutSession) => void | Promise<void>;
};

function formatTimeRange(startDate: string, endDate: string): string {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const day = start.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const startTime = start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const endTime = end.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `${day} · ${startTime} - ${endTime}`;
}

function candidateMeta(candidate: AppleHealthWorkoutLinkCandidate, distanceUnit: DistanceUnit): string {
  const pieces = [
    `${candidate.durationMin} min`,
    candidate.calories != null ? `${Math.round(candidate.calories)} kcal` : null,
    candidate.distanceMiles != null ? formatDistance(candidate.distanceMiles, distanceUnit) : null,
  ].filter(Boolean);
  return pieces.join(' · ');
}

export default function AppleHealthWorkoutAttachModal({
  visible,
  session,
  authToken,
  themeName,
  distanceUnit = 'mi',
  age,
  onClose,
  onAssigned,
}: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const [loading, setLoading] = useState(false);
  const [candidates, setCandidates] = useState<AppleHealthWorkoutLinkCandidate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [attachingId, setAttachingId] = useState<string | null>(null);

  const linkedId = session?.linkedAppleHealthWorkout?.externalId ?? null;
  const sortedCandidates = useMemo(() => {
    if (!linkedId) return candidates;
    return [...candidates].sort((a, b) => {
      if (a.externalId === linkedId) return -1;
      if (b.externalId === linkedId) return 1;
      return 0;
    });
  }, [candidates, linkedId]);

  const loadCandidates = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    setError(null);
    try {
      if (!isHealthKitAvailable()) {
        setCandidates([]);
        setError('Apple Health is only available on iPhone with Health permissions enabled.');
        return;
      }
      const ok = await requestHealthPermissions();
      if (!ok) {
        setCandidates([]);
        setError(getLastHealthKitError() ?? 'Apple Health permission was not granted.');
        return;
      }
      const next = await findAppleHealthWorkoutLinkCandidates(session);
      setCandidates(next);
      if (next.length === 0) {
        setError('No Apple Health workouts found for this day.');
      }
    } catch (err: any) {
      setCandidates([]);
      setError(err?.message ?? 'Could not read Apple Health workouts.');
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    if (!visible) {
      setCandidates([]);
      setError(null);
      setAttachingId(null);
      return;
    }
    loadCandidates();
  }, [loadCandidates, visible]);

  const attach = useCallback(async (candidate: AppleHealthWorkoutLinkCandidate) => {
    if (!session) return;
    setAttachingId(candidate.externalId);
    try {
      const updated = await linkAppleHealthWorkoutToSession(session, candidate, {
        authToken,
        age,
      });
      await onAssigned(updated);
      onClose();
    } catch (err: any) {
      Alert.alert('Could not attach workout', err?.message ?? 'Apple Health data could not be assigned to this workout.');
    } finally {
      setAttachingId(null);
    }
  }, [age, authToken, onAssigned, onClose, session]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' }}>
        <View style={{
          maxHeight: '82%',
          backgroundColor: tc.background,
          borderTopLeftRadius: 18,
          borderTopRightRadius: 18,
          padding: 16,
          borderWidth: 1,
          borderColor: tc.border,
        }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 18, fontWeight: '800', color: tc.textPrimary }}>Attach Apple Health</Text>
              <Text style={{ fontSize: 12, color: tc.textMuted, marginTop: 2 }}>
                Assign one Health workout to this history entry.
              </Text>
            </View>
            <TouchableOpacity
              onPress={onClose}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              style={{ padding: 6 }}>
              <Ionicons name="close" size={22} color={tc.textSecondary} />
            </TouchableOpacity>
          </View>

          {session?.linkedAppleHealthWorkout ? (
            <View style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: tc.primary + '44',
              backgroundColor: tc.primary + '12',
              padding: 10,
              marginBottom: 12,
            }}>
              <Ionicons name="checkmark-circle-outline" size={18} color={tc.primary} />
              <Text style={{ flex: 1, fontSize: 12, color: tc.textSecondary }}>
                Linked to {session.linkedAppleHealthWorkout.activityName}
              </Text>
            </View>
          ) : null}

          {loading ? (
            <View style={{ alignItems: 'center', paddingVertical: 32 }}>
              <ActivityIndicator color={tc.primary} />
              <Text style={{ marginTop: 10, fontSize: 12, color: tc.textMuted }}>Reading Apple Health workouts...</Text>
            </View>
          ) : (
            <ScrollView contentContainerStyle={{ gap: 8, paddingBottom: 14 }}>
              {error ? (
                <View style={{
                  borderRadius: 10,
                  borderWidth: 1,
                  borderColor: tc.border,
                  backgroundColor: tc.surface,
                  padding: 12,
                }}>
                  <Text style={{ fontSize: 13, color: tc.textSecondary, lineHeight: 18 }}>{error}</Text>
                  <TouchableOpacity
                    onPress={loadCandidates}
                    activeOpacity={0.85}
                    style={{
                      alignSelf: 'flex-start',
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 6,
                      marginTop: 10,
                      paddingHorizontal: 10,
                      paddingVertical: 7,
                      borderRadius: 8,
                      backgroundColor: tc.primary + '18',
                    }}>
                    <Ionicons name="refresh-outline" size={14} color={tc.primary} />
                    <Text style={{ fontSize: 12, fontWeight: '700', color: tc.primary }}>Retry</Text>
                  </TouchableOpacity>
                </View>
              ) : null}

              {sortedCandidates.map(candidate => {
                const isLinked = candidate.externalId === linkedId;
                const isAttaching = attachingId === candidate.externalId;
                return (
                  <View
                    key={candidate.externalId}
                    style={{
                      borderRadius: 10,
                      borderWidth: 1,
                      borderColor: isLinked ? tc.primary + '66' : tc.border,
                      backgroundColor: isLinked ? tc.primary + '10' : tc.surface,
                      padding: 12,
                    }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                      <View style={{
                        width: 34,
                        height: 34,
                        borderRadius: 17,
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: tc.primary + '16',
                      }}>
                        <Ionicons name="heart-outline" size={17} color={tc.primary} />
                      </View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={{ fontSize: 14, fontWeight: '800', color: tc.textPrimary }} numberOfLines={1}>
                          {candidate.activityName}
                        </Text>
                        <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 2 }}>
                          {formatTimeRange(candidate.startDate, candidate.endDate)}
                        </Text>
                        <Text style={{ fontSize: 12, color: tc.textSecondary, marginTop: 3 }}>
                          {candidateMeta(candidate, distanceUnit)}
                        </Text>
                      </View>
                      <TouchableOpacity
                        disabled={isAttaching}
                        onPress={() => attach(candidate)}
                        activeOpacity={0.86}
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 5,
                          paddingHorizontal: 10,
                          paddingVertical: 7,
                          borderRadius: 8,
                          backgroundColor: isLinked ? tc.surfaceRaised : tc.primary,
                          opacity: isAttaching ? 0.7 : 1,
                        }}>
                        {isAttaching ? (
                          <ActivityIndicator size="small" color={isLinked ? tc.primary : '#fff'} />
                        ) : (
                          <Ionicons name={isLinked ? 'checkmark' : 'link-outline'} size={14} color={isLinked ? tc.primary : '#fff'} />
                        )}
                        <Text style={{ fontSize: 12, fontWeight: '800', color: isLinked ? tc.primary : '#fff' }}>
                          {isLinked ? 'Linked' : 'Attach'}
                        </Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                );
              })}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}
