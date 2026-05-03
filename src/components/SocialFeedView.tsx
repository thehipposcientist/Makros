// Recent Activity digest — bounded "what's new from your friends since
// you last checked" rather than an open scrolling Strava-style feed.
//
// Why this isn't a feed: at pilot scale (5–10 friends, ~1 post/wk
// each) an aggregated feed is empty most of the time, which gives the
// worst possible first impression. Bounded recent-activity also
// sidesteps the comparison/anxiety problem fitness feeds are notorious
// for. Users who want deeper history tap a friend → see their detail
// view (which is the primary social surface).
//
// Backed by `/social/feed` (kept the endpoint name; same payload).
// Each item is a workout share with optional caption, photo, and a
// structured `workout_summary` (focus, duration, exercises, sets/reps).
//
// Privacy rule: never reads or displays kcal/macros/weight. Items
// from soft-deleted users render as "unknown" (backend filter).
//
// De-duplication: one card per (user_id, workout_date). A single
// workout can produce both an auto `workout_completed` row and a manual
// `workout_post` share. The feed groups them so workout_post beats
// workout_completed for the headline card.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, FlatList, Image, RefreshControl,
  StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getTheme, radius } from '../constants/theme';
import type { AppThemeName } from '../types';
import FadeInView from './FadeInView';
import {
  FeedItem,
  getSocialFeed,
  toggleFeedLike,
} from '../services/api';

interface Props {
  authToken: string;
  themeName?: AppThemeName;
  /** When set, tapping the author name calls this with their user_id.
   *  Parent typically opens the same friend detail surface used from
   *  the Friends list so activity → detail navigation feels consistent. */
  onViewAuthor?: (userId: number, displayName: string) => void;
  /** Bumped by the parent every time it wants activity to refetch
   *  (e.g., after a successful share). Re-fires `loadInitial`. */
  refreshKey?: number;
  /** Hard cap on items rendered. Keeps the digest from drifting into
   *  Instagram-style infinite scroll. Default 10 — enough to feel
   *  alive at pilot scale without becoming a doom-scroll surface. */
  maxItems?: number;
  /** Whether the current user has sharing enabled. When true a "Your
   *  Activity" summary card is pinned at the top of the feed so the
   *  user can see what their friends see. */
  shareEnabled?: boolean;
  myActivity?: { sessions: number; streak: number } | null;
  myDisplayName?: string;
  bottomPadding?: number;
}

// One bounded fetch — no pagination by design. The view is an "is
// anything new?" check, not a content destination.
const DEFAULT_MAX_ITEMS = 10;

type GroupedItem = { workout: FeedItem; prs: FeedItem[] };

function formatRelative(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso).getTime();
  if (!Number.isFinite(d)) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - d) / 1000));
  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 86400 * 7) return `${Math.floor(diffSec / 86400)}d ago`;
  return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatDuration(sec: number | undefined | null): string {
  const s = Math.max(0, Math.round(sec ?? 0));
  if (!s) return '';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

export default function SocialFeedView({
  authToken, themeName, onViewAuthor, refreshKey, maxItems,
  shareEnabled, myActivity, myDisplayName, bottomPadding = 8,
}: Props) {
  const theme = getTheme(themeName);
  const colors = theme.colors;
  const styles = useMemo(() => createStyles(colors), [colors]);
  const cap = maxItems ?? DEFAULT_MAX_ITEMS;

  const [items, setItems] = useState<FeedItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Optimistic like state — keyed by item id. Lets the heart
  // animate instantly while the network call is in flight; rolls back
  // on failure.
  const [pendingLikes, setPendingLikes] = useState<Record<number, boolean>>({});

  const loadInitial = useCallback(async () => {
    setLoading(true);
    try {
      const r = await getSocialFeed(authToken);
      setItems(r.items); // store all; deduplication happens in displayItems memo
    } catch {
      // Silent — empty-state handles "couldn't load" via UI signal.
    } finally {
      setLoading(false);
    }
  }, [authToken]);

  useEffect(() => { loadInitial(); }, [loadInitial, refreshKey]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const r = await getSocialFeed(authToken);
      setItems(r.items);
    } catch { /* keep current items on transient failure */ }
    finally { setRefreshing(false); }
  }, [authToken]);

  // Group into one card per (user_id, workout_date).
  // Two passes so PR items (written after workout_completed, thus
  // appearing earlier in the desc-sorted list) still attach correctly.
  const displayItems = useMemo((): GroupedItem[] => {
    const groups = new Map<string, GroupedItem>();

    // Pass 1: build workout cards
    for (const item of items) {
      if (item.event_type !== 'workout_completed' && item.event_type !== 'workout_post') continue;
      const date = item.payload.date ?? item.created_at.slice(0, 10);
      const key = `${item.user_id}:${date}`;
      const existing = groups.get(key);
      if (!existing) {
        groups.set(key, { workout: item, prs: [] });
      } else if (item.event_type === 'workout_post' && existing.workout.event_type !== 'workout_post') {
        // Prefer the intentional manual share over the auto-written event
        existing.workout = item;
      }
    }

    // Pass 2: attach PR badges to their parent workout card
    for (const item of items) {
      if (item.event_type !== 'pr_achieved') continue;
      const date = item.payload.date ?? item.created_at.slice(0, 10);
      const key = `${item.user_id}:${date}`;
      const g = groups.get(key);
      if (g) g.prs.push(item);
    }

    return Array.from(groups.values()).slice(0, cap);
  }, [items, cap]);

  const handleLike = useCallback(async (item: FeedItem) => {
    // Optimistic flip.
    const prevLiked = item.liked_by_me;
    const nextLiked = !prevLiked;
    setItems(curr => curr.map(it => it.id === item.id
      ? { ...it,
          liked_by_me: nextLiked,
          like_count: Math.max(0, it.like_count + (nextLiked ? 1 : -1)),
        }
      : it));
    setPendingLikes(p => ({ ...p, [item.id]: true }));
    try {
      await toggleFeedLike(authToken, item.id);
    } catch {
      // Roll back — server is the source of truth.
      setItems(curr => curr.map(it => it.id === item.id
        ? { ...it, liked_by_me: prevLiked, like_count: item.like_count }
        : it));
    } finally {
      setPendingLikes(p => {
        const { [item.id]: _, ...rest } = p;
        return rest;
      });
    }
  }, [authToken]);

  const renderItem = useCallback(({ item: grouped, index }: { item: GroupedItem; index: number }) => {
    const { workout: item, prs } = grouped;
    const author = item.display_name ?? item.username;

    // workout_post has explicit workout_summary; workout_completed stores
    // the same data at the top level of payload — normalise to one shape.
    const summary = item.payload.workout_summary ?? (
      item.event_type === 'workout_completed' ? {
        focus: item.payload.focus ?? 'Workout',
        duration_seconds: item.payload.duration_seconds ?? 0,
        date: item.payload.date ?? '',
        exercises: (item.payload.exercises ?? []).map((ex: any) => ({
          name: ex.name,
          sets: (ex.sets ?? []).map((s: any) => ({ reps: s.reps })),
        })),
        total_sets: (item.payload.exercises ?? [])
          .reduce((t: number, ex: any) => t + (ex.sets?.length ?? 0), 0),
        total_reps: (item.payload.exercises ?? [])
          .reduce((t: number, ex: any) =>
            t + (ex.sets ?? []).reduce((r: number, s: any) => r + (s.reps || 0), 0), 0),
        training_rating: undefined as string | undefined,
      } : null
    );

    const caption = item.payload.caption;
    const photo = item.payload.photo_base64;

    return (
      <FadeInView delay={Math.min(index * 45, 260)} duration={280} slideDistance={10}>
      <View testID={`social-feed-row-${index}`} style={styles.card}>
        <View style={styles.cardHeader}>
          <TouchableOpacity
            testID={`social-feed-author-${index}`}
            accessibilityLabel={`social-feed-author-${index}`}
            onPress={() => onViewAuthor?.(item.user_id, author)}
            hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
            style={styles.authorRow}
          >
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>
                {(author[0] ?? '?').toUpperCase()}
              </Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.authorName} numberOfLines={1}>{author}</Text>
              <Text style={styles.authorMeta} numberOfLines={1}>
                @{item.username}  ·  {formatRelative(item.created_at)}
              </Text>
            </View>
          </TouchableOpacity>
        </View>

        {caption ? (
          <Text style={styles.caption}>{caption}</Text>
        ) : null}

        {photo ? (
          <Image
            source={{ uri: `data:image/jpeg;base64,${photo}` }}
            style={styles.photo}
            resizeMode="cover"
          />
        ) : null}

        {summary ? (
          <View style={styles.summaryBlock}>
            <View style={styles.summaryHeader}>
              <Ionicons name="barbell-outline" size={14} color={colors.textSecondary} />
              <Text style={styles.summaryFocus}>{summary.focus || 'Workout'}</Text>
              {summary.duration_seconds ? (
                <Text style={styles.summaryDuration}>
                  {formatDuration(summary.duration_seconds)}
                </Text>
              ) : null}
            </View>
            <View style={styles.summaryStatsRow}>
              <Text style={styles.summaryStat}>
                <Text style={styles.summaryStatNum}>{summary.exercises?.length ?? 0}</Text>
                {' exercises'}
              </Text>
              <Text style={styles.summaryStatDot}>·</Text>
              <Text style={styles.summaryStat}>
                <Text style={styles.summaryStatNum}>{summary.total_sets ?? 0}</Text>
                {' sets'}
              </Text>
              <Text style={styles.summaryStatDot}>·</Text>
              <Text style={styles.summaryStat}>
                <Text style={styles.summaryStatNum}>{summary.total_reps ?? 0}</Text>
                {' reps'}
              </Text>
              {summary.training_rating ? (
                <>
                  <Text style={styles.summaryStatDot}>·</Text>
                  <Text style={styles.summaryStat}>{summary.training_rating}</Text>
                </>
              ) : null}
            </View>
          </View>
        ) : null}

        {prs.length > 0 ? (() => {
          // One badge per exercise — keep the most descriptive PR type.
          // heaviest_weight > estimated_1rm > volume_record. Without this,
          // a single Bench Press session hitting all three types produces
          // three identical-looking "Bench Press 225 lbs" trophies.
          const PR_PRIORITY: Record<string, number> = {
            heaviest_weight: 3, estimated_1rm: 2, volume_record: 1,
          };
          const PR_LABEL: Record<string, string> = {
            heaviest_weight: 'New max', estimated_1rm: 'New 1RM', volume_record: 'Vol PR',
          };
          const byExercise = new Map<string, FeedItem>();
          for (const pr of prs) {
            const ex = (pr.payload.exercise ?? '').toLowerCase();
            const existing = byExercise.get(ex);
            const currP = PR_PRIORITY[pr.payload.pr_type ?? ''] ?? 0;
            const exiP  = existing ? (PR_PRIORITY[existing.payload.pr_type ?? ''] ?? 0) : -1;
            if (!existing || currP > exiP) byExercise.set(ex, pr);
          }
          return (
            <View style={styles.prRow}>
              {Array.from(byExercise.values()).map((pr, i) => {
                const typeLabel = PR_LABEL[pr.payload.pr_type ?? ''];
                return (
                  <View key={i} style={styles.prBadge}>
                    <Ionicons name="trophy-outline" size={10} color={colors.warning ?? '#F59E0B'} />
                    <Text style={styles.prText} numberOfLines={1}>
                      {pr.payload.exercise}
                      {typeLabel ? `  ·  ${typeLabel}` : ''}
                      {pr.payload.value != null ? `  ${pr.payload.value} ${pr.payload.unit ?? 'lbs'}` : ''}
                    </Text>
                  </View>
                );
              })}
            </View>
          );
        })() : null}

        <View style={styles.actionRow}>
          <TouchableOpacity
            testID={`social-feed-like-${index}`}
            accessibilityLabel={`social-feed-like-${index}`}
            onPress={() => handleLike(item)}
            disabled={!!pendingLikes[item.id]}
            style={styles.likeBtn}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons
              name={item.liked_by_me ? 'heart' : 'heart-outline'}
              size={20}
              color={item.liked_by_me ? colors.error : colors.textSecondary}
            />
            <Text style={[styles.likeCount, item.liked_by_me && { color: colors.error }]}>
              {item.like_count > 0 ? item.like_count : ''}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
      </FadeInView>
    );
  }, [styles, colors, pendingLikes, onViewAuthor, handleLike]);

  const keyExtractor = useCallback((it: GroupedItem) => String(it.workout.id), []);

  if (loading && items.length === 0) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  const myActivityHeader = shareEnabled && myActivity ? (
    <FadeInView delay={0} duration={260} slideDistance={8}>
    <View style={[styles.card, styles.myActivityCard]}>
      <View style={styles.cardHeader}>
        <View style={styles.authorRow}>
          <View style={[styles.avatar, styles.myAvatar]}>
            <Text style={styles.avatarText}>
              {((myDisplayName ?? '')[0] ?? 'Y').toUpperCase()}
            </Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.authorName}>
              {myDisplayName || 'You'}
              <Text style={styles.myLabel}>  ·  Your activity</Text>
            </Text>
            <Text style={styles.authorMeta}>Shared with friends</Text>
          </View>
          <View style={styles.sharingBadge}>
            <Ionicons name="globe-outline" size={11} color={colors.primary} />
            <Text style={styles.sharingBadgeText}>Sharing on</Text>
          </View>
        </View>
      </View>
      <View style={styles.summaryBlock}>
        <View style={styles.summaryStatsRow}>
          <Text style={styles.summaryStat}>
            <Text style={styles.summaryStatNum}>{myActivity.sessions}</Text>
            {` session${myActivity.sessions === 1 ? '' : 's'} this week`}
          </Text>
          {myActivity.streak > 0 && (
            <>
              <Text style={styles.summaryStatDot}>·</Text>
              <Text style={styles.summaryStat}>
                <Text style={styles.summaryStatNum}>{myActivity.streak}</Text>
                {myActivity.streak === 1 ? ' day streak' : ' day streak'}
              </Text>
            </>
          )}
        </View>
        {myActivity.sessions === 0 && (
          <Text style={[styles.authorMeta, { marginTop: 2 }]}>
            Log a workout this week to appear in your friends' feeds.
          </Text>
        )}
      </View>
    </View>
    </FadeInView>
  ) : null;
  const privacyHeader = (
    <View style={styles.privacyStrip}>
      <Ionicons name="shield-checkmark-outline" size={16} color={colors.primary} />
      <Text style={styles.privacyText}>
        Friends only see workouts, streaks, and optional shares. Calories, macros, meals, body weight, and measurements stay private.
      </Text>
    </View>
  );
  const listHeader = (
    <>
      {privacyHeader}
      {myActivityHeader}
    </>
  );

  return (
    <FlatList
      testID="social-feed-list"
      data={displayItems}
      keyExtractor={keyExtractor}
      renderItem={renderItem}
      contentContainerStyle={[styles.listContent, { paddingBottom: bottomPadding }]}
      ListHeaderComponent={listHeader}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={colors.primary}
        />
      }
      ListEmptyComponent={
        <FadeInView delay={0} duration={240} slideDistance={8}>
        <View style={styles.empty}>
          <Ionicons name="checkmark-circle-outline" size={28} color={colors.textMuted} />
          <Text style={styles.emptyTitle}>You're all caught up</Text>
          <Text style={styles.emptyBody}>
            Nothing new from your friends right now. Pull to refresh.
          </Text>
        </View>
        </FadeInView>
      }
      ListFooterComponent={
        displayItems.length >= cap ? (
          <View style={{ paddingVertical: 14, alignItems: 'center' }}>
            <Text style={{ fontSize: 11, color: colors.textMuted }}>
              Showing latest {cap}. Older activity lives on each friend's profile.
            </Text>
          </View>
        ) : null
      }
    />
  );
}

function createStyles(c: ReturnType<typeof getTheme>['colors']) {
  return StyleSheet.create({
    listContent: { paddingVertical: 8, paddingHorizontal: 12, gap: 10 },
    center: { paddingVertical: 40, alignItems: 'center', justifyContent: 'center' },
    empty: { paddingVertical: 60, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 28 },
    emptyTitle: { fontSize: 16, fontWeight: '700', color: c.textPrimary, marginTop: 8 },
    emptyBody: { fontSize: 13, color: c.textSecondary, textAlign: 'center', lineHeight: 18 },
    privacyStrip: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 8,
      backgroundColor: c.primary + '12',
      borderColor: c.primary + '30',
      borderWidth: 1,
      borderRadius: radius.md,
      padding: 12,
    },
    privacyText: { flex: 1, fontSize: 11, color: c.textSecondary, lineHeight: 16, fontWeight: '600' },
    card: {
      backgroundColor: c.surfaceRaised,
      borderRadius: radius.lg,
      padding: 14,
      gap: 10,
      borderWidth: 1,
      borderColor: c.border,
    },
    cardHeader: { flexDirection: 'row', alignItems: 'center' },
    authorRow: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 },
    avatar: {
      width: 36, height: 36, borderRadius: 18,
      backgroundColor: c.surface,
      alignItems: 'center', justifyContent: 'center',
      borderWidth: 1, borderColor: c.border,
    },
    avatarText: { fontSize: 14, fontWeight: '700', color: c.textPrimary },
    authorName: { fontSize: 14, fontWeight: '700', color: c.textPrimary },
    authorMeta: { fontSize: 11, color: c.textMuted, marginTop: 1 },
    caption: { fontSize: 14, color: c.textPrimary, lineHeight: 19 },
    photo: {
      width: '100%', aspectRatio: 4 / 3, borderRadius: radius.md,
      backgroundColor: c.surface,
    },
    summaryBlock: {
      backgroundColor: c.surface,
      borderRadius: radius.md,
      padding: 10,
      gap: 6,
    },
    summaryHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    summaryFocus: { flex: 1, fontSize: 13, fontWeight: '700', color: c.textPrimary, textTransform: 'capitalize' },
    summaryDuration: { fontSize: 12, color: c.textSecondary, fontWeight: '600' },
    summaryStatsRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
    summaryStat: { fontSize: 12, color: c.textSecondary },
    summaryStatNum: { fontWeight: '700', color: c.textPrimary },
    summaryStatDot: { fontSize: 12, color: c.textMuted },
    prRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    prBadge: {
      flexDirection: 'row', alignItems: 'center', gap: 4,
      paddingHorizontal: 8, paddingVertical: 3,
      backgroundColor: c.surface,
      borderRadius: 10, borderWidth: 1, borderColor: c.border,
    },
    prText: { fontSize: 11, fontWeight: '600', color: c.textSecondary, maxWidth: 160 },
    actionRow: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingTop: 4 },
    likeBtn: { flexDirection: 'row', alignItems: 'center', gap: 5 },
    likeCount: { fontSize: 12, color: c.textSecondary, fontWeight: '600', minWidth: 12 },
    myActivityCard: { borderColor: c.primary + '40' },
    myAvatar: { backgroundColor: c.primary + '20', borderColor: c.primary + '40' },
    myLabel: { fontSize: 12, fontWeight: '400', color: c.textMuted },
    sharingBadge: {
      flexDirection: 'row', alignItems: 'center', gap: 3,
      paddingHorizontal: 7, paddingVertical: 3,
      borderRadius: 10, backgroundColor: c.primary + '15',
    },
    sharingBadgeText: { fontSize: 10, fontWeight: '700', color: c.primary },
  });
}
