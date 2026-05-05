import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  Modal,
  ScrollView,
  TouchableOpacity,
  TextInput,
  StyleSheet,
  ActivityIndicator,
  Alert,
  LayoutAnimation,
  Share,
} from 'react-native';
import FadeInView from './FadeInView';
import { Ionicons } from '@expo/vector-icons';
import { getContrastingTextColor, getTheme, radius, spacing } from '../constants/theme';
import type { AppThemeName } from '../types';
import { dynamicTextProps } from '../utils/dynamicType';
import SocialAvatar from './SocialAvatar';
import {
  acceptFriend,
  blockFriend,
  getSocialDigest,
  getSocialMe,
  listSocialNotifications,
  listFriends,
  markAllSocialNotificationsRead,
  markSocialNotificationRead,
  rejectFriend,
  removeFriend,
  reportUser,
  requestFriend,
  searchUsers,
  updateSocialMe,
  type SocialDigest,
  type SocialFriend,
  type SocialFriendsList,
  type SocialMe,
  type SocialNotification,
  type SocialSearchHit,
} from '../services/api';
import SocialFeedView from './SocialFeedView';

const SOCIAL_ACTIVITY_FEED_ENABLED = true;

interface Props {
  visible: boolean;
  authToken: string;
  onClose: () => void;
  themeName?: AppThemeName;
  /** When true, renders inline (no Modal/backdrop/close button).
   *  Used by the Friends tab so the content fills the tab area. */
  inline?: boolean;
  onViewFriend?: (userId: number, displayName: string, digestFriend?: import('../services/api').SocialDigestFriend) => void;
  onSocialCountsChange?: (counts: { friends: number; pending: number; unread: number }) => void;
}

const goalLabel = (g: string | null | undefined): string => {
  if (!g) return '';
  return g
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
};

function e2eId(value: string | number | null | undefined): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

type IoniconName = keyof typeof Ionicons.glyphMap;

function formatNotificationTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (diffSec < 60) return 'now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
  if (diffSec < 86400 * 7) return `${Math.floor(diffSec / 86400)}d`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function notificationActorName(n: SocialNotification): string {
  return n.actor_display_name || n.actor_username || 'Someone';
}

function notificationIconName(n: SocialNotification): IoniconName {
  if (n.notification_type === 'friend_request') return 'person-add-outline';
  if (n.notification_type === 'friend_accept') return 'people-outline';
  if (n.notification_type === 'feed_like') return 'heart-outline';
  return 'notifications-outline';
}

function notificationTitle(n: SocialNotification): string {
  const name = notificationActorName(n);
  if (n.notification_type === 'friend_request') return `${name} sent you a friend request`;
  if (n.notification_type === 'friend_accept') return `${name} accepted your request`;
  if (n.notification_type === 'feed_like') return `${name} liked your workout`;
  return 'New social update';
}

function notificationBody(n: SocialNotification): string {
  if (n.notification_type === 'friend_request') return 'Tap to review the request.';
  if (n.notification_type === 'friend_accept') return "You're now connected on Social.";
  if (n.notification_type === 'feed_like') {
    const focus = n.payload?.focus;
    return focus ? `${focus} got some love.` : 'Tap to jump back to Activity.';
  }
  return 'Tap to view Social.';
}

export default function FriendsModal({
  visible,
  authToken,
  onClose,
  themeName,
  inline,
  onViewFriend,
  onSocialCountsChange,
}: Props) {
  const theme = getTheme(themeName);
  const colors = theme.colors;
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [me, setMe] = useState<SocialMe | null>(null);
  const [list, setList] = useState<SocialFriendsList | null>(null);
  const [digest, setDigest] = useState<SocialDigest | null>(null);
  const [notifications, setNotifications] = useState<SocialNotification[]>([]);
  const [unreadNotifications, setUnreadNotifications] = useState(0);
  const [notificationTrayOpen, setNotificationTrayOpen] = useState(false);
  const [notificationActionPending, setNotificationActionPending] = useState<number | 'all' | null>(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const [hits, setHits] = useState<SocialSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [requestPending, setRequestPending] = useState<string | null>(null);
  const [showOptIn, setShowOptIn] = useState(false);
  // Feed is the default tab so users land on activity immediately.
  // Friends tab lazy-renders on first switch (no extra cost on open).
  const [activeTab, setActiveTab] = useState<'friends' | 'activity'>(
    SOCIAL_ACTIVITY_FEED_ENABLED ? 'activity' : 'friends',
  );
  // Bumped to force the activity view to re-fetch (e.g., after share).
  const [feedRefreshKey, setFeedRefreshKey] = useState(0);
  void setFeedRefreshKey;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [m, l, d, n] = await Promise.allSettled([
        getSocialMe(authToken),
        listFriends(authToken),
        getSocialDigest(authToken),
        listSocialNotifications(authToken),
      ]);
      if (m.status === 'fulfilled') setMe(m.value);
      if (l.status === 'fulfilled') {
        setList(l.value);
      }
      if (d.status === 'fulfilled') setDigest(d.value);
      if (n.status === 'fulfilled') {
        setNotifications(n.value.items);
        setUnreadNotifications(n.value.unread_count);
      }
      if (l.status === 'fulfilled' && n.status === 'fulfilled') {
        onSocialCountsChange?.({
          friends: l.value.friends.length,
          pending: l.value.pending.filter(p => p.direction === 'incoming').length,
          unread: n.value.unread_count,
        });
      }
    } catch {
      // silent — user sees empty state
    } finally {
      setLoading(false);
    }
  }, [authToken, onSocialCountsChange]);

  useEffect(() => {
    if (!visible && !inline) return;
    refresh();
  }, [visible, inline, refresh]);

  // Search debounce
  useEffect(() => {
    const q = search.trim();
    if (q.length < 2) {
      setHits([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const r = await searchUsers(authToken, q);
        if (!cancelled) setHits(r);
      } catch {
        if (!cancelled) setHits([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [search, authToken]);

  const onRequest = useCallback(
    async (username: string) => {
      setRequestPending(username);
      try {
        await requestFriend(authToken, username);
        setSearch('');
        setHits([]);
        await refresh();
        // First-friend opt-in nudge
        if (me && !me.share_activity_enabled) setShowOptIn(true);
      } catch (e: any) {
        Alert.alert('Could not send request', e?.message ?? 'Try again');
      } finally {
        setRequestPending(null);
      }
    },
    [authToken, me, refresh],
  );

  const onAccept = useCallback(
    async (id: number) => {
      // Find the requester before the refresh so we can name them in
      // the success toast — the row disappears from `incoming` after
      // the refresh and we'd lose the display name.
      const requester = (list?.pending ?? []).find((p) => p.friendship_id === id);
      try {
        await acceptFriend(authToken, id);
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        await refresh();
        // Positive feedback: silent acceptance felt broken in user
        // testing. Haptic + a short "now friends" toast confirms the
        // accept landed before we surface the share-on opt-in.
        try {
          const f = await import('../utils/feedback');
          f.hapticSuccess?.();
        } catch { /* feedback module is best-effort */ }
        if (me && !me.share_activity_enabled) {
          setShowOptIn(true);
        } else if (requester) {
          const name = requester.display_name ?? requester.username;
          Alert.alert("You're now friends", `${name} can now see your training activity (if sharing is on).`);
        }
      } catch (e: any) {
        Alert.alert('Could not accept', e?.message ?? 'Try again');
      }
    },
    [authToken, me, list, refresh],
  );

  const onReject = useCallback(
    async (id: number) => {
      try {
        await rejectFriend(authToken, id);
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        await refresh();
      } catch (e: any) {
        Alert.alert('Could not reject', e?.message ?? 'Try again');
      }
    },
    [authToken, refresh],
  );

  const onRemove = useCallback(
    (friend: SocialFriend) => {
      Alert.alert(
        `Remove ${friend.display_name ?? friend.username}?`,
        'You can re-add them later by username.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Remove',
            style: 'destructive',
            onPress: async () => {
              try {
                await removeFriend(authToken, friend.friendship_id);
                await refresh();
              } catch (e: any) {
                Alert.alert('Could not remove', e?.message ?? 'Try again');
              }
            },
          },
        ],
      );
    },
    [authToken, refresh],
  );

  const onBlock = useCallback(
    (friend: SocialFriend) => {
      Alert.alert(
        `Block ${friend.display_name ?? friend.username}?`,
        "They won't be able to send you friend requests or see your activity. You also won't see theirs. You can unblock from settings.",
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Block',
            style: 'destructive',
            onPress: async () => {
              try {
                await blockFriend(authToken, friend.friendship_id);
                await refresh();
              } catch (e: any) {
                Alert.alert('Could not block', e?.message ?? 'Try again');
              }
            },
          },
        ],
      );
    },
    [authToken, refresh],
  );

  const onReport = useCallback(
    (friend: SocialFriend) => {
      // App Review requires a Report affordance on every social surface.
      // Reasons map to the backend `_VALID_REPORT_REASONS` set.
      Alert.alert(
        `Report ${friend.display_name ?? friend.username}`,
        'Pick the reason. A safety reviewer will look at this.',
        [
          { text: 'Spam',                      onPress: () => submitReport(friend, 'spam') },
          { text: 'Harassment',                onPress: () => submitReport(friend, 'harassment') },
          { text: 'Impersonation',             onPress: () => submitReport(friend, 'impersonation') },
          { text: 'Inappropriate content',     onPress: () => submitReport(friend, 'inappropriate_content') },
          { text: 'Other',                     onPress: () => submitReport(friend, 'other') },
          { text: 'Cancel', style: 'cancel' },
        ],
      );
    },
    [authToken],
  );

  const submitReport = useCallback(
    async (
      friend: SocialFriend,
      reason: 'spam' | 'harassment' | 'impersonation' | 'inappropriate_content' | 'other',
    ) => {
      try {
        await reportUser(authToken, friend.user_id, reason);
        Alert.alert('Report submitted', 'Thank you. A reviewer will follow up if action is needed.');
      } catch (e: any) {
        Alert.alert('Could not submit report', e?.message ?? 'Try again');
      }
    },
    [authToken],
  );

  const onFriendOptions = useCallback(
    (friend: SocialFriend) => {
      Alert.alert(
        friend.display_name ?? friend.username,
        undefined,
        [
          { text: 'Remove friend', style: 'destructive', onPress: () => onRemove(friend) },
          { text: 'Block',         style: 'destructive', onPress: () => onBlock(friend) },
          { text: 'Report',        onPress: () => onReport(friend) },
          { text: 'Cancel',        style: 'cancel' },
        ],
      );
    },
    [onRemove, onBlock, onReport],
  );

  const onTurnOnSharing = useCallback(async () => {
    try {
      const updated = await updateSocialMe(authToken, { share_activity_enabled: true });
      setMe(updated);
      setShowOptIn(false);
      // Refresh digest so the user sees their own sessions reflected.
      const d = await getSocialDigest(authToken);
      setDigest(d);
    } catch (e: any) {
      Alert.alert('Could not update', e?.message ?? 'Try again');
    }
  }, [authToken]);

  const onShareInvite = useCallback(async () => {
    if (!me?.username) {
      Alert.alert('Username unavailable', 'Open Friends again after your profile finishes loading.');
      return;
    }
    try {
      await Share.share({
        message: `Add me on Thallo: @${me.username}`,
      });
    } catch (e: any) {
      Alert.alert('Could not share invite', e?.message ?? 'Try again');
    }
  }, [me?.username]);

  const incoming = list?.pending.filter((p) => p.direction === 'incoming') ?? [];
  const outgoing = list?.pending.filter((p) => p.direction === 'outgoing') ?? [];
  const friends = list?.friends ?? [];

  const updateLocalUnread = useCallback(
    (nextUnread: number, nextNotifications?: SocialNotification[]) => {
      setUnreadNotifications(nextUnread);
      if (nextNotifications) setNotifications(nextNotifications);
      onSocialCountsChange?.({
        friends: friends.length,
        pending: incoming.length,
        unread: nextUnread,
      });
    },
    [friends.length, incoming.length, onSocialCountsChange],
  );

  const onNotificationPress = useCallback(
    async (n: SocialNotification) => {
      setNotificationActionPending(n.id);
      try {
        if (!n.read_at) {
          await markSocialNotificationRead(authToken, n.id);
          const updated = notifications.map(item =>
            item.id === n.id ? { ...item, read_at: new Date().toISOString() } : item,
          );
          updateLocalUnread(Math.max(0, unreadNotifications - 1), updated);
        }
      } catch {
        // Keep navigation responsive; the next refresh will reconcile.
      } finally {
        setNotificationActionPending(null);
      }
      if (n.notification_type === 'friend_request') {
        setActiveTab('friends');
        setNotificationTrayOpen(false);
        return;
      }
      setActiveTab('activity');
      setNotificationTrayOpen(false);
    },
    [authToken, notifications, unreadNotifications, updateLocalUnread],
  );

  const onMarkAllNotificationsRead = useCallback(async () => {
    setNotificationActionPending('all');
    try {
      await markAllSocialNotificationsRead(authToken);
      const now = new Date().toISOString();
      updateLocalUnread(0, notifications.map(n => n.read_at ? n : { ...n, read_at: now }));
    } catch (e: any) {
      Alert.alert('Could not update notifications', e?.message ?? 'Try again');
    } finally {
      setNotificationActionPending(null);
    }
  }, [authToken, notifications, updateLocalUnread]);

  const summary = digest?.summary;
  const headlineLines: string[] = [];
  if (summary && summary.friend_count > 0) {
    if (summary.friends_trained_this_week > 0) {
      headlineLines.push(
        `${summary.friends_trained_this_week} of your ${summary.friend_count} friend${
          summary.friend_count === 1 ? '' : 's'
        } trained this week.`,
      );
    } else {
      headlineLines.push("None of your friends have logged a workout this week yet.");
    }
    if (summary.top_user_id && digest) {
      const top = digest.friends.find((f) => f.user_id === summary.top_user_id);
      if (top && summary.top_sessions > 0) {
        headlineLines.push(
          `${top.display_name} hit ${summary.top_sessions} session${
            summary.top_sessions === 1 ? '' : 's'
          } — most in your circle.`,
        );
      }
    }
    if (summary.long_streak_count > 0) {
      headlineLines.push(
        `${summary.long_streak_count} friend${summary.long_streak_count === 1 ? ' is' : 's are'} on a 14+ day streak.`,
      );
    }
  }

  const content = (
    <>
      {!inline && (
        <View style={styles.header}>
          <Text style={styles.title}>Friends</Text>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Ionicons name="close" size={22} color={colors.textSecondary} />
          </TouchableOpacity>
        </View>
      )}

      <View style={styles.socialToolbar}>
        <View style={{ flex: 1 }}>
          <Text style={styles.toolbarLabel}>SOCIAL</Text>
          <Text style={styles.toolbarMeta}>
            {unreadNotifications > 0
              ? `${unreadNotifications} new update${unreadNotifications === 1 ? '' : 's'}`
              : incoming.length > 0
                ? `${incoming.length} request${incoming.length === 1 ? '' : 's'} waiting`
                : 'Activity, friends, and requests'}
          </Text>
        </View>
        <TouchableOpacity
          testID="social-notifications-toggle"
          accessibilityLabel="Social notifications"
          accessibilityRole="button"
          accessibilityState={{ expanded: notificationTrayOpen }}
          onPress={() => setNotificationTrayOpen(v => !v)}
          style={[styles.notificationButton, notificationTrayOpen && styles.notificationButtonActive]}
          activeOpacity={0.75}
        >
          <Ionicons
            name={unreadNotifications > 0 ? 'notifications' : 'notifications-outline'}
            size={18}
            color={notificationTrayOpen ? colors.primary : colors.textSecondary}
          />
          {unreadNotifications > 0 ? (
            <View style={styles.notificationBadge}>
              <Text style={styles.notificationBadgeText}>
                {unreadNotifications > 9 ? '9+' : unreadNotifications}
              </Text>
            </View>
          ) : null}
        </TouchableOpacity>
      </View>

      {notificationTrayOpen ? (
        <View testID="social-notifications-panel" style={styles.notificationPanel}>
          <View style={styles.notificationPanelHeader}>
            <Text style={styles.notificationPanelTitle}>Notifications</Text>
            {unreadNotifications > 0 ? (
              <TouchableOpacity
                onPress={onMarkAllNotificationsRead}
                disabled={notificationActionPending === 'all'}
                style={styles.markReadButton}
                activeOpacity={0.75}
              >
                <Text style={styles.markReadText}>
                  {notificationActionPending === 'all' ? 'Updating...' : 'Mark read'}
                </Text>
              </TouchableOpacity>
            ) : null}
          </View>
          {notifications.length === 0 ? (
            <View style={styles.notificationEmpty}>
              <Ionicons name="checkmark-circle-outline" size={18} color={colors.textMuted} />
              <Text style={styles.notificationEmptyText}>No social notifications yet.</Text>
            </View>
          ) : (
            notifications.slice(0, 8).map((n) => {
              const unread = !n.read_at;
              return (
                <TouchableOpacity
                  key={n.id}
                  style={[styles.notificationRow, unread && styles.notificationRowUnread]}
                  onPress={() => onNotificationPress(n)}
                  disabled={notificationActionPending === n.id}
                  activeOpacity={0.78}
                >
                  <View style={styles.notificationIconBubble}>
                    <Ionicons name={notificationIconName(n)} size={16} color={colors.primary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <View style={styles.notificationTitleRow}>
                      <Text style={styles.notificationTitle} numberOfLines={2}>
                        {notificationTitle(n)}
                      </Text>
                      <Text style={styles.notificationTime}>{formatNotificationTime(n.created_at)}</Text>
                    </View>
                    <Text style={styles.notificationBody} numberOfLines={2}>
                      {notificationBody(n)}
                    </Text>
                  </View>
                  {unread ? <View style={styles.unreadDot} /> : null}
                </TouchableOpacity>
              );
            })
          )}
        </View>
      ) : null}

      {/* Friends / Activity tab strip. "Activity" is a bounded digest
          (latest 10 shares from friends), not an open scrolling feed —
          the friend detail surface is where users go to dig into a
          specific person's training. */}
      <View style={styles.tabStrip}>
        {SOCIAL_ACTIVITY_FEED_ENABLED ? (
          <TouchableOpacity
            testID="social-tab-activity"
            accessibilityLabel="Activity"
            style={[styles.tab, activeTab === 'activity' && styles.tabActive]}
            onPress={() => setActiveTab('activity')}
          >
            <Text style={[styles.tabText, activeTab === 'activity' && styles.tabTextActive]}>
              Activity
            </Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity
          testID="social-tab-friends"
          accessibilityLabel="Friends"
          style={[styles.tab, activeTab === 'friends' && styles.tabActive]}
          onPress={() => setActiveTab('friends')}
        >
          <Text style={[styles.tabText, activeTab === 'friends' && styles.tabTextActive]}>
            Friends{friends.length > 0 ? `  ·  ${friends.length}` : ''}
          </Text>
        </TouchableOpacity>
      </View>

      <FadeInView key={activeTab} duration={240} slideDistance={8} style={{ flex: 1 }}>
      {SOCIAL_ACTIVITY_FEED_ENABLED && activeTab === 'activity' ? (
        <SocialFeedView
          authToken={authToken}
          themeName={themeName}
          bottomPadding={inline ? 116 : 8}
          refreshKey={feedRefreshKey}
          shareEnabled={me?.share_activity_enabled ?? false}
          myActivity={digest?.you ?? null}
          myDisplayName={me?.display_name ?? me?.username ?? ''}
          myAvatarUrl={me?.avatar_url ?? null}
          onViewAuthor={(uid, displayName) => {
            // Reuse the existing friend-detail surface — find the
            // matching digest entry so the parent can render their
            // streak/sessions. If they're not in the digest (e.g.,
            // not a friend yet) we still call onViewFriend so the
            // parent can decide what to do.
            const df = digest?.friends.find((d) => d.user_id === uid);
            const digestFriend = df ?? {
              user_id: uid, username: '', display_name: displayName,
              avatar_url: null,
              goal: null, share_enabled: true,
              sessions: 0, streak: 0, last_active_within_48h: false,
            };
            onViewFriend?.(uid, displayName, digestFriend);
          }}
        />
      ) : loading && !list ? (
            <View style={{ padding: 24, alignItems: 'center' }}>
              <ActivityIndicator color={colors.primary} />
            </View>
          ) : (
            <ScrollView
              testID="social-friends-list"
              style={{ flex: 1 }}
              contentContainerStyle={{ paddingTop: 8, paddingBottom: inline ? 128 : 24 }}>
              {/* This week card */}
              <View style={styles.card}>
                <Text style={styles.cardLabel}>THIS WEEK</Text>
                {headlineLines.length === 0 ? (
                  <Text style={styles.cardBody}>
                    Add a friend to see how their week stacks up against yours.
                  </Text>
                ) : (
                  headlineLines.map((line, i) => (
                    <Text key={i} style={styles.cardBody}>
                      {line}
                    </Text>
                  ))
                )}
                <View style={styles.youRow}>
                  <Text style={styles.youLabel}>YOU</Text>
                  <Text style={styles.youValue}>
                    {digest?.you.sessions ?? 0} session{(digest?.you.sessions ?? 0) === 1 ? '' : 's'}
                    {digest && digest.you.streak >= 2 ? ` · ${digest.you.streak}-day streak` : ''}
                  </Text>
                </View>
                <View style={styles.privacyRow}>
                  <Ionicons name="lock-closed-outline" size={13} color={colors.primary} />
                  <Text style={styles.privacyText}>
                    Private by design: friends never see calories, macros, meals, body weight, body photos, or measurements.
                  </Text>
                </View>
              </View>

              {/* Sharing toggle reminder if disabled */}
              {me && !me.share_activity_enabled && friends.length > 0 ? (
                <TouchableOpacity
                  style={[styles.card, { borderColor: colors.warning, borderWidth: 1 }]}
                  onPress={() => setShowOptIn(true)}
                  activeOpacity={0.85}
                >
                  <Text style={[styles.cardLabel, { color: colors.warning }]}>SHARING IS OFF</Text>
                  <Text style={styles.cardBody}>
                    Friends can&apos;t see your training activity until you turn this on. Tap to enable.
                  </Text>
                </TouchableOpacity>
              ) : null}

              {/* Incoming requests */}
              {incoming.length > 0 ? (
                <View style={styles.section}>
                  <Text style={styles.sectionLabel}>REQUESTS</Text>
                  {incoming.map((p, i) => (
                    <FadeInView key={p.friendship_id} delay={i * 50} duration={250} slideDistance={6}>
                    <View style={styles.friendRow}>
                      <SocialAvatar
                        avatarUrl={p.avatar_url}
                        name={p.display_name}
                        username={p.username}
                        size={36}
                        backgroundColor={colors.primary + '22'}
                        borderColor={colors.primary + '55'}
                        textColor={colors.primary}
                      />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.friendName}>{p.display_name ?? p.username}</Text>
                        <Text style={styles.friendMeta}>@{p.username}</Text>
                      </View>
                      <TouchableOpacity activeOpacity={0.75} style={styles.btnSecondary} onPress={() => onReject(p.friendship_id)}>
                        <Text style={styles.btnSecondaryText}>Decline</Text>
                      </TouchableOpacity>
                      <TouchableOpacity activeOpacity={0.75} style={styles.btnPrimary} onPress={() => onAccept(p.friendship_id)}>
                        <Text style={styles.btnPrimaryText}>Accept</Text>
                      </TouchableOpacity>
                    </View>
                    </FadeInView>
                  ))}
                </View>
              ) : null}

              {/* Friends list */}
              <View style={styles.section}>
                <Text style={styles.sectionLabel}>FRIENDS{friends.length > 0 ? `  ·  ${friends.length}` : ''}</Text>
                {friends.length === 0 ? (
                  <View style={styles.emptyCard}>
                    <View style={styles.emptyIconBubble}>
                      <Ionicons name="people-outline" size={24} color={colors.primary} />
                    </View>
                    <Text {...dynamicTextProps} style={styles.emptyTitle}>No friends yet</Text>
                    <Text {...dynamicTextProps} style={styles.emptyBody}>
                      Add a friend by username to see shared workout activity, streaks, and weekly training summaries here.
                    </Text>
                  </View>
                ) : (
                  friends.map((f) => (
                    <TouchableOpacity
                      key={f.user_id}
                      testID={`social-friend-row-${e2eId(f.username)}`}
                      accessibilityLabel={`social-friend-row-${e2eId(f.username)}`}
                      style={styles.friendRow}
                      activeOpacity={0.7}
                      onPress={() => {
                        if (onViewFriend) {
                          const df = digest?.friends.find((d) => d.user_id === f.user_id);
                          const digestFriend = df ?? {
                            user_id: f.user_id, username: f.username,
                            display_name: f.display_name ?? f.username,
                            avatar_url: f.avatar_url ?? null,
                            goal: f.goal, share_enabled: true,
                            sessions: 0, streak: f.streak,
                            last_active_within_48h: f.last_active_within_48h,
                          };
                          onViewFriend(f.user_id, f.display_name ?? f.username, digestFriend);
                        }
                      }}
                      onLongPress={() => onFriendOptions(f)}
                    >
                      <SocialAvatar
                        avatarUrl={f.avatar_url}
                        name={f.display_name}
                        username={f.username}
                        size={36}
                        backgroundColor={colors.primary + '22'}
                        borderColor={colors.primary + '55'}
                        textColor={colors.primary}>
                        <View
                          style={[
                            styles.activeDot,
                            { backgroundColor: f.last_active_within_48h ? colors.success : colors.border },
                          ]}
                        />
                      </SocialAvatar>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.friendName}>{f.display_name ?? f.username}</Text>
                        <Text style={styles.friendMeta}>
                          {goalLabel(f.goal) || '—'}
                          {f.streak >= 2 ? `  ·  ${f.streak}-day streak` : ''}
                        </Text>
                      </View>
                      <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
                    </TouchableOpacity>
                  ))
                )}
              </View>

              {/* Outgoing pending */}
              {outgoing.length > 0 ? (
                <View style={styles.section}>
                  <Text style={styles.sectionLabel}>SENT</Text>
                  {outgoing.map((p) => (
                    <View key={p.friendship_id} style={styles.friendRow}>
                      <SocialAvatar
                        avatarUrl={p.avatar_url}
                        name={p.display_name}
                        username={p.username}
                        size={36}
                        backgroundColor={colors.primary + '22'}
                        borderColor={colors.primary + '55'}
                        textColor={colors.primary}
                      />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.friendName}>{p.display_name ?? p.username}</Text>
                        <Text style={styles.friendMeta}>Pending…</Text>
                      </View>
                      <TouchableOpacity style={styles.btnSecondary} onPress={() => onReject(p.friendship_id)}>
                        <Text style={styles.btnSecondaryText}>Cancel</Text>
                      </TouchableOpacity>
                    </View>
                  ))}
                </View>
              ) : null}

              {/* Add friends */}
              <View style={styles.section}>
                <Text style={styles.sectionLabel}>ADD FRIENDS</Text>
                {me?.username ? (
                  <View style={styles.inviteCard}>
                    <View style={styles.inviteIcon}>
                      <Ionicons name="person-add-outline" size={18} color={colors.primary} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.inviteTitle}>Invite by username</Text>
                      <Text style={styles.inviteHandle}>@{me.username}</Text>
                      <Text style={styles.inviteBody}>
                        Friends can search this handle, or you can share it directly.
                      </Text>
                    </View>
                    <TouchableOpacity style={styles.inviteButton} onPress={onShareInvite} activeOpacity={0.78}>
                      <Ionicons name="share-outline" size={15} color={getContrastingTextColor(colors.primary)} />
                      <Text style={styles.btnPrimaryText}>Share</Text>
                    </TouchableOpacity>
                  </View>
                ) : null}
                <View style={[styles.searchRow, searchFocused && { borderColor: colors.primary, borderWidth: 1.5 }]}>
                  <Ionicons name="search" size={16} color={searchFocused ? colors.primary : colors.textMuted} />
                  <TextInput
                    style={styles.searchInput}
                    placeholder="Search by username"
                    placeholderTextColor={colors.textMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    value={search}
                    onChangeText={setSearch}
                    onFocus={() => setSearchFocused(true)}
                    onBlur={() => setSearchFocused(false)}
                  />
                  {searching ? <ActivityIndicator size="small" color={colors.textMuted} /> : null}
                </View>
                {search.trim().length >= 2 && hits.length === 0 && !searching ? (
                  <Text style={styles.empty}>No users found.</Text>
                ) : null}
                {hits.map((h) => {
                  const alreadyFriend = friends.some((f) => f.user_id === h.user_id);
                  const alreadyPending = (list?.pending ?? []).some((p) => p.user_id === h.user_id);
                  return (
                    <View key={h.user_id} style={styles.friendRow}>
                      <SocialAvatar
                        avatarUrl={h.avatar_url}
                        name={h.display_name}
                        username={h.username}
                        size={36}
                        backgroundColor={colors.primary + '22'}
                        borderColor={colors.primary + '55'}
                        textColor={colors.primary}
                      />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.friendName}>{h.display_name ?? h.username}</Text>
                        <Text style={styles.friendMeta}>@{h.username}</Text>
                      </View>
                      {alreadyFriend ? (
                        <Text style={styles.tag}>Friends</Text>
                      ) : alreadyPending ? (
                        <Text style={styles.tag}>Pending</Text>
                      ) : (
                        <TouchableOpacity
                          style={styles.btnPrimary}
                          disabled={requestPending === h.username}
                          onPress={() => onRequest(h.username)}
                        >
                          <Text style={styles.btnPrimaryText}>
                            {requestPending === h.username ? 'Sending…' : 'Add'}
                          </Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  );
                })}
              </View>
            </ScrollView>
          )}
      </FadeInView>

      {/* Opt-in nudge */}
      <Modal
        visible={showOptIn}
        transparent
        animationType="fade"
        onRequestClose={() => setShowOptIn(false)}
      >
        <View style={styles.backdrop}>
          <View style={styles.optInCard}>
            <Text style={styles.optInTitle}>Share your training with friends?</Text>
            <Text style={styles.optInBody}>
              Friends will see your weekly session count and streak — never your weight, calories, or
              meals. You can turn this off any time.
            </Text>
            <View style={styles.optInButtons}>
              <TouchableOpacity style={styles.btnSecondary} onPress={() => setShowOptIn(false)}>
                <Text style={styles.btnSecondaryText}>Not now</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.btnPrimary} onPress={onTurnOnSharing}>
                <Text style={styles.btnPrimaryText}>Turn on</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );

  if (inline) {
    return <View style={{ flex: 1, paddingTop: spacing.sm }}>{content}</View>;
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          {content}
        </View>
      </View>
    </Modal>
  );
}

const createStyles = (colors: ReturnType<typeof getTheme>['colors']) =>
  StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.5)',
      justifyContent: 'flex-end',
    },
    sheet: {
      flex: 1,
      marginTop: 60,
      backgroundColor: colors.background,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.lg,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: spacing.md,
    },
    title: { fontSize: 20, fontWeight: '800', color: colors.textPrimary },
    socialToolbar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginBottom: spacing.sm,
    },
    toolbarLabel: {
      fontSize: 10,
      fontWeight: '800',
      color: colors.textMuted,
      letterSpacing: 0.7,
    },
    toolbarMeta: {
      fontSize: 12,
      color: colors.textSecondary,
      marginTop: 2,
      fontWeight: '600',
    },
    notificationButton: {
      width: 36,
      height: 36,
      borderRadius: 18,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
    },
    notificationButtonActive: {
      borderColor: colors.primary + '55',
      backgroundColor: colors.primary + '12',
    },
    notificationBadge: {
      position: 'absolute',
      top: -3,
      right: -2,
      minWidth: 16,
      height: 16,
      borderRadius: 8,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 4,
      backgroundColor: colors.error,
      borderWidth: 1,
      borderColor: colors.surface,
    },
    notificationBadgeText: {
      fontSize: 9,
      fontWeight: '900',
      color: '#fff',
    },
    notificationPanel: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: radius.md,
      padding: spacing.sm,
      marginBottom: spacing.md,
      gap: spacing.xs,
    },
    notificationPanelHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 2,
      marginBottom: 2,
    },
    notificationPanelTitle: {
      fontSize: 13,
      fontWeight: '800',
      color: colors.textPrimary,
    },
    markReadButton: {
      paddingHorizontal: spacing.sm,
      paddingVertical: 5,
      borderRadius: radius.full,
      backgroundColor: colors.primary + '14',
    },
    markReadText: {
      fontSize: 11,
      fontWeight: '800',
      color: colors.primary,
    },
    notificationEmpty: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      paddingVertical: spacing.sm,
      paddingHorizontal: 2,
    },
    notificationEmptyText: {
      fontSize: 12,
      color: colors.textMuted,
      fontWeight: '600',
    },
    notificationRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      borderRadius: radius.md,
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: 'transparent',
    },
    notificationRowUnread: {
      backgroundColor: colors.primary + '0F',
      borderColor: colors.primary + '20',
    },
    notificationIconBubble: {
      width: 30,
      height: 30,
      borderRadius: 15,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.primary + '14',
    },
    notificationTitleRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.xs,
    },
    notificationTitle: {
      flex: 1,
      fontSize: 12,
      fontWeight: '800',
      color: colors.textPrimary,
      lineHeight: 16,
    },
    notificationTime: {
      fontSize: 10,
      fontWeight: '700',
      color: colors.textMuted,
      marginTop: 1,
    },
    notificationBody: {
      fontSize: 11,
      color: colors.textSecondary,
      lineHeight: 15,
      marginTop: 2,
    },
    unreadDot: {
      width: 7,
      height: 7,
      borderRadius: 4,
      backgroundColor: colors.primary,
    },
    tabStrip: {
      flexDirection: 'row',
      gap: 2,
      marginBottom: spacing.md,
      backgroundColor: colors.background,
      borderRadius: 999,
      padding: 3,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    tab: {
      flex: 1,
      paddingVertical: 6,
      paddingHorizontal: 8,
      borderRadius: 999,
      alignItems: 'center',
    },
    tabActive: { backgroundColor: colors.primary + '22' },
    tabText: { fontSize: 10, fontWeight: '500', color: colors.textMuted, letterSpacing: 0.7, textTransform: 'uppercase', opacity: 0.55 },
    tabTextActive: { color: colors.primary, fontWeight: '700', opacity: 1 },
    card: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: radius.lg,
      padding: spacing.lg,
      marginBottom: spacing.md,
      gap: 6,
    },
    cardLabel: {
      fontSize: 11,
      fontWeight: '700',
      color: colors.textMuted,
      letterSpacing: 0.5,
      marginBottom: 4,
    },
    cardBody: { fontSize: 13, color: colors.textPrimary, lineHeight: 18 },
    youRow: {
      marginTop: spacing.md,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingTop: spacing.sm,
      borderTopColor: colors.border,
      borderTopWidth: 1,
    },
    youLabel: { fontSize: 11, fontWeight: '700', color: colors.textMuted, letterSpacing: 0.5 },
    youValue: { fontSize: 13, fontWeight: '700', color: colors.textPrimary },
    privacyRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 7,
      marginTop: spacing.sm,
      paddingTop: spacing.sm,
      borderTopWidth: 1,
      borderTopColor: colors.border,
    },
    privacyText: { flex: 1, fontSize: 11, color: colors.textSecondary, lineHeight: 15, fontWeight: '600' },
    section: { marginBottom: spacing.lg },
    sectionLabel: {
      fontSize: 11,
      fontWeight: '700',
      color: colors.textMuted,
      letterSpacing: 0.5,
      marginBottom: spacing.sm,
    },
    friendRow: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      marginBottom: spacing.xs,
      gap: spacing.sm,
    },
    activeDot: {
      position: 'absolute',
      bottom: -1,
      right: -1,
      width: 10,
      height: 10,
      borderRadius: 5,
      borderColor: colors.surface,
      borderWidth: 2,
    },
    friendName: { fontSize: 14, fontWeight: '700', color: colors.textPrimary },
    friendMeta: { fontSize: 11, color: colors.textSecondary, marginTop: 2 },
    btnPrimary: {
      backgroundColor: colors.primary,
      paddingHorizontal: spacing.md,
      paddingVertical: 8,
      borderRadius: radius.full,
    },
    btnPrimaryText: { fontSize: 12, fontWeight: '800', color: getContrastingTextColor(colors.primary) },
    btnSecondary: {
      backgroundColor: 'transparent',
      borderColor: colors.border,
      borderWidth: 1,
      paddingHorizontal: spacing.md,
      paddingVertical: 8,
      borderRadius: radius.full,
    },
    btnSecondaryText: { fontSize: 12, fontWeight: '700', color: colors.textSecondary },
    tag: {
      fontSize: 11,
      fontWeight: '700',
      color: colors.textMuted,
      paddingHorizontal: spacing.sm,
    },
    inviteCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: radius.md,
      padding: spacing.md,
      marginBottom: spacing.sm,
    },
    inviteIcon: {
      width: 34,
      height: 34,
      borderRadius: 17,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.primary + '18',
    },
    inviteTitle: { fontSize: 13, fontWeight: '800', color: colors.textPrimary },
    inviteHandle: { fontSize: 14, fontWeight: '900', color: colors.primary, marginTop: 2 },
    inviteBody: { fontSize: 11, color: colors.textMuted, lineHeight: 15, marginTop: 2 },
    inviteButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      backgroundColor: colors.primary,
      paddingHorizontal: spacing.sm,
      paddingVertical: 8,
      borderRadius: radius.full,
    },
    searchRow: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      paddingVertical: 8,
      gap: spacing.sm,
      marginBottom: spacing.sm,
    },
    searchInput: {
      flex: 1,
      fontSize: 14,
      color: colors.textPrimary,
      paddingVertical: 4,
    },
    empty: {
      fontSize: 12,
      color: colors.textMuted,
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.sm,
    },
    emptyCard: {
      alignItems: 'center',
      gap: 8,
      padding: spacing.lg,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
    },
    emptyIconBubble: {
      width: 44,
      height: 44,
      borderRadius: 22,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.primary + '18',
    },
    emptyTitle: {
      fontSize: 15,
      fontWeight: '800',
      color: colors.textPrimary,
      textAlign: 'center',
    },
    emptyBody: {
      fontSize: 12,
      lineHeight: 18,
      color: colors.textSecondary,
      textAlign: 'center',
    },
    optInCard: {
      margin: spacing.lg,
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: radius.lg,
      padding: spacing.lg,
      gap: spacing.md,
      alignSelf: 'center',
      maxWidth: 380,
      width: '90%',
    },
    optInTitle: { fontSize: 16, fontWeight: '800', color: colors.textPrimary },
    optInBody: { fontSize: 13, color: colors.textSecondary, lineHeight: 19 },
    optInButtons: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm },
  });
