// Activity feed for friends. Renders the cross-friends feed
// (`/social/feed`) backed by the `ActivityFeedItem` table that's already
// fully implemented server-side. Each item is a workout post with
// optional caption, photo, and a structured `workout_summary` (focus,
// duration, exercises, sets/reps).
//
// Privacy rule: this view never reads or displays kcal/macros/weight.
// The feed payload only contains workout data — same boundary the
// digest enforces. Items from soft-deleted users render as "unknown"
// (the backend filter drops them from the user_cache lookup).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, FlatList, Image, RefreshControl,
  StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getTheme, radius } from '../constants/theme';
import type { AppThemeName } from '../types';
import {
  FeedItem,
  getSocialFeed,
  toggleFeedLike,
  deleteSocialPost,
} from '../services/api';

interface Props {
  authToken: string;
  themeName?: AppThemeName;
  /** When set, tapping the author name calls this with their user_id.
   *  Parent typically opens the same friend detail surface used from
   *  the Friends list so feed → detail navigation feels consistent. */
  onViewAuthor?: (userId: number, displayName: string) => void;
  /** Called when the user taps the "Share Workout" CTA. Parent surfaces
   *  the actual post-create modal (caption, optional photo). */
  onComposePost?: () => void;
  /** Bumped by the parent every time it wants the feed to refetch
   *  (e.g., after a successful post). Re-fires `loadInitial`. */
  refreshKey?: number;
}

const PAGE_SIZE = 30;

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
  authToken, themeName, onViewAuthor, onComposePost, refreshKey,
}: Props) {
  const theme = getTheme(themeName);
  const colors = theme.colors;
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [items, setItems] = useState<FeedItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [paging, setPaging] = useState(false);
  // Optimistic like state — keyed by feed item id. Lets the heart
  // animate instantly while the network call is in flight; rolls back
  // on failure.
  const [pendingLikes, setPendingLikes] = useState<Record<number, boolean>>({});
  // Load-more guards: track the last `before_id` we requested so a
  // user scrolling fast doesn't hammer the backend on every onEndReached.
  const lastBeforeIdRef = useRef<number | null>(null);
  const exhaustedRef = useRef(false);

  const loadInitial = useCallback(async () => {
    setLoading(true);
    try {
      const r = await getSocialFeed(authToken);
      setItems(r.items);
      lastBeforeIdRef.current = r.items.length ? r.items[r.items.length - 1].id : null;
      exhaustedRef.current = r.items.length < PAGE_SIZE;
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
      lastBeforeIdRef.current = r.items.length ? r.items[r.items.length - 1].id : null;
      exhaustedRef.current = r.items.length < PAGE_SIZE;
    } catch { /* keep current items on transient failure */ }
    finally { setRefreshing(false); }
  }, [authToken]);

  const loadMore = useCallback(async () => {
    if (paging || exhaustedRef.current) return;
    const beforeId = lastBeforeIdRef.current;
    if (beforeId == null) return;
    setPaging(true);
    try {
      const r = await getSocialFeed(authToken, beforeId);
      if (r.items.length === 0) {
        exhaustedRef.current = true;
      } else {
        setItems(prev => [...prev, ...r.items]);
        lastBeforeIdRef.current = r.items[r.items.length - 1].id;
        if (r.items.length < PAGE_SIZE) exhaustedRef.current = true;
      }
    } catch { /* swallow — user can scroll again to retry */ }
    finally { setPaging(false); }
  }, [authToken, paging]);

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

  const handleDelete = useCallback((item: FeedItem) => {
    Alert.alert(
      'Delete this post?',
      'It will disappear from your friends\' feeds.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete', style: 'destructive', onPress: async () => {
            try {
              await deleteSocialPost(authToken, item.id);
              setItems(curr => curr.filter(it => it.id !== item.id));
            } catch (e: any) {
              Alert.alert('Could not delete', e?.message ?? 'Try again');
            }
          },
        },
      ],
    );
  }, [authToken]);

  const renderItem = useCallback(({ item }: { item: FeedItem }) => {
    const author = item.display_name ?? item.username;
    const summary = item.payload.workout_summary;
    const caption = item.payload.caption;
    const photo = item.payload.photo_base64;
    return (
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <TouchableOpacity
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
          {/* Show delete affordance only on own posts. The backend's
              ownership check still gates the destructive call. */}
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

        <View style={styles.actionRow}>
          <TouchableOpacity
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
    );
  }, [styles, colors, pendingLikes, onViewAuthor, handleLike]);

  const keyExtractor = useCallback((it: FeedItem) => String(it.id), []);

  if (loading && items.length === 0) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <FlatList
      data={items}
      keyExtractor={keyExtractor}
      renderItem={renderItem}
      contentContainerStyle={styles.listContent}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={colors.primary}
        />
      }
      onEndReached={loadMore}
      onEndReachedThreshold={0.4}
      ListEmptyComponent={
        <View style={styles.empty}>
          <Ionicons name="people-outline" size={32} color={colors.textMuted} />
          <Text style={styles.emptyTitle}>Quiet feed</Text>
          <Text style={styles.emptyBody}>
            When friends share their workouts, they'll show up here. Be the first?
          </Text>
          {onComposePost ? (
            <TouchableOpacity style={styles.shareBtn} onPress={onComposePost}>
              <Ionicons name="share-outline" size={16} color={colors.background} />
              <Text style={styles.shareBtnText}>Share a workout</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      }
      ListFooterComponent={
        paging ? (
          <View style={{ paddingVertical: 16, alignItems: 'center' }}>
            <ActivityIndicator size="small" color={colors.textMuted} />
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
    shareBtn: {
      marginTop: 14, flexDirection: 'row', gap: 6,
      paddingVertical: 9, paddingHorizontal: 16,
      backgroundColor: c.primary, borderRadius: radius.md,
      alignItems: 'center',
    },
    shareBtnText: { color: c.background, fontSize: 13, fontWeight: '700' },
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
    actionRow: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingTop: 4 },
    likeBtn: { flexDirection: 'row', alignItems: 'center', gap: 5 },
    likeCount: { fontSize: 12, color: c.textSecondary, fontWeight: '600', minWidth: 12 },
  });
}
