import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';

import type { AppThemeName } from '../types';
import type { FeedItem, SocialDigestFriend } from '../services/api';
import { getUserFeed } from '../services/api';
import {
  chooseSocialWorkoutFeedItem,
  compactSocialSetSummaries,
  formatSocialDistance,
  formatSocialDuration,
  socialWorkoutDateKey,
} from '../utils/socialWorkoutDetails';
import { configureExpandAnimation } from '../utils/layoutAnim';
import FadeInView from './FadeInView';
import FriendsModal from './FriendsModal';
import SocialAvatar from './SocialAvatar';

type SocialCounts = {
  friends: number;
  pending: number;
  unread: number;
};

interface HomeFriendsTabProps {
  authToken: string;
  themeName?: AppThemeName;
  themeColors: any;
  resetToken?: number;
  initialSearchUsername?: string | null;
  onInitialSearchConsumed?: () => void;
  onSocialCountsChange: (counts: SocialCounts) => void;
}

function HomeFriendsTabInner({
  authToken,
  themeName,
  themeColors,
  resetToken = 0,
  initialSearchUsername,
  onInitialSearchConsumed,
  onSocialCountsChange,
}: HomeFriendsTabProps) {
  const [viewingFriend, setViewingFriend] = useState<SocialDigestFriend | null>(null);
  const [friendFeedItems, setFriendFeedItems] = useState<FeedItem[]>([]);
  const [friendPrItems, setFriendPrItems] = useState<FeedItem[]>([]);
  const [friendFeedLoading, setFriendFeedLoading] = useState(false);
  const [expandedFeedItemId, setExpandedFeedItemId] = useState<number | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setViewingFriend(null);
    setFriendFeedItems([]);
    setFriendPrItems([]);
    setExpandedFeedItemId(null);
  }, [resetToken]);

  const openFriend = useCallback((digestFriend?: SocialDigestFriend) => {
    if (!digestFriend) return;
    setViewingFriend(digestFriend);
    setFriendFeedItems([]);
    setFriendPrItems([]);
    setExpandedFeedItemId(null);
    if (!digestFriend.share_enabled || !authToken) return;

    setFriendFeedLoading(true);
    getUserFeed(authToken, digestFriend.user_id)
      .then(res => {
        if (!mountedRef.current) return;
        const raw = res.items.filter(
          item => item.event_type === 'workout_completed' || item.event_type === 'workout_post',
        );
        setFriendPrItems(res.items.filter(item => item.event_type === 'pr_achieved').slice(0, 6));
        const byDate = new Map<string, FeedItem>();
        for (const item of raw) {
          const date = socialWorkoutDateKey(item);
          const existing = byDate.get(date);
          byDate.set(date, existing ? chooseSocialWorkoutFeedItem(existing, item) : item);
        }
        setFriendFeedItems(Array.from(byDate.values()).sort((a, b) => b.id - a.id));
      })
      .catch(() => {})
      .finally(() => {
        if (mountedRef.current) setFriendFeedLoading(false);
      });
  }, [authToken]);

  const sevenDayKeys = useMemo(() => {
    const out: Array<{ key: string; label: string }> = [];
    const now = new Date();
    for (let offset = 6; offset >= 0; offset -= 1) {
      const d = new Date(now);
      d.setDate(now.getDate() - offset);
      const key = d.toISOString().slice(0, 10);
      out.push({
        key,
        label: d.toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 1),
      });
    }
    return out;
  }, []);

  const friendActivityDates = useMemo(() => {
    return new Set(friendFeedItems.map(item => socialWorkoutDateKey(item)).filter(Boolean));
  }, [friendFeedItems]);

  return (
    <View key={viewingFriend ? `friend-${viewingFriend.user_id}` : 'social-home'} style={{ flex: 1 }}>
      {viewingFriend ? (
        <ScrollView testID="social-friend-detail-screen" style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 166 }}>
          <TouchableOpacity
            testID="social-friend-detail-back"
            accessibilityLabel="social-friend-detail-back"
            onPress={() => setViewingFriend(null)}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 16 }}
            activeOpacity={0.7}
          >
            <Ionicons name="arrow-back" size={20} color={themeColors.primary} />
            <Text style={{ fontSize: 14, fontWeight: '600', color: themeColors.primary }}>Back</Text>
          </TouchableOpacity>

          <View
            testID="social-friend-profile-card"
            style={{
              backgroundColor: themeColors.surface, borderColor: themeColors.border, borderWidth: 1,
              borderRadius: 14, padding: 20, alignItems: 'center', marginBottom: 16, overflow: 'hidden',
            }}>
            <LinearGradient
              pointerEvents="none"
              colors={[themeColors.primary + '1F', 'transparent'] as any}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }}
            />
            <SocialAvatar
              avatarUrl={viewingFriend.avatar_url}
              name={viewingFriend.display_name}
              username={viewingFriend.username}
              size={56}
              backgroundColor={themeColors.primary + '22'}
              borderColor={themeColors.primary + '55'}
              textColor={themeColors.primary}
              textSize={22}
              style={{ marginBottom: 12 }}
            />
            <Text style={{ fontSize: 18, fontWeight: '800', color: themeColors.textPrimary }}>
              {viewingFriend.display_name || viewingFriend.username}
            </Text>
            <Text style={{ fontSize: 13, color: themeColors.textMuted, marginTop: 2 }}>
              @{viewingFriend.username}
            </Text>
            {viewingFriend.goal ? (
              <View style={{
                marginTop: 10, paddingHorizontal: 12, paddingVertical: 4,
                backgroundColor: themeColors.primary + '12', borderRadius: 12,
              }}>
                <Text style={{ fontSize: 12, fontWeight: '600', color: themeColors.primary }}>
                  {viewingFriend.goal.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                </Text>
              </View>
            ) : null}
          </View>

          <View
            testID="social-friend-stats-card"
            style={{
              backgroundColor: themeColors.surface, borderColor: themeColors.border, borderWidth: 1,
              borderRadius: 14, padding: 16, marginBottom: 16,
            }}>
            <Text style={{ fontSize: 11, fontWeight: '700', color: themeColors.textMuted, letterSpacing: 0.5, marginBottom: 12 }}>
              THIS WEEK
            </Text>
            <View style={{ flexDirection: 'row', justifyContent: 'space-around' }}>
              <View style={{ alignItems: 'center' }}>
                <Text style={{ fontSize: 24, fontWeight: '800', color: themeColors.textPrimary }}>
                  {viewingFriend.sessions}
                </Text>
                <Text style={{ fontSize: 11, color: themeColors.textMuted, marginTop: 2 }}>Sessions</Text>
              </View>
              <View style={{ width: 1, backgroundColor: themeColors.border }} />
              <View style={{ alignItems: 'center' }}>
                <Text style={{ fontSize: 24, fontWeight: '800', color: themeColors.textPrimary }}>
                  {viewingFriend.streak}
                </Text>
                <Text style={{ fontSize: 11, color: themeColors.textMuted, marginTop: 2 }}>Day Streak</Text>
              </View>
              <View style={{ width: 1, backgroundColor: themeColors.border }} />
              <View style={{ alignItems: 'center' }}>
                <View style={{
                  width: 12, height: 12, borderRadius: 6, marginBottom: 8, marginTop: 8,
                  backgroundColor: viewingFriend.last_active_within_48h ? themeColors.success : themeColors.border,
                }} />
                <Text style={{ fontSize: 11, color: themeColors.textMuted, marginTop: 2 }}>
                  {viewingFriend.last_active_within_48h ? 'Active' : 'Inactive'}
                </Text>
              </View>
            </View>
          </View>

          {viewingFriend.share_enabled ? (
            <View
              testID="social-friend-seven-day-card"
              style={{
                backgroundColor: themeColors.surface, borderColor: themeColors.border, borderWidth: 1,
                borderRadius: 14, padding: 16, marginBottom: 16,
              }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <Text style={{ fontSize: 11, fontWeight: '700', color: themeColors.textMuted, letterSpacing: 0.5 }}>
                  LAST 7 DAYS
                </Text>
                <Text style={{ fontSize: 11, fontWeight: '800', color: themeColors.textSecondary }}>
                  {sevenDayKeys.filter(d => friendActivityDates.has(d.key)).length}/7 active
                </Text>
              </View>
              <View style={{ flexDirection: 'row', gap: 7 }}>
                {sevenDayKeys.map(day => {
                  const active = friendActivityDates.has(day.key);
                  return (
                    <View key={day.key} style={{ flex: 1, alignItems: 'center', gap: 6 }}>
                      <View style={{
                        width: '100%',
                        height: 22,
                        borderRadius: 8,
                        backgroundColor: active ? themeColors.primary + '28' : themeColors.surfaceRaised,
                        borderWidth: 1,
                        borderColor: active ? themeColors.primary + '55' : themeColors.border,
                        overflow: 'hidden',
                      }}>
                        {active ? (
                          <LinearGradient
                            pointerEvents="none"
                            colors={[themeColors.primary + '99', themeColors.primary + '33'] as any}
                            start={{ x: 0, y: 0 }}
                            end={{ x: 1, y: 1 }}
                            style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }}
                          />
                        ) : null}
                      </View>
                      <Text style={{ fontSize: 10, fontWeight: '800', color: active ? themeColors.primary : themeColors.textMuted }}>
                        {day.label}
                      </Text>
                    </View>
                  );
                })}
              </View>
            </View>
          ) : null}

          {viewingFriend.share_enabled && !friendFeedLoading && friendFeedItems.length > 0 ? (() => {
            const item = friendFeedItems[0];
            const p = item.payload;
            const summary = p.workout_summary ?? p;
            const durationLabel = formatSocialDuration(summary.duration_seconds ?? p.duration_seconds);
            const distanceLabel = formatSocialDistance(summary.distance_miles ?? p.distance_miles);
            const date = summary.date ?? p.date;
            const dateLabel = date ? new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
            const metaParts = [dateLabel, durationLabel, distanceLabel].filter(Boolean);
            return (
              <View
                testID="social-friend-latest-workout-card"
                style={{
                  backgroundColor: themeColors.surface, borderColor: themeColors.border, borderWidth: 1,
                  borderRadius: 14, padding: 16, marginBottom: 16, gap: 8, overflow: 'hidden',
                }}>
                <LinearGradient
                  pointerEvents="none"
                  colors={[themeColors.primary + '18', 'transparent'] as any}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }}
                />
                <Text style={{ fontSize: 11, fontWeight: '700', color: themeColors.textMuted, letterSpacing: 0.5 }}>
                  LATEST WORKOUT
                </Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <View style={{
                    width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
                    backgroundColor: themeColors.primary + '18',
                  }}>
                    <Ionicons name="barbell-outline" size={17} color={themeColors.primary} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={{ fontSize: 14, fontWeight: '900', color: themeColors.textPrimary }} numberOfLines={1}>
                      {summary.focus ?? p.focus ?? 'Workout'}
                    </Text>
                    <Text style={{ fontSize: 11, fontWeight: '700', color: themeColors.textMuted, marginTop: 2 }} numberOfLines={1}>
                      {metaParts.join('  ·  ')}
                    </Text>
                  </View>
                </View>
              </View>
            );
          })() : null}

          {viewingFriend.share_enabled && friendPrItems.length > 0 ? (
            <View
              testID="social-friend-pr-card"
              style={{
                backgroundColor: themeColors.surface, borderColor: themeColors.border, borderWidth: 1,
                borderRadius: 14, padding: 16, marginBottom: 16, gap: 8,
              }}>
              <Text style={{ fontSize: 11, fontWeight: '700', color: themeColors.textMuted, letterSpacing: 0.5 }}>
                RECENT PRS
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7 }}>
                {friendPrItems.slice(0, 4).map((pr, i) => {
                  const typeLabel = String(pr.payload.pr_type ?? '').replace(/_/g, ' ');
                  const value = pr.payload.value != null ? ` · ${pr.payload.value} ${pr.payload.unit ?? 'lbs'}` : '';
                  return (
                    <View key={`${pr.id}-${i}`} style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 5,
                      maxWidth: '100%',
                      paddingHorizontal: 9,
                      paddingVertical: 5,
                      borderRadius: 12,
                      borderWidth: 1,
                      borderColor: (themeColors.warning ?? '#F59E0B') + '45',
                      backgroundColor: (themeColors.warning ?? '#F59E0B') + '12',
                    }}>
                      <Ionicons name="trophy-outline" size={12} color={themeColors.warning ?? '#F59E0B'} />
                      <Text style={{ fontSize: 11, fontWeight: '800', color: themeColors.textSecondary }} numberOfLines={1}>
                        {pr.payload.exercise ?? 'Exercise'}{typeLabel ? ` · ${typeLabel}` : ''}{value}
                      </Text>
                    </View>
                  );
                })}
              </View>
            </View>
          ) : null}

          {viewingFriend.share_enabled && viewingFriend.streak >= 3 && (
            <View style={{
              backgroundColor: themeColors.surface, borderColor: themeColors.border, borderWidth: 1,
              borderRadius: 14, padding: 16, marginBottom: 16, flexDirection: 'row', alignItems: 'center', gap: 12,
            }}>
              <Ionicons name="flame" size={22} color="#F59E0B" />
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 13, fontWeight: '700', color: themeColors.textPrimary }}>
                  {viewingFriend.streak}-day streak
                </Text>
                <Text style={{ fontSize: 11, color: themeColors.textMuted, marginTop: 2 }}>
                  {viewingFriend.streak >= 14 ? 'Incredibly consistent!' : viewingFriend.streak >= 7 ? 'On a roll this week.' : 'Building momentum.'}
                </Text>
              </View>
            </View>
          )}

          {viewingFriend.share_enabled && (
            <>
              {friendFeedLoading && (
                <View style={{ alignItems: 'center', paddingVertical: 20 }}>
                  <ActivityIndicator size="small" color={themeColors.primary} />
                </View>
              )}
              {!friendFeedLoading && friendFeedItems.length === 0 && (
                <View style={{
                  backgroundColor: themeColors.surface, borderColor: themeColors.border, borderWidth: 1,
                  borderRadius: 14, padding: 20, alignItems: 'center', marginBottom: 16,
                }}>
                  <Ionicons name="barbell-outline" size={24} color={themeColors.textMuted} />
                  <Text style={{ fontSize: 12, color: themeColors.textMuted, marginTop: 8, textAlign: 'center' }}>
                    No sessions logged this week yet.
                  </Text>
                </View>
              )}
              {!friendFeedLoading && friendFeedItems.map((item, index) => {
                const p = item.payload;
                const summary = p.workout_summary ?? p;
                const isExpanded = expandedFeedItemId === item.id;
                const durationLabel = formatSocialDuration(summary.duration_seconds ?? p.duration_seconds);
                const distanceLabel = formatSocialDistance(summary.distance_miles ?? p.distance_miles);
                const exerciseCount = p.exercise_count ?? summary.exercises?.length ?? 0;
                const date = summary.date ?? p.date;
                const dateLabel = date ? new Date(date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : '';
                const metaParts = [dateLabel, durationLabel, distanceLabel, exerciseCount ? `${exerciseCount} exercises` : ''].filter(Boolean);
                return (
                  <TouchableOpacity
                    key={item.id}
                    testID={`social-friend-feed-row-${index}`}
                    accessibilityLabel={`social-friend-feed-row-${index}`}
                    accessibilityState={{ expanded: isExpanded }}
                    activeOpacity={0.85}
                    onPress={() => {
                      configureExpandAnimation(320);
                      import('../utils/feedback').then(f => f.hapticSelection()).catch(() => {});
                      setExpandedFeedItemId(isExpanded ? null : item.id);
                    }}
                    style={{
                      backgroundColor: themeColors.surface, borderColor: isExpanded ? themeColors.primary + '45' : themeColors.border, borderWidth: 1,
                      borderRadius: 14, marginBottom: 10, overflow: 'hidden',
                    }}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center', padding: 14, gap: 10 }}>
                      <View style={{
                        width: 36, height: 36, borderRadius: 10, backgroundColor: themeColors.primary + '18',
                        alignItems: 'center', justifyContent: 'center',
                      }}>
                        <Ionicons name="barbell-outline" size={18} color={themeColors.primary} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 14, fontWeight: '800', color: themeColors.textPrimary }}>{summary.focus ?? p.focus ?? 'Workout'}</Text>
                        <Text style={{ fontSize: 11, color: themeColors.textMuted, marginTop: 1 }}>
                          {metaParts.join('  ·  ')}
                        </Text>
                      </View>
                      <Ionicons name={isExpanded ? 'chevron-up' : 'chevron-down'} size={16} color={themeColors.textMuted} />
                    </View>
                    {isExpanded && (() => {
                      const exercises: Array<{ name: string; sets: Array<Record<string, any>> }> =
                        p.exercises ?? p.workout_summary?.exercises ?? [];
                      if (exercises.length === 0) {
                        return (
                          <View style={{ borderTopWidth: 1, borderTopColor: themeColors.border, padding: 14 }}>
                            <Text style={{ fontSize: 12, color: themeColors.textMuted }}>No exercise detail available.</Text>
                          </View>
                        );
                      }
                      return (
                        <View style={{ borderTopWidth: 1, borderTopColor: themeColors.border, paddingHorizontal: 14, paddingVertical: 10, gap: 10 }}>
                          {exercises.map((ex, ei) => {
                            const setSummaries = compactSocialSetSummaries(ex.sets as any);
                            return (
                              <FadeInView key={ei} delay={Math.min(ei * 35, 160)} duration={220} slideDistance={6}>
                                <View
                                  testID={`social-friend-feed-row-${index}-exercise-${ei}`}
                                  accessibilityLabel={`social-friend-feed-row-${index}-exercise-${ei}`}
                                  style={{
                                    flexDirection: 'row', gap: 10, alignItems: 'flex-start',
                                    backgroundColor: themeColors.surfaceRaised,
                                    borderWidth: 1, borderColor: themeColors.border,
                                    borderRadius: 12, padding: 10,
                                  }}>
                                  <View style={{
                                    width: 22, height: 22, borderRadius: 7,
                                    alignItems: 'center', justifyContent: 'center',
                                    backgroundColor: themeColors.primary + '12',
                                    borderWidth: 1, borderColor: themeColors.primary + '25',
                                  }}>
                                    <Text style={{ fontSize: 10, fontWeight: '800', color: themeColors.primary }}>{ei + 1}</Text>
                                  </View>
                                  <View style={{ flex: 1, gap: 7 }}>
                                    <Text style={{ fontSize: 13, fontWeight: '800', color: themeColors.textPrimary }}>{ex.name}</Text>
                                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                                      {(setSummaries.length ? setSummaries : [`${ex.sets?.length ?? 0} sets`]).map((label, si) => (
                                        <View key={`${ei}-${si}-${label}`} style={{
                                          paddingHorizontal: 8, paddingVertical: 5,
                                          borderRadius: 8,
                                          backgroundColor: themeColors.primary + '10',
                                          borderWidth: 1,
                                          borderColor: themeColors.primary + '22',
                                        }}>
                                          <Text style={{ fontSize: 11, color: themeColors.textSecondary, fontWeight: '700', lineHeight: 14 }}>
                                            {label}
                                          </Text>
                                        </View>
                                      ))}
                                    </View>
                                  </View>
                                </View>
                              </FadeInView>
                            );
                          })}
                        </View>
                      );
                    })()}
                  </TouchableOpacity>
                );
              })}
            </>
          )}

          {!viewingFriend.share_enabled ? (
            <View style={{
              backgroundColor: themeColors.surface, borderColor: themeColors.border, borderWidth: 1,
              borderRadius: 14, padding: 20, alignItems: 'center',
            }}>
              <Ionicons name="eye-off-outline" size={28} color={themeColors.textMuted} />
              <Text style={{ fontSize: 13, color: themeColors.textSecondary, marginTop: 8, textAlign: 'center' }}>
                This friend has activity sharing turned off.
              </Text>
            </View>
          ) : null}
        </ScrollView>
      ) : (
        <FriendsModal
          visible={false}
          authToken={authToken}
          onClose={() => {}}
          themeName={themeName}
          inline
          onSocialCountsChange={onSocialCountsChange}
          initialSearchUsername={initialSearchUsername}
          onInitialSearchConsumed={onInitialSearchConsumed}
          onViewFriend={(_userId, _displayName, digestFriend) => openFriend(digestFriend)}
        />
      )}
    </View>
  );
}

export default memo(HomeFriendsTabInner);
