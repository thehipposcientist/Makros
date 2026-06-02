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
// structured `workout_summary` (focus, duration, exercises, sets/reps,
// workout loads, and cardio timing/distance metrics).
//
// Privacy rule: never reads or displays kcal/macros/body weight. Items
// from soft-deleted users render as "unknown" (backend filter).
//
// De-duplication: one card per (user_id, workout_date). A single
// workout can produce both an auto `workout_completed` row and a manual
// `workout_post` share. The feed groups them so workout_post keeps
// the headline card while preserving the richest exercise details.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Animated, Dimensions, FlatList, Image, Keyboard, RefreshControl,
  StyleSheet, Text, TextInput, TouchableOpacity, View,
  type KeyboardEvent,
  type ViewToken,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { getContrastingTextColor, getTheme, isLightThemeName, radius } from '../constants/theme';
import type { AppThemeName } from '../types';
import FadeInView from './FadeInView';
import ScrollRevealView from './ScrollRevealView';
import SocialAvatar from './SocialAvatar';
import {
  createFeedComment,
  deleteFeedComment,
  FeedComment,
  FeedItem,
  getSocialFeed,
  listFeedComments,
  type SocialDigest,
  toggleFeedLike,
} from '../services/api';
import { configureExpandAnimation } from '../utils/layoutAnim';
import {
  chooseSocialWorkoutFeedItem,
  compactSocialSetSummaries,
  formatSocialDistance,
  formatSocialDuration,
  socialWorkoutDateKey,
  type SocialWorkoutSet,
} from '../utils/socialWorkoutDetails';
import { humanizeToken } from '../utils/exerciseGuide';

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
  bottomPadding?: number;
  digest?: SocialDigest | null;
  friendCount?: number;
  sharingEnabled?: boolean;
  currentUserId?: number | null;
  onOpenFriends?: () => void;
  onTurnOnSharing?: () => void;
  onShareInvite?: () => void;
}

// One bounded fetch — no pagination by design. The view is an "is
// anything new?" check, not a content destination.
const DEFAULT_MAX_ITEMS = 10;
const QUICK_REACTIONS = ['Nice lift', 'Strong finish', 'Consistency', 'PR hype'];

type GroupedItem = { workout: FeedItem; prs: FeedItem[] };
type FeedWorkoutExercise = {
  name?: string;
  equipment?: string | null;
  sets?: SocialWorkoutSet[];
};
type FeedWorkoutSummary = {
  focus?: string | null;
  duration_seconds?: number | null;
  date?: string | null;
  exercises?: FeedWorkoutExercise[];
  total_sets?: number | null;
  total_reps?: number | null;
  training_rating?: string | null;
  activity_category?: string | null;
  activity_subtype?: string | null;
  cardio_style?: string | null;
  distance_miles?: number | null;
  hr_summary?: { avgBpm?: number | null; maxBpm?: number | null } | null;
};

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

function formatWorkoutDate(dateKey: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return '';
  const d = new Date(`${dateKey}T12:00:00`);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function setReps(set: SocialWorkoutSet | undefined): number | null {
  const reps = Number(set?.reps);
  return Number.isFinite(reps) && reps > 0 ? Math.round(reps) : null;
}

function exerciseSetCount(exercises: FeedWorkoutExercise[]): number {
  return exercises.reduce((total, ex) => total + (ex.sets?.length ?? 0), 0);
}

function exerciseRepCount(exercises: FeedWorkoutExercise[]): number {
  return exercises.reduce(
    (total, ex) => total + (ex.sets ?? []).reduce((sum, set) => sum + (setReps(set) ?? 0), 0),
    0,
  );
}

function compactExerciseDetailLine(exercise: FeedWorkoutExercise): string {
  const setSummaries = compactSocialSetSummaries(exercise.sets);
  if (!setSummaries.length) {
    const count = exercise.sets?.length ?? 0;
    return count > 0 ? `${count} set${count === 1 ? '' : 's'}` : 'Logged workout';
  }
  const visible = setSummaries.slice(0, 2);
  const hidden = setSummaries.length - visible.length;
  return hidden > 0 ? `${visible.join(' · ')} · +${hidden} more` : visible.join(' · ');
}

function normalizeWorkoutSummary(item: FeedItem): FeedWorkoutSummary | null {
  const summary = item.payload.workout_summary;
  if (summary) {
    const exercises = summary.exercises ?? [];
    return {
      ...summary,
      exercises,
      total_sets: summary.total_sets ?? exerciseSetCount(exercises),
      total_reps: summary.total_reps ?? exerciseRepCount(exercises),
      activity_category: summary.activity_category ?? null,
      activity_subtype: summary.activity_subtype ?? null,
      cardio_style: summary.cardio_style ?? null,
      distance_miles: summary.distance_miles ?? null,
      hr_summary: summary.hr_summary ?? null,
    };
  }
  if (item.event_type !== 'workout_completed') return null;
  const exercises = (item.payload.exercises ?? []).map((ex) => ({
    name: ex.name,
    equipment: ex.equipment ?? null,
    sets: ex.sets ?? [],
  }));
  return {
    focus: item.payload.focus ?? 'Workout',
    duration_seconds: item.payload.duration_seconds ?? 0,
    date: item.payload.date ?? '',
    activity_category: item.payload.activity_category ?? null,
    activity_subtype: item.payload.activity_subtype ?? null,
    cardio_style: item.payload.cardio_style ?? null,
    distance_miles: item.payload.distance_miles ?? null,
    hr_summary: item.payload.hr_summary ?? null,
    exercises,
    total_sets: exerciseSetCount(exercises),
    total_reps: exerciseRepCount(exercises),
  };
}

function socialLabel(value?: string | null): string {
  return String(value ?? '')
    .replace(/_/g, ' ')
    .trim()
    .replace(/\b\w/g, ch => ch.toUpperCase());
}

function equipmentLabel(value?: string | null): string {
  return String(value ?? '')
    .split(',')
    .map(part => humanizeToken(part.trim()))
    .filter(Boolean)
    .join(', ');
}

function RotatingChevron({ expanded, color }: { expanded: boolean; color: string }) {
  const rotation = useRef(new Animated.Value(expanded ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(rotation, {
      toValue: expanded ? 1 : 0,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [expanded, rotation]);
  const rotate = rotation.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '180deg'] });
  return (
    <Animated.View style={{ transform: [{ rotate }] }}>
      <Ionicons name="chevron-down" size={16} color={color} />
    </Animated.View>
  );
}

export default function SocialFeedView({
  authToken, themeName, onViewAuthor, refreshKey, maxItems,
  bottomPadding = 8,
  digest,
  friendCount = 0,
  sharingEnabled = false,
  currentUserId = null,
  onOpenFriends,
  onTurnOnSharing,
  onShareInvite,
}: Props) {
  const theme = getTheme(themeName);
  const colors = theme.colors;
  const isLightTheme = isLightThemeName(theme.name);
  const styles = useMemo(() => createStyles(colors, isLightTheme), [colors, isLightTheme]);
  const cap = maxItems ?? DEFAULT_MAX_ITEMS;

  const [items, setItems] = useState<FeedItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedWorkoutIds, setExpandedWorkoutIds] = useState<Record<number, boolean>>({});
  const [revealedWorkoutIds, setRevealedWorkoutIds] = useState<Record<number, boolean>>({});
  // Optimistic like state — keyed by item id. Lets the heart
  // animate instantly while the network call is in flight; rolls back
  // on failure.
  const [pendingLikes, setPendingLikes] = useState<Record<number, boolean>>({});
  const [expandedCommentIds, setExpandedCommentIds] = useState<Record<number, boolean>>({});
  const [commentRows, setCommentRows] = useState<Record<number, FeedComment[]>>({});
  const [commentDrafts, setCommentDrafts] = useState<Record<number, string>>({});
  const [loadingComments, setLoadingComments] = useState<Record<number, boolean>>({});
  const [postingComments, setPostingComments] = useState<Record<number, boolean>>({});
  const [deletingComments, setDeletingComments] = useState<Record<number, boolean>>({});
  const [quickReactionPending, setQuickReactionPending] = useState<Record<string, boolean>>({});
  const listRef = useRef<FlatList<GroupedItem> | null>(null);
  const scrollYRef = useRef(0);
  const commentInputRowsRef = useRef<Record<number, View | null>>({});
  const focusedCommentItemIdRef = useRef<number | null>(null);
  const keyboardTopYRef = useRef<number | null>(null);
  const centerCommentTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const feedViewabilityConfig = useRef({ itemVisiblePercentThreshold: 18, minimumViewTime: 60 }).current;
  const onViewableFeedItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken<GroupedItem>[] }) => {
    setRevealedWorkoutIds(prev => {
      let changed = false;
      const next = { ...prev };
      viewableItems.forEach(token => {
        const workoutId = token.item?.workout?.id;
        if (token.isViewable && workoutId != null && !next[workoutId]) {
          next[workoutId] = true;
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }).current;

  const centerCommentInput = useCallback((itemId: number, index?: number, delay = 0) => {
    focusedCommentItemIdRef.current = itemId;
    if (centerCommentTimeoutRef.current) clearTimeout(centerCommentTimeoutRef.current);
    centerCommentTimeoutRef.current = setTimeout(() => {
      requestAnimationFrame(() => {
        const inputRow = commentInputRowsRef.current[itemId];
        if (!inputRow) {
          if (index != null) {
            listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.5 });
          }
          return;
        }
        inputRow.measureInWindow((_x, y, _width, height) => {
          const inputCenterY = y + height / 2;
          const visibleBottomY = keyboardTopYRef.current ?? Dimensions.get('window').height;
          const targetCenterY = Math.max(140, visibleBottomY / 2);
          const deltaY = inputCenterY - targetCenterY;
          if (Math.abs(deltaY) < 12) return;
          listRef.current?.scrollToOffset({
            offset: Math.max(0, scrollYRef.current + deltaY),
            animated: true,
          });
        });
      });
    }, delay);
  }, []);

  useEffect(() => () => {
    if (centerCommentTimeoutRef.current) clearTimeout(centerCommentTimeoutRef.current);
  }, []);

  useEffect(() => {
    const onKeyboardShow = (event: KeyboardEvent) => {
      keyboardTopYRef.current = event.endCoordinates.screenY || null;
      const itemId = focusedCommentItemIdRef.current;
      if (itemId != null) centerCommentInput(itemId, undefined, 80);
    };
    const onKeyboardHide = () => {
      keyboardTopYRef.current = null;
    };
    const showSub = Keyboard.addListener('keyboardDidShow', onKeyboardShow);
    const changeSub = Keyboard.addListener('keyboardDidChangeFrame', onKeyboardShow);
    const hideSub = Keyboard.addListener('keyboardDidHide', onKeyboardHide);
    return () => {
      showSub.remove();
      changeSub.remove();
      hideSub.remove();
    };
  }, [centerCommentInput]);

  const loadInitial = useCallback(async () => {
    setLoading(true);
    try {
      const r = await getSocialFeed(authToken, { limit: cap });
      setItems(r.items); // store all; deduplication happens in displayItems memo
    } catch {
      // Silent — empty-state handles "couldn't load" via UI signal.
    } finally {
      setLoading(false);
    }
  }, [authToken, cap]);

  useEffect(() => { loadInitial(); }, [loadInitial, refreshKey]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const r = await getSocialFeed(authToken, { limit: cap });
      setItems(r.items);
    } catch { /* keep current items on transient failure */ }
    finally { setRefreshing(false); }
  }, [authToken, cap]);

  // Group into one card per (user_id, workout_date).
  // Two passes so PR items (written after workout_completed, thus
  // appearing earlier in the desc-sorted list) still attach correctly.
  const displayItems = useMemo((): GroupedItem[] => {
    const groups = new Map<string, GroupedItem>();

    // Pass 1: build workout cards
    for (const item of items) {
      if (item.event_type !== 'workout_completed' && item.event_type !== 'workout_post') continue;
      const date = socialWorkoutDateKey(item);
      const key = `${item.user_id}:${date}`;
      const existing = groups.get(key);
      if (!existing) {
        groups.set(key, { workout: item, prs: [] });
      } else {
        existing.workout = chooseSocialWorkoutFeedItem(existing.workout, item);
      }
    }

    // Pass 2: attach PR badges to their parent workout card
    for (const item of items) {
      if (item.event_type !== 'pr_achieved') continue;
      const date = socialWorkoutDateKey(item);
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
      const result = await toggleFeedLike(authToken, item.id);
      setItems(curr => curr.map(it => it.id === item.id
        ? { ...it,
            liked_by_me: result.liked,
            like_count: Math.max(0, Number(result.like_count) || 0),
          }
        : it));
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

  const updateCommentSummary = useCallback((itemId: number, comments: FeedComment[], count: number) => {
    setItems(curr => curr.map(it => it.id === itemId
      ? {
          ...it,
          comment_count: Math.max(0, Number(count) || 0),
          recent_comments: comments.slice(-2),
        }
      : it));
  }, []);

  const loadComments = useCallback(async (itemId: number) => {
    setLoadingComments(curr => ({ ...curr, [itemId]: true }));
    try {
      const result = await listFeedComments(authToken, itemId);
      setCommentRows(curr => ({ ...curr, [itemId]: result.items }));
      updateCommentSummary(itemId, result.items, result.comment_count);
    } catch {
      // Keep the preview comments if a full load fails.
    } finally {
      setLoadingComments(curr => {
        const { [itemId]: _, ...rest } = curr;
        return rest;
      });
    }
  }, [authToken, updateCommentSummary]);

  const toggleComments = useCallback((item: FeedItem, index: number) => {
    const opening = !expandedCommentIds[item.id];
    configureExpandAnimation(260);
    import('../utils/feedback').then(f => f.hapticSelection()).catch(() => {});
    setExpandedCommentIds(prev => ({ ...prev, [item.id]: opening }));
    if (opening && !commentRows[item.id]) void loadComments(item.id);
    if (opening) centerCommentInput(item.id, index, 320);
  }, [centerCommentInput, commentRows, expandedCommentIds, loadComments]);

  const submitComment = useCallback(async (item: FeedItem) => {
    const body = (commentDrafts[item.id] ?? '').trim();
    if (!body || postingComments[item.id]) return;
    setPostingComments(curr => ({ ...curr, [item.id]: true }));
    try {
      const result = await createFeedComment(authToken, item.id, body);
      const next = [...(commentRows[item.id] ?? item.recent_comments ?? []), result.comment];
      setCommentRows(curr => ({ ...curr, [item.id]: next }));
      setCommentDrafts(curr => ({ ...curr, [item.id]: '' }));
      setExpandedCommentIds(curr => ({ ...curr, [item.id]: true }));
      updateCommentSummary(item.id, next, result.comment_count);
    } catch {
      // Server remains authoritative; leave draft intact so the user can retry.
    } finally {
      setPostingComments(curr => {
        const { [item.id]: _, ...rest } = curr;
        return rest;
      });
    }
  }, [authToken, commentDrafts, commentRows, postingComments, updateCommentSummary]);

  const submitQuickReaction = useCallback(async (item: FeedItem, body: string) => {
    const key = `${item.id}:${body}`;
    if (quickReactionPending[key]) return;
    setQuickReactionPending(curr => ({ ...curr, [key]: true }));
    try {
      const result = await createFeedComment(authToken, item.id, body);
      const next = [...(commentRows[item.id] ?? item.recent_comments ?? []), result.comment];
      setCommentRows(curr => ({ ...curr, [item.id]: next }));
      updateCommentSummary(item.id, next, result.comment_count);
      import('../utils/feedback').then(f => f.hapticSuccess?.()).catch(() => {});
    } catch {
      // Quick reactions are best-effort; the full comment box remains available.
    } finally {
      setQuickReactionPending(curr => {
        const { [key]: _, ...rest } = curr;
        return rest;
      });
    }
  }, [authToken, commentRows, quickReactionPending, updateCommentSummary]);

  const removeComment = useCallback(async (item: FeedItem, comment: FeedComment) => {
    if (deletingComments[comment.id]) return;
    setDeletingComments(curr => ({ ...curr, [comment.id]: true }));
    try {
      const result = await deleteFeedComment(authToken, item.id, comment.id);
      const next = (commentRows[item.id] ?? item.recent_comments ?? []).filter(c => c.id !== comment.id);
      setCommentRows(curr => ({ ...curr, [item.id]: next }));
      updateCommentSummary(item.id, next, result.comment_count);
    } catch {
      // Next feed refresh reconciles.
    } finally {
      setDeletingComments(curr => {
        const { [comment.id]: _, ...rest } = curr;
        return rest;
      });
    }
  }, [authToken, commentRows, deletingComments, updateCommentSummary]);

  const renderItem = useCallback(({ item: grouped, index }: { item: GroupedItem; index: number }) => {
    const { workout: item, prs } = grouped;
    const author = item.display_name ?? item.username;
    const summary = normalizeWorkoutSummary(item);
    const exercises = summary?.exercises ?? [];
    const hasExerciseDetails = exercises.length > 0;
    const isExpanded = !!expandedWorkoutIds[item.id];
    const summaryMetrics = summary ? [
      { key: 'time', icon: 'time-outline', text: formatSocialDuration(summary.duration_seconds) },
      { key: 'exercises', icon: 'barbell-outline', text: `${summary.exercises?.length ?? 0} moves` },
      { key: 'sets', icon: 'layers-outline', text: `${summary.total_sets ?? 0} sets` },
      ...(summary.total_reps ? [{ key: 'reps', icon: 'repeat-outline', text: `${summary.total_reps} reps` }] : []),
      ...(summary.distance_miles ? [{ key: 'distance', icon: 'map-outline', text: formatSocialDistance(summary.distance_miles) }] : []),
      ...(summary.hr_summary?.avgBpm ? [{ key: 'hr', icon: 'heart-outline', text: `${Math.round(Number(summary.hr_summary.avgBpm))} bpm` }] : []),
    ].filter(metric => !!metric.text) : [];
    const summarySubtitle = summary
      ? [summary.activity_subtype, summary.cardio_style].map(socialLabel).filter(Boolean).join(' · ')
      : '';

    const caption = item.payload.caption;
    const photo = item.payload.photo_base64;
    const dateLabel = formatWorkoutDate(socialWorkoutDateKey(item));
    const metaLabel = [`@${item.username}`, dateLabel, formatRelative(item.created_at)].filter(Boolean).join('  ·  ');
    const commentsOpen = !!expandedCommentIds[item.id];
    const loadedComments = commentRows[item.id];
    const previewComments = item.recent_comments ?? [];
    const shownComments = commentsOpen ? (loadedComments ?? previewComments) : [];
    const commentCount = Math.max(0, Number(item.comment_count) || 0);
    const commentDraft = commentDrafts[item.id] ?? '';
    const commentsToggleLabel = commentsOpen
      ? 'Hide comments'
      : (commentCount > 0 ? `View ${commentCount} comment${commentCount === 1 ? '' : 's'}` : 'Comment');
    const canQuickReact = currentUserId != null && item.user_id !== currentUserId;
    const cardAccent = prs.length > 0 ? (colors.warning ?? '#F59E0B') : colors.primary;

    return (
      <ScrollRevealView active={index < 2 || !!revealedWorkoutIds[item.id]} index={index} revealDistance={14}>
      <View testID={`social-feed-row-${index}`} style={styles.card}>
        <LinearGradient
          pointerEvents="none"
          colors={[cardAccent + '18', 'transparent'] as any}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.cardWash}
        />
        <View style={styles.cardHeader}>
          <TouchableOpacity
            testID={`social-feed-author-${index}`}
            accessibilityLabel={`social-feed-author-${index}`}
            onPress={() => onViewAuthor?.(item.user_id, author)}
            hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
            style={styles.authorRow}
          >
            <SocialAvatar
              avatarUrl={item.avatar_url}
              name={author}
              username={item.username}
              size={32}
              backgroundColor={colors.surface}
              borderColor={colors.border}
              textColor={colors.textPrimary}
            />
            <View style={{ flex: 1 }}>
              <Text style={styles.authorName} numberOfLines={1}>{author}</Text>
              <Text style={styles.authorMeta} numberOfLines={1}>
                {metaLabel}
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
              <View style={styles.summaryIconBadge}>
                <Ionicons name="barbell-outline" size={15} color={colors.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.summaryFocus} numberOfLines={1}>{summary.focus || 'Workout'}</Text>
                {summarySubtitle ? (
                  <Text style={styles.summarySubtitle} numberOfLines={1}>{summarySubtitle}</Text>
                ) : null}
              </View>
              {summary.training_rating ? (
                <View style={styles.ratingBadge}>
                  <Text style={styles.ratingBadgeText}>{summary.training_rating}</Text>
                </View>
              ) : null}
            </View>
            <View style={styles.summaryMetricRow}>
              {summaryMetrics.map(metric => (
                <View key={metric.key} style={styles.summaryMetricItem}>
                  <Ionicons name={metric.icon as any} size={12} color={colors.textMuted} />
                  <Text style={styles.summaryMetricText} numberOfLines={1}>{metric.text}</Text>
                </View>
              ))}
            </View>
            {hasExerciseDetails ? (
              <TouchableOpacity
                testID={`social-feed-workout-details-${index}`}
                accessibilityLabel={`social-feed-workout-details-${index}`}
                accessibilityRole="button"
                accessibilityState={{ expanded: isExpanded }}
                onPress={() => {
                  configureExpandAnimation(320);
                  import('../utils/feedback').then(f => f.hapticSelection()).catch(() => {});
                  setExpandedWorkoutIds(prev => ({ ...prev, [item.id]: !prev[item.id] }));
                }}
                style={[styles.detailsToggle, isExpanded && styles.detailsToggleActive]}
                activeOpacity={0.75}
              >
                <View style={styles.detailsToggleCopy}>
                  <Text style={styles.detailsToggleText}>{isExpanded ? 'Hide details' : 'Workout details'}</Text>
                  <Text style={styles.detailsToggleMeta}>
                    {exercises.length} exercise{exercises.length === 1 ? '' : 's'}
                  </Text>
                </View>
                <RotatingChevron expanded={isExpanded} color={colors.textMuted} />
              </TouchableOpacity>
            ) : null}
            {isExpanded ? (
              <View style={styles.exerciseList}>
                {exercises.map((ex, exerciseIndex) => {
                  const equipment = equipmentLabel(ex.equipment);
                  const setCount = ex.sets?.length ?? 0;
                  const meta = [setCount > 0 ? `${setCount} set${setCount === 1 ? '' : 's'}` : '', equipment]
                    .filter(Boolean)
                    .join(' · ');
                  return (
                    <FadeInView
                      key={`${item.id}-${exerciseIndex}-${ex.name ?? 'exercise'}`}
                      delay={Math.min(exerciseIndex * 35, 160)}
                      duration={220}
                      slideDistance={6}
                      style={[
                        styles.exerciseDetailRow,
                        exerciseIndex === 0 && styles.exerciseDetailRowFirst,
                      ]}
                    >
                    <View style={styles.exerciseLine}>
                      <View style={styles.exerciseDot} />
                      <View style={styles.exerciseCopy}>
                        <View style={styles.exerciseTitleRow}>
                          <Text style={styles.exerciseName} numberOfLines={1}>{ex.name || 'Exercise'}</Text>
                          {meta ? <Text style={styles.exerciseMeta} numberOfLines={1}>{meta}</Text> : null}
                        </View>
                        <Text style={styles.exerciseSetLine} numberOfLines={1}>
                          {compactExerciseDetailLine(ex)}
                        </Text>
                      </View>
                    </View>
                    </FadeInView>
                  );
                })}
              </View>
            ) : null}
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
          <TouchableOpacity
            testID={`social-feed-comments-${index}`}
            accessibilityLabel={`social-feed-comments-${index}`}
            accessibilityRole="button"
            accessibilityState={{ expanded: commentsOpen }}
            onPress={() => toggleComments(item, index)}
            style={[styles.commentBtn, commentsOpen && styles.commentBtnActive]}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons
              name={commentsOpen ? 'chatbubble' : 'chatbubble-outline'}
              size={19}
              color={commentsOpen ? colors.primary : colors.textSecondary}
            />
            <Text style={[styles.commentCount, commentsOpen && { color: colors.primary }]} numberOfLines={1}>
              {commentsToggleLabel}
            </Text>
            <RotatingChevron expanded={commentsOpen} color={commentsOpen ? colors.primary : colors.textMuted} />
          </TouchableOpacity>
        </View>

        {canQuickReact ? (
          <View style={styles.quickReactionRow}>
            {QUICK_REACTIONS.map(reaction => {
              const pending = !!quickReactionPending[`${item.id}:${reaction}`];
              return (
                <TouchableOpacity
                  key={reaction}
                  testID={`social-feed-reaction-${index}-${reaction.toLowerCase().replace(/\s+/g, '-')}`}
                  accessibilityLabel={`Send ${reaction}`}
                  onPress={() => submitQuickReaction(item, reaction)}
                  disabled={pending}
                  style={[styles.quickReactionChip, pending && { opacity: 0.55 }]}
                  activeOpacity={0.78}
                >
                  <Text style={styles.quickReactionText}>{pending ? 'Sending' : reaction}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        ) : null}

        {(shownComments.length > 0 || commentsOpen) ? (
          <View style={styles.commentsBlock}>
            {shownComments.map(comment => {
              const name = comment.display_name || comment.username;
              return (
                <View key={comment.id} style={styles.commentRow}>
                  <SocialAvatar
                    avatarUrl={comment.avatar_url}
                    name={name}
                    username={comment.username}
                    size={24}
                    backgroundColor={colors.surfaceRaised}
                    borderColor={colors.border}
                    textColor={colors.textPrimary}
                  />
                  <View style={styles.commentBubble}>
                    <View style={styles.commentHeader}>
                      <Text style={styles.commentAuthor} numberOfLines={1}>{name}</Text>
                      {comment.can_delete ? (
                        <TouchableOpacity
                          testID={`social-feed-comment-delete-${comment.id}`}
                          accessibilityLabel="Delete comment"
                          onPress={() => removeComment(item, comment)}
                          disabled={!!deletingComments[comment.id]}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                          style={styles.commentDeleteBtn}
                        >
                          <Ionicons name="trash-outline" size={13} color={colors.textMuted} />
                        </TouchableOpacity>
                      ) : null}
                    </View>
                    <Text style={styles.commentBody}>{comment.body}</Text>
                  </View>
                </View>
              );
            })}
            {commentsOpen && loadingComments[item.id] ? (
              <View style={styles.commentsLoading}>
                <ActivityIndicator size="small" color={colors.textMuted} />
              </View>
            ) : null}
            {commentsOpen ? (
              <View
                ref={(node) => { commentInputRowsRef.current[item.id] = node; }}
                style={styles.commentInputRow}
              >
                <TextInput
                  testID={`social-feed-comment-input-${index}`}
                  style={styles.commentInput}
                  placeholder="Add a comment"
                  placeholderTextColor={colors.textMuted}
                  value={commentDraft}
                  onChangeText={(text) => setCommentDrafts(prev => ({ ...prev, [item.id]: text }))}
                  onFocus={() => centerCommentInput(item.id, index, 120)}
                  onContentSizeChange={() => {
                    if (focusedCommentItemIdRef.current === item.id) centerCommentInput(item.id, index);
                  }}
                  multiline
                  maxLength={500}
                />
                <TouchableOpacity
                  testID={`social-feed-comment-send-${index}`}
                  accessibilityLabel="Post comment"
                  onPress={() => submitComment(item)}
                  disabled={!commentDraft.trim() || !!postingComments[item.id]}
                  style={[
                    styles.commentSendBtn,
                    (!commentDraft.trim() || !!postingComments[item.id]) && styles.commentSendBtnDisabled,
                  ]}
                  activeOpacity={0.78}
                >
                  {postingComments[item.id] ? (
                    <ActivityIndicator size="small" color={colors.textMuted} />
                  ) : (
                    <Ionicons
                      name="send"
                      size={15}
                      color={commentDraft.trim() ? colors.primary : colors.textMuted}
                    />
                  )}
                </TouchableOpacity>
              </View>
            ) : null}
          </View>
        ) : null}
      </View>
      </ScrollRevealView>
    );
  }, [
    styles,
    colors,
    expandedWorkoutIds,
    expandedCommentIds,
    commentRows,
    commentDrafts,
    loadingComments,
    postingComments,
    deletingComments,
    pendingLikes,
    revealedWorkoutIds,
    quickReactionPending,
    currentUserId,
    onViewAuthor,
    handleLike,
    toggleComments,
    submitComment,
    submitQuickReaction,
    removeComment,
  ]);

  const keyExtractor = useCallback((it: GroupedItem) => String(it.workout.id), []);

  const topFriend = useMemo(() => {
    const topId = digest?.summary.top_user_id;
    if (!topId) return null;
    return digest?.friends.find(f => f.user_id === topId) ?? null;
  }, [digest]);

  const listHeader = useMemo(() => {
    if (!digest) return null;
    const friendTotal = digest.summary.friend_count;
    const trained = digest.summary.friends_trained_this_week;
    const topLabel = topFriend && digest.summary.top_sessions > 0
      ? `${topFriend.display_name || topFriend.username} · ${digest.summary.top_sessions}`
      : 'No leader yet';
    return (
      <View style={styles.digestCard} testID="social-activity-summary-card">
        <LinearGradient
          pointerEvents="none"
          colors={[colors.primary + '22', (colors.warning ?? '#F59E0B') + '0F', 'transparent'] as any}
          locations={[0, 0.52, 1]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.cardWash}
        />
        <View style={styles.digestHeaderRow}>
          <View>
            <Text style={styles.digestLabel}>THIS WEEK</Text>
            <Text style={styles.digestTitle}>Social pulse</Text>
          </View>
          <TouchableOpacity
            style={styles.digestInviteBtn}
            onPress={onShareInvite ?? onOpenFriends}
            activeOpacity={0.78}
          >
            <Ionicons name="person-add-outline" size={14} color={colors.primary} />
            <Text style={styles.digestInviteText}>Invite</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.digestStatGrid}>
          <View style={styles.digestStat}>
            <Text style={styles.digestStatValue}>{trained}/{friendTotal}</Text>
            <Text style={styles.digestStatLabel}>trained</Text>
          </View>
          <View style={styles.digestStat}>
            <Text style={styles.digestStatValue}>{digest.summary.total_friend_sessions}</Text>
            <Text style={styles.digestStatLabel}>sessions</Text>
          </View>
          <View style={styles.digestStat}>
            <Text style={styles.digestStatValue}>{digest.you.streak}</Text>
            <Text style={styles.digestStatLabel}>your streak</Text>
          </View>
        </View>
        <View style={styles.digestFooterRow}>
          <View style={styles.digestFooterItem}>
            <Ionicons name="trophy-outline" size={13} color={colors.warning ?? '#F59E0B'} />
            <Text style={styles.digestFooterText} numberOfLines={1}>{topLabel}</Text>
          </View>
          {digest.summary.long_streak_count > 0 ? (
            <View style={styles.digestFooterItem}>
              <Ionicons name="flame-outline" size={13} color={colors.warning ?? '#F59E0B'} />
              <Text style={styles.digestFooterText}>
                {digest.summary.long_streak_count} long streak{digest.summary.long_streak_count === 1 ? '' : 's'}
              </Text>
            </View>
          ) : null}
        </View>
        {friendTotal > 0 && !sharingEnabled ? (
          <TouchableOpacity style={styles.digestSharePrompt} onPress={onTurnOnSharing} activeOpacity={0.82}>
            <Ionicons name="eye-off-outline" size={15} color={colors.warning ?? '#F59E0B'} />
            <Text style={styles.digestSharePromptText}>Sharing is off</Text>
            <Text style={styles.digestSharePromptAction}>Turn on</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    );
  }, [
    colors.primary,
    colors.warning,
    digest,
    onOpenFriends,
    onShareInvite,
    onTurnOnSharing,
    sharingEnabled,
    styles,
    topFriend,
  ]);

  const emptyConfig = useMemo(() => {
    if (friendCount === 0) {
      return {
        icon: 'person-add-outline' as const,
        title: 'Start your circle',
        body: 'Add a friend by username or send your invite link.',
        action: 'Invite friends',
        onPress: onShareInvite ?? onOpenFriends,
      };
    }
    if (!sharingEnabled) {
      return {
        icon: 'eye-off-outline' as const,
        title: 'Sharing is off',
        body: 'Your friends are connected. Turn on workout sharing when you want them to see your sessions and streak.',
        action: 'Turn on sharing',
        onPress: onTurnOnSharing,
      };
    }
    return {
      icon: 'barbell-outline' as const,
      title: 'No workouts yet',
      body: 'New friend workouts and your shared sessions will land here.',
      action: 'Find friends',
      onPress: onOpenFriends,
    };
  }, [friendCount, onOpenFriends, onShareInvite, onTurnOnSharing, sharingEnabled]);

  if (loading && items.length === 0) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  // The "Your activity" summary card that used to live here was
  // removed — the same info (sessions this week, streak) is already
  // surfaced on the Friends → Profile tab via the My Profile card,
  // and pinning it above every feed render was duplicative noise.

  return (
    <FlatList
      ref={listRef}
      testID="social-feed-list"
      data={displayItems}
      keyExtractor={keyExtractor}
      renderItem={renderItem}
      contentContainerStyle={[styles.listContent, { paddingBottom: bottomPadding }]}
      keyboardShouldPersistTaps="handled"
      onScroll={(event) => { scrollYRef.current = event.nativeEvent.contentOffset.y; }}
      onViewableItemsChanged={onViewableFeedItemsChanged}
      viewabilityConfig={feedViewabilityConfig}
      onScrollToIndexFailed={(info) => {
        listRef.current?.scrollToOffset({
          offset: Math.max(0, info.averageItemLength * info.index),
          animated: true,
        });
      }}
      scrollEventThrottle={16}
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
          <Ionicons name={emptyConfig.icon} size={28} color={colors.textMuted} />
          <Text style={styles.emptyTitle}>{emptyConfig.title}</Text>
          <Text style={styles.emptyBody}>
            {emptyConfig.body}
          </Text>
          {emptyConfig.onPress ? (
            <TouchableOpacity style={styles.emptyActionBtn} onPress={emptyConfig.onPress} activeOpacity={0.8}>
              <Text style={styles.emptyActionText}>{emptyConfig.action}</Text>
            </TouchableOpacity>
          ) : null}
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

function createStyles(c: ReturnType<typeof getTheme>['colors'], isLightTheme: boolean) {
  const activityCardBackground = isLightTheme ? c.surface : c.surfaceRaised;
  const activityInnerBackground = isLightTheme ? c.surfaceRaised : c.surface;

  return StyleSheet.create({
    listContent: { paddingVertical: 6, paddingHorizontal: 10, gap: 8 },
    center: { paddingVertical: 40, alignItems: 'center', justifyContent: 'center' },
    empty: { paddingVertical: 60, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 28 },
    emptyTitle: { fontSize: 16, fontWeight: '700', color: c.textPrimary, marginTop: 8 },
    emptyBody: { fontSize: 13, color: c.textSecondary, textAlign: 'center', lineHeight: 18 },
    emptyActionBtn: {
      marginTop: 6,
      paddingHorizontal: 14,
      paddingVertical: 9,
      borderRadius: radius.full,
      backgroundColor: c.primary,
    },
    emptyActionText: { fontSize: 12, fontWeight: '900', color: getContrastingTextColor(c.primary) },
    digestCard: {
      backgroundColor: activityCardBackground,
      borderRadius: radius.sm,
      padding: 12,
      gap: 11,
      borderWidth: 1,
      borderColor: c.border,
      overflow: 'hidden',
    },
    cardWash: {
      position: 'absolute',
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
    },
    digestHeaderRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 10,
    },
    digestLabel: { fontSize: 10, fontWeight: '900', color: c.textMuted, letterSpacing: 0.5 },
    digestTitle: { fontSize: 16, fontWeight: '900', color: c.textPrimary, marginTop: 2 },
    digestInviteBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      paddingHorizontal: 10,
      paddingVertical: 7,
      borderRadius: radius.full,
      backgroundColor: c.primary + '12',
      borderWidth: 1,
      borderColor: c.primary + '25',
    },
    digestInviteText: { fontSize: 11, fontWeight: '900', color: c.primary },
    digestStatGrid: { flexDirection: 'row', gap: 8 },
    digestStat: {
      flex: 1,
      minHeight: 58,
      borderRadius: radius.md,
      backgroundColor: activityInnerBackground,
      borderWidth: 1,
      borderColor: c.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    digestStatValue: { fontSize: 19, fontWeight: '900', color: c.textPrimary, fontVariant: ['tabular-nums'] as any },
    digestStatLabel: { fontSize: 10, fontWeight: '800', color: c.textMuted, marginTop: 2 },
    digestFooterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
    digestFooterItem: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      maxWidth: '100%',
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: radius.full,
      backgroundColor: activityInnerBackground,
      borderWidth: 1,
      borderColor: c.border,
    },
    digestFooterText: { minWidth: 0, fontSize: 11, fontWeight: '800', color: c.textSecondary },
    digestSharePrompt: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: (c.warning ?? '#F59E0B') + '55',
      backgroundColor: (c.warning ?? '#F59E0B') + '10',
      paddingHorizontal: 10,
      paddingVertical: 9,
    },
    digestSharePromptText: { flex: 1, fontSize: 12, fontWeight: '800', color: c.textPrimary },
    digestSharePromptAction: { fontSize: 12, fontWeight: '900', color: c.warning ?? '#F59E0B' },
    privacyWrap: {
      alignItems: 'flex-end',
      gap: 6,
      marginBottom: 2,
    },
    privacyIconButton: {
      width: 30,
      height: 30,
      borderRadius: 15,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: c.primary + '12',
      borderColor: c.primary + '30',
      borderWidth: 1,
    },
    privacyBubble: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 8,
      backgroundColor: activityInnerBackground,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: radius.md,
      padding: 12,
    },
    privacyText: { flex: 1, fontSize: 11, color: c.textSecondary, lineHeight: 16, fontWeight: '600' },
    card: {
      backgroundColor: activityCardBackground,
      borderRadius: radius.sm,
      padding: 11,
      gap: 8,
      borderWidth: 1,
      borderColor: c.border,
      overflow: 'hidden',
    },
    cardHeader: { flexDirection: 'row', alignItems: 'center' },
    authorRow: { flexDirection: 'row', alignItems: 'center', gap: 9, flex: 1 },
    authorName: { fontSize: 13, fontWeight: '700', color: c.textPrimary },
    authorMeta: { fontSize: 10, color: c.textMuted, marginTop: 1 },
    caption: { fontSize: 13, color: c.textPrimary, lineHeight: 18 },
    photo: {
      width: '100%', aspectRatio: 4 / 3, borderRadius: radius.md,
      backgroundColor: activityInnerBackground,
    },
    summaryBlock: {
      backgroundColor: activityInnerBackground,
      borderRadius: radius.sm,
      padding: 10,
      gap: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
    },
    summaryHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    summaryIconBadge: {
      width: 26,
      height: 26,
      borderRadius: 8,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: c.primary + '14',
      borderColor: c.primary + '28',
      borderWidth: 1,
    },
    summaryFocus: { fontSize: 13, fontWeight: '800', color: c.textPrimary, textTransform: 'capitalize' },
    summarySubtitle: { fontSize: 10, color: c.textMuted, marginTop: 1, fontWeight: '600' },
    ratingBadge: {
      paddingHorizontal: 7,
      paddingVertical: 3,
      borderRadius: radius.full,
      backgroundColor: c.primary + '16',
      borderColor: c.primary + '26',
      borderWidth: 1,
    },
    ratingBadgeText: { fontSize: 10, fontWeight: '800', color: c.primary },
    summaryMetricRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, rowGap: 5 },
    summaryMetricItem: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 3,
      minHeight: 18,
      maxWidth: '100%',
    },
    summaryMetricText: { fontSize: 11, color: c.textSecondary, fontWeight: '800', fontVariant: ['tabular-nums'] as any },
    detailsToggle: {
      marginTop: 2,
      paddingTop: 7,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
    },
    detailsToggleActive: { borderTopColor: c.primary + '35' },
    detailsToggleCopy: { flex: 1 },
    detailsToggleText: { fontSize: 11, fontWeight: '800', color: c.textPrimary },
    detailsToggleMeta: { fontSize: 10, fontWeight: '700', color: c.textMuted, marginTop: 1 },
    exerciseList: {
      paddingTop: 2,
    },
    exerciseDetailRow: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      paddingVertical: 8,
    },
    exerciseDetailRowFirst: { borderTopWidth: 0 },
    exerciseLine: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
    exerciseDot: {
      width: 5,
      height: 5,
      borderRadius: 3,
      backgroundColor: c.primary,
      marginTop: 7,
    },
    exerciseCopy: { flex: 1, minWidth: 0, gap: 2 },
    exerciseTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
    exerciseName: { flex: 1, minWidth: 0, fontSize: 12, fontWeight: '800', color: c.textPrimary, lineHeight: 17 },
    exerciseMeta: { maxWidth: '44%', fontSize: 10, fontWeight: '700', color: c.textMuted },
    exerciseSetLine: { fontSize: 11, color: c.textSecondary, lineHeight: 15, fontWeight: '600' },
    prRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    prBadge: {
      flexDirection: 'row', alignItems: 'center', gap: 4,
      paddingHorizontal: 8, paddingVertical: 3,
      backgroundColor: activityInnerBackground,
      borderRadius: 10, borderWidth: 1, borderColor: c.border,
    },
    prText: { fontSize: 11, fontWeight: '600', color: c.textSecondary, maxWidth: 160 },
    actionRow: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingTop: 4 },
    likeBtn: { flexDirection: 'row', alignItems: 'center', gap: 5 },
    likeCount: { fontSize: 12, color: c.textSecondary, fontWeight: '600', minWidth: 12 },
    commentBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      flexShrink: 1,
      minHeight: 28,
      maxWidth: '78%',
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: radius.full,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: activityInnerBackground,
    },
    commentBtnActive: {
      borderColor: c.primary + '32',
      backgroundColor: c.primary + '10',
    },
    commentCount: { minWidth: 0, fontSize: 12, color: c.textSecondary, fontWeight: '700', flexShrink: 1 },
    quickReactionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    quickReactionChip: {
      paddingHorizontal: 9,
      paddingVertical: 5,
      borderRadius: radius.full,
      backgroundColor: c.primary + '0F',
      borderWidth: 1,
      borderColor: c.primary + '22',
    },
    quickReactionText: { fontSize: 11, fontWeight: '800', color: c.primary },
    commentsBlock: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
      paddingTop: 10,
      gap: 9,
    },
    commentRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
    commentBubble: {
      flex: 1,
      minWidth: 0,
      borderRadius: radius.md,
      backgroundColor: activityInnerBackground,
      borderWidth: 1,
      borderColor: c.border,
      paddingHorizontal: 10,
      paddingVertical: 8,
    },
    commentHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    commentAuthor: { flex: 1, minWidth: 0, fontSize: 11, fontWeight: '800', color: c.textPrimary },
    commentDeleteBtn: { width: 22, height: 22, alignItems: 'center', justifyContent: 'center' },
    commentBody: { fontSize: 13, color: c.textSecondary, lineHeight: 18, marginTop: 2 },
    commentsLoading: { paddingVertical: 4, alignItems: 'center' },
    commentInputRow: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: 8,
      paddingTop: 2,
    },
    commentInput: {
      flex: 1,
      minHeight: 38,
      maxHeight: 96,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: activityInnerBackground,
      paddingHorizontal: 11,
      paddingVertical: 9,
      fontSize: 13,
      color: c.textPrimary,
      lineHeight: 18,
    },
    commentSendBtn: {
      width: 38,
      height: 38,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: c.primary + '12',
      borderWidth: 1,
      borderColor: c.primary + '28',
    },
    commentSendBtnDisabled: {
      backgroundColor: activityInnerBackground,
      borderColor: c.border,
    },
  });
}
