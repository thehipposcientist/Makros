import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  AppState,
  LayoutAnimation,
  Share,
  Switch,
} from 'react-native';
import FadeInView from './FadeInView';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import QRCode from 'react-native-qrcode-svg';
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
type SocialTab = 'friends' | 'activity' | 'profile';

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
  initialSearchUsername?: string | null;
  onInitialSearchConsumed?: () => void;
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

function normalizeInviteUsername(value: string | null | undefined): string {
  return String(value ?? '')
    .trim()
    .replace(/^@+/, '')
    .replace(/[^a-zA-Z0-9_.-]/g, '')
    .slice(0, 40)
    .toLowerCase();
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
  if (n.notification_type === 'feed_comment') return 'chatbubble-outline';
  return 'notifications-outline';
}

function notificationTitle(n: SocialNotification): string {
  const name = notificationActorName(n);
  if (n.notification_type === 'friend_request') return `${name} sent you a friend request`;
  if (n.notification_type === 'friend_accept') return `${name} accepted your request`;
  if (n.notification_type === 'feed_like') return `${name} liked your workout`;
  if (n.notification_type === 'feed_comment') return `${name} commented on your workout`;
  return 'New social update';
}

function notificationBody(n: SocialNotification): string {
  if (n.notification_type === 'friend_request') return 'Tap to review the request.';
  if (n.notification_type === 'friend_accept') return "You're now connected on Social.";
  if (n.notification_type === 'feed_like') {
    const focus = n.payload?.focus;
    return focus ? `${focus} got some love.` : 'Tap to jump back to Activity.';
  }
  if (n.notification_type === 'feed_comment') {
    const comment = n.payload?.comment;
    return comment ? `"${comment}"` : 'Tap to jump back to Activity.';
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
  initialSearchUsername,
  onInitialSearchConsumed,
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
  const [profileNameDraft, setProfileNameDraft] = useState('');
  const [profileSaving, setProfileSaving] = useState(false);
  const [avatarSaving, setAvatarSaving] = useState(false);
  // Feed is the default tab so users land on activity immediately.
  // Friends tab lazy-renders on first switch (no extra cost on open).
  const [activeTab, setActiveTab] = useState<SocialTab>(
    SOCIAL_ACTIVITY_FEED_ENABLED ? 'activity' : 'friends',
  );
  const initialRequestsFocusedRef = useRef(false);
  // Bumped to force the activity view to re-fetch (e.g., after share).
  const [feedRefreshKey, setFeedRefreshKey] = useState(0);
  void setFeedRefreshKey;

  useEffect(() => {
    if (!me) return;
    setProfileNameDraft(me.display_name ?? '');
  }, [me?.display_name, me?.user_id]);

  useEffect(() => {
    const username = normalizeInviteUsername(initialSearchUsername);
    if (!username) return;
    setActiveTab('friends');
    setNotificationTrayOpen(false);
    setSearch(username);
    onInitialSearchConsumed?.();
  }, [initialSearchUsername, onInitialSearchConsumed]);

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
        const incomingCount = l.value.pending.filter(p => p.direction === 'incoming').length;
        if (incomingCount > 0 && !initialRequestsFocusedRef.current) {
          setActiveTab('profile');
          initialRequestsFocusedRef.current = true;
        } else if (incomingCount === 0 && initialRequestsFocusedRef.current) {
          initialRequestsFocusedRef.current = false;
        }
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

  useEffect(() => {
    if (!visible && !inline) return;
    const poll = () => {
      if (AppState.currentState === 'active') refresh();
    };
    const id = setInterval(poll, 45_000);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
    });
    return () => {
      clearInterval(id);
      sub.remove();
    };
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

  const onSetSharing = useCallback(async (enabled: boolean) => {
    try {
      const updated = await updateSocialMe(authToken, { share_activity_enabled: enabled });
      setMe(updated);
      setShowOptIn(false);
      const d = await getSocialDigest(authToken);
      setDigest(d);
    } catch (e: any) {
      Alert.alert('Could not update', e?.message ?? 'Try again');
    }
  }, [authToken]);

  const onTurnOnSharing = useCallback(async () => {
    await onSetSharing(true);
  }, [onSetSharing]);

  const onSaveSocialProfile = useCallback(async () => {
    const displayName = profileNameDraft.trim();
    setProfileSaving(true);
    try {
      const updated = await updateSocialMe(authToken, { display_name: displayName || null });
      setMe(updated);
      setProfileNameDraft(updated.display_name ?? '');
      import('../utils/feedback').then(f => f.hapticSuccess?.()).catch(() => {});
    } catch (e: any) {
      Alert.alert('Could not save profile', e?.message ?? 'Try again');
    } finally {
      setProfileSaving(false);
    }
  }, [authToken, profileNameDraft]);

  const onPickAvatar = useCallback(async () => {
    setAvatarSaving(true);
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Permission needed', 'Please allow photo library access to choose a profile photo.');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        quality: 0.45,
        base64: true,
        exif: false,
        mediaTypes: ['images'] as any,
        allowsEditing: true,
        aspect: [1, 1],
      });
      const asset = result.assets?.[0];
      if (result.canceled || !asset?.base64) return;
      const mime = asset.mimeType || 'image/jpeg';
      const updated = await updateSocialMe(authToken, { avatar_url: `data:${mime};base64,${asset.base64}` });
      setMe(updated);
    } catch (e: any) {
      Alert.alert('Could not update photo', e?.message ?? 'Try again');
    } finally {
      setAvatarSaving(false);
    }
  }, [authToken]);

  const onRemoveAvatar = useCallback(async () => {
    setAvatarSaving(true);
    try {
      const updated = await updateSocialMe(authToken, { avatar_url: null });
      setMe(updated);
    } catch (e: any) {
      Alert.alert('Could not remove photo', e?.message ?? 'Try again');
    } finally {
      setAvatarSaving(false);
    }
  }, [authToken]);

  const onShareInvite = useCallback(async () => {
    if (!me?.username) {
      Alert.alert('Username unavailable', 'Open Friends again after your profile finishes loading.');
      return;
    }
    const inviteLink = `thallo://friend/${encodeURIComponent(me.username)}`;
    try {
      await Share.share({
        message: `Add me on Thallo: @${me.username}\n\nOpen in app: ${inviteLink}`,
      });
    } catch (e: any) {
      Alert.alert('Could not share invite', e?.message ?? 'Try again');
    }
  }, [me?.username]);

  const incoming = list?.pending.filter((p) => p.direction === 'incoming') ?? [];
  const outgoing = list?.pending.filter((p) => p.direction === 'outgoing') ?? [];
  const friends = list?.friends ?? [];
  const inviteLink = me?.username ? `thallo://friend/${encodeURIComponent(me.username)}` : '';
  const hasUnreadSocial = unreadNotifications > 0;
  const hasUnreadFriendRequests = notifications.some(
    (n) => !n.read_at && n.notification_type === 'friend_request',
  );
  const hasUnreadActivity = notifications.some(
    (n) => !n.read_at && n.notification_type !== 'friend_request',
  );
  const hasIncomingRequests = incoming.length > 0;
  const hasFriendUpdates = hasIncomingRequests || hasUnreadFriendRequests;

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
        setActiveTab('profile');
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

  const myProfileFriend = me
    ? {
        user_id: me.user_id,
        username: me.username,
        display_name: me.display_name ?? me.username,
        avatar_url: me.avatar_url ?? null,
        goal: null,
        share_enabled: true,
        sessions: digest?.you.sessions ?? 0,
        streak: digest?.you.streak ?? 0,
        last_active_within_48h: (digest?.you.sessions ?? 0) > 0,
      }
    : null;

  const friendSearchSection = (
    <View style={styles.section} testID="social-friend-search">
      <Text style={styles.sectionLabel}>ADD FRIENDS</Text>
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
                  {requestPending === h.username ? 'Sending...' : 'Add'}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        );
      })}
    </View>
  );

  const myProfileSection = myProfileFriend ? (
    <TouchableOpacity
      testID="social-my-profile-card"
      accessibilityLabel="social-my-profile-card"
      style={styles.selfProfileCard}
      activeOpacity={0.78}
      onPress={() => onViewFriend?.(myProfileFriend.user_id, myProfileFriend.display_name, myProfileFriend)}
    >
      <SocialAvatar
        avatarUrl={myProfileFriend.avatar_url}
        name={myProfileFriend.display_name}
        username={myProfileFriend.username}
        size={44}
        backgroundColor={colors.primary + '22'}
        borderColor={colors.primary + '55'}
        textColor={colors.primary}
      />
      <View style={{ flex: 1 }}>
        <Text style={styles.selfProfileTitle}>My profile</Text>
        <Text style={styles.selfProfileMeta}>
          @{myProfileFriend.username} · {myProfileFriend.sessions} session{myProfileFriend.sessions === 1 ? '' : 's'} this week
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
    </TouchableOpacity>
  ) : null;

  const profileEditSection = me ? (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>SOCIAL PROFILE</Text>
      <View style={styles.profileEditCard}>
        <View style={styles.profileEditTopRow}>
          <TouchableOpacity
            style={styles.profileAvatarButton}
            onPress={onPickAvatar}
            disabled={avatarSaving}
            activeOpacity={0.78}
            accessibilityRole="button"
            accessibilityLabel="Choose social profile photo"
          >
            <SocialAvatar
              avatarUrl={me.avatar_url}
              name={me.display_name}
              username={me.username}
              size={54}
              backgroundColor={colors.primary + '22'}
              borderColor={colors.primary + '55'}
              textColor={colors.primary}
            />
            <View style={styles.profileAvatarBadge}>
              {avatarSaving ? (
                <ActivityIndicator size="small" color={getContrastingTextColor(colors.primary)} />
              ) : (
                <Ionicons name="camera-outline" size={13} color={getContrastingTextColor(colors.primary)} />
              )}
            </View>
          </TouchableOpacity>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.profileEditTitle}>@{me.username}</Text>
            <Text style={styles.profileEditMeta}>
              {me.share_activity_enabled ? 'Sharing on' : 'Sharing off'}
            </Text>
          </View>
          {me.avatar_url ? (
            <TouchableOpacity
              style={styles.avatarRemoveBtn}
              onPress={onRemoveAvatar}
              disabled={avatarSaving}
              activeOpacity={0.78}
              accessibilityRole="button"
              accessibilityLabel="Remove social profile photo"
            >
              <Ionicons name="trash-outline" size={15} color={colors.textMuted} />
            </TouchableOpacity>
          ) : null}
        </View>
        <View style={styles.profileFieldWrap}>
          <Text style={styles.profileFieldLabel}>Display name</Text>
          <TextInput
            style={styles.profileNameInput}
            placeholder={me.username}
            placeholderTextColor={colors.textMuted}
            maxLength={40}
            value={profileNameDraft}
            onChangeText={setProfileNameDraft}
          />
        </View>
        <View style={styles.shareToggleRow}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.shareToggleTitle}>Workout sharing</Text>
            <Text style={styles.shareToggleBody}>
              Friends see sessions, streaks, exercises, set load, time, and distance.
            </Text>
          </View>
          <Switch
            value={!!me.share_activity_enabled}
            onValueChange={onSetSharing}
            trackColor={{ false: colors.border, true: colors.primary + '77' }}
            thumbColor={me.share_activity_enabled ? colors.primary : colors.textMuted}
            ios_backgroundColor={colors.border}
          />
        </View>
        <TouchableOpacity
          style={[
            styles.profileSaveBtn,
            (profileSaving || profileNameDraft.trim() === (me.display_name ?? '')) && styles.profileSaveBtnDisabled,
          ]}
          onPress={onSaveSocialProfile}
          disabled={profileSaving || profileNameDraft.trim() === (me.display_name ?? '')}
          activeOpacity={0.82}
        >
          {profileSaving ? (
            <ActivityIndicator size="small" color={colors.textMuted} />
          ) : (
            <>
              <Ionicons name="checkmark-outline" size={15} color={colors.primary} />
              <Text style={styles.profileSaveText}>Save profile</Text>
            </>
          )}
        </TouchableOpacity>
      </View>
    </View>
  ) : null;

  const profileInviteSection = me?.username ? (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>YOUR HANDLE</Text>
      <View style={styles.inviteCard}>
        <View style={styles.inviteIcon}>
          <Ionicons name="person-add-outline" size={18} color={colors.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.inviteTitle}>Invite link</Text>
          <Text style={styles.inviteHandle}>@{me.username}</Text>
          <Text style={styles.inviteBody}>
            {inviteLink}
          </Text>
        </View>
        <TouchableOpacity style={styles.inviteButton} onPress={onShareInvite} activeOpacity={0.78}>
          <Ionicons name="share-outline" size={15} color={getContrastingTextColor(colors.primary)} />
          <Text style={styles.btnPrimaryText}>Share</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.qrInviteCard}>
        <View style={styles.qrCodeWrap}>
          <QRCode
            value={inviteLink}
            size={116}
            color="#111827"
            backgroundColor="#FFFFFF"
            quietZone={8}
          />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.qrInviteTitle}>Scan to add</Text>
          <Text style={styles.qrInviteBody}>
            Opens Thallo to your friend search handle.
          </Text>
        </View>
      </View>
    </View>
  ) : null;

  // Single privacy summary that used to live above every post on the
  // Activity feed. Moved here so the info is visible without nagging
  // the user every time they scroll the feed. Read-only static copy.
  const privacyInfoSection = (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>WHAT FRIENDS SEE</Text>
      <View style={[styles.card, { flexDirection: 'row', gap: 10, alignItems: 'flex-start' }]}>
        <View style={{
          width: 32, height: 32, borderRadius: 16,
          backgroundColor: colors.primary + '22',
          alignItems: 'center', justifyContent: 'center',
        }}>
          <Ionicons name="shield-checkmark-outline" size={17} color={colors.primary} />
        </View>
        <Text style={[styles.cardBody, { flex: 1, lineHeight: 18 }]}>
          Friends see workout activity, including recorded load, time, and distance. Calories, macros, meals, body weight, and measurements stay private.
        </Text>
      </View>
    </View>
  );

  const sharingReminder = me && !me.share_activity_enabled && friends.length > 0 ? (
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
  ) : null;

  const incomingRequestsSection = (
    <View style={styles.section} testID="social-incoming-requests">
      <Text style={styles.sectionLabel}>REQUESTS{incoming.length > 0 ? `  ·  ${incoming.length}` : ''}</Text>
      {incoming.length === 0 ? (
        <View style={styles.emptyCard}>
          <View style={styles.emptyIconBubble}>
            <Ionicons name="mail-open-outline" size={24} color={colors.primary} />
          </View>
          <Text {...dynamicTextProps} style={styles.emptyTitle}>No friend invites</Text>
          <Text {...dynamicTextProps} style={styles.emptyBody}>
            New requests will show up here.
          </Text>
        </View>
      ) : (
        incoming.map((p, i) => (
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
        ))
      )}
    </View>
  );

  const friendsListSection = (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>FRIENDS{friends.length > 0 ? `  ·  ${friends.length}` : ''}</Text>
      {friends.length === 0 ? (
        <View style={styles.emptyCard}>
          <View style={styles.emptyIconBubble}>
            <Ionicons name="people-outline" size={24} color={colors.primary} />
          </View>
          <Text {...dynamicTextProps} style={styles.emptyTitle}>No friends yet</Text>
          <Text {...dynamicTextProps} style={styles.emptyBody}>
            Search by username to add friends.
          </Text>
        </View>
      ) : (
        <View style={styles.friendGrid}>
          {friends.map((f) => (
            <TouchableOpacity
              key={f.user_id}
              testID={`social-friend-row-${e2eId(f.username)}`}
              accessibilityLabel={`social-friend-row-${e2eId(f.username)}`}
              style={styles.friendCircleCard}
              activeOpacity={0.72}
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
                size={58}
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
              <Text style={styles.friendCircleName} numberOfLines={1}>
                {f.display_name ?? f.username}
              </Text>
              <Text style={styles.friendCircleHandle} numberOfLines={1}>
                @{f.username}
              </Text>
              {/* Visible "···" affordance for Remove / Block / Report.
                  Anchored top-right inside the existing card so the
                  3-column grid layout (width: 33.333%) is preserved.
                  Long-press still fires the same sheet for users who
                  already learned that gesture. */}
              <TouchableOpacity
                testID={`social-friend-options-${e2eId(f.username)}`}
                accessibilityLabel={`Friend options for ${f.display_name ?? f.username}`}
                onPress={() => onFriendOptions(f)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                style={styles.friendCircleOptionsBtn}>
                <Ionicons name="ellipsis-horizontal" size={14} color={colors.textSecondary} />
              </TouchableOpacity>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  );

  const outgoingPendingSection = outgoing.length > 0 ? (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>SENT REQUESTS</Text>
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
  ) : null;

  const content = (
    <>
      {!inline && (
        <View style={styles.header}>
          <Text style={styles.title}>Social</Text>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Ionicons name="close" size={22} color={colors.textSecondary} />
          </TouchableOpacity>
        </View>
      )}

      {notificationTrayOpen ? (
        <View testID="social-notifications-panel" style={[styles.notificationPanel, inline && styles.inlineChrome]}>
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

      {/* Social tabs. "Activity" is a bounded digest (latest 10 shares
          from friends), not an open scrolling feed. */}
      <View style={[styles.tabStrip, inline && styles.inlineChrome]}>
        <View style={styles.tabGroup}>
          {SOCIAL_ACTIVITY_FEED_ENABLED ? (
            <TouchableOpacity
              testID="social-tab-activity"
              accessibilityLabel={hasUnreadActivity ? 'Activity, new updates' : 'Activity'}
              accessibilityRole="tab"
              accessibilityState={{ selected: activeTab === 'activity' }}
              style={[styles.tab, activeTab === 'activity' && styles.tabActive]}
              onPress={() => {
                setActiveTab('activity');
                setNotificationTrayOpen(false);
              }}
              activeOpacity={0.78}
            >
              <Ionicons
                name="pulse-outline"
                size={15}
                color={activeTab === 'activity' ? colors.primary : colors.textMuted}
              />
              <View style={styles.tabLabelRow}>
                <Text
                  style={[styles.tabText, activeTab === 'activity' && styles.tabTextActive]}
                  numberOfLines={1}
                >
                  Activity
                </Text>
                {hasUnreadActivity ? <View style={styles.tabDot} /> : null}
              </View>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity
            testID="social-tab-friends"
            accessibilityLabel="Friends"
            accessibilityRole="tab"
            accessibilityState={{ selected: activeTab === 'friends' }}
            style={[styles.tab, activeTab === 'friends' && styles.tabActive]}
            onPress={() => {
              setActiveTab('friends');
              setNotificationTrayOpen(false);
            }}
            activeOpacity={0.78}
          >
            <Ionicons
              name="people-outline"
              size={15}
              color={activeTab === 'friends' ? colors.primary : colors.textMuted}
            />
            <View style={styles.tabLabelRow}>
              <Text
                style={[styles.tabText, activeTab === 'friends' && styles.tabTextActive]}
                numberOfLines={1}
              >
                Friends
              </Text>
            </View>
          </TouchableOpacity>
          <TouchableOpacity
            testID="social-tab-profile"
            accessibilityLabel={hasFriendUpdates ? 'Profile, friend requests waiting' : 'Profile'}
            accessibilityRole="tab"
            accessibilityState={{ selected: activeTab === 'profile' }}
            style={[styles.tab, activeTab === 'profile' && styles.tabActive]}
            onPress={() => {
              setActiveTab('profile');
              setNotificationTrayOpen(false);
            }}
            activeOpacity={0.78}
          >
            <Ionicons
              name="person-circle-outline"
              size={15}
              color={activeTab === 'profile' ? colors.primary : colors.textMuted}
            />
            <View style={styles.tabLabelRow}>
              <Text
                style={[styles.tabText, activeTab === 'profile' && styles.tabTextActive]}
                numberOfLines={1}
              >
                Profile
              </Text>
              {incoming.length > 0 ? (
                <View style={styles.tabCountBadge}>
                  <Text style={styles.tabCountText}>{incoming.length > 9 ? '9+' : incoming.length}</Text>
                </View>
              ) : hasUnreadFriendRequests ? (
                <View style={styles.tabDot} />
              ) : null}
            </View>
          </TouchableOpacity>
        </View>
        <TouchableOpacity
          testID="social-notifications-toggle"
          accessibilityLabel={`${unreadNotifications} unread social notification${unreadNotifications === 1 ? '' : 's'}`}
          accessibilityRole="button"
          accessibilityState={{ expanded: notificationTrayOpen }}
          onPress={() => setNotificationTrayOpen(v => !v)}
          style={[styles.notificationDotButton, notificationTrayOpen && styles.notificationDotButtonActive]}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          activeOpacity={0.75}
        >
          <Ionicons
            name={hasUnreadSocial ? 'notifications' : 'notifications-outline'}
            size={17}
            color={hasUnreadSocial || notificationTrayOpen ? colors.primary : colors.textMuted}
          />
          {hasUnreadSocial ? <View style={styles.notificationBadgeDot} /> : null}
        </TouchableOpacity>
      </View>

      <FadeInView key={activeTab} duration={240} slideDistance={8} style={{ flex: 1 }}>
        {SOCIAL_ACTIVITY_FEED_ENABLED && activeTab === 'activity' ? (
          <SocialFeedView
            authToken={authToken}
            themeName={themeName}
            bottomPadding={inline ? 116 : 8}
            refreshKey={feedRefreshKey}
            digest={digest}
            friendCount={friends.length}
            sharingEnabled={!!me?.share_activity_enabled}
            currentUserId={me?.user_id ?? null}
            onOpenFriends={() => setActiveTab('friends')}
            onTurnOnSharing={onTurnOnSharing}
            onShareInvite={onShareInvite}
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
        ) : activeTab === 'friends' ? (
          <ScrollView
            testID="social-friends-list"
            style={{ flex: 1 }}
            contentContainerStyle={[
              styles.socialScrollContent,
              inline && styles.inlineScrollContent,
              { paddingBottom: inline ? 128 : 24 },
            ]}>
            {friendSearchSection}
            {/* Pending friend requests live on the Friends tab so a new
                request is impossible to miss — most users never visit
                the Profile tab where this used to be the only home. */}
            {incoming.length > 0 ? incomingRequestsSection : null}
            {friendsListSection}
          </ScrollView>
        ) : (
          <ScrollView
            testID="social-profile-tab"
            style={{ flex: 1 }}
            contentContainerStyle={[
              styles.socialScrollContent,
              inline && styles.inlineScrollContent,
              { paddingBottom: inline ? 128 : 24 },
            ]}>
            {/* Incoming requests now live on the Friends tab — kept off
                the Profile tab to avoid duplicate inbox surfaces. */}
            {outgoingPendingSection}
            {profileEditSection}
            {myProfileSection}
            {profileInviteSection}
            {sharingReminder}
            {privacyInfoSection}
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
    socialScrollContent: {
      paddingTop: 8,
    },
    inlineScrollContent: {
      paddingHorizontal: 12,
    },
    inlineChrome: {
      marginHorizontal: 12,
    },
    tabStrip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginBottom: spacing.md,
    },
    tabGroup: {
      flexDirection: 'row',
      alignItems: 'stretch',
      flex: 1,
      gap: 8,
    },
    tab: {
      flex: 1,
      minHeight: 40,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      paddingHorizontal: 8,
      paddingVertical: 9,
      borderRadius: radius.full,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
    },
    tabActive: {
      backgroundColor: colors.primary + '22',
      borderColor: colors.primary,
    },
    tabLabelRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 5,
      minWidth: 0,
    },
    tabText: {
      fontSize: 12,
      fontWeight: '700',
      color: colors.textMuted,
      flexShrink: 1,
      textAlign: 'center',
    },
    tabTextActive: {
      color: colors.primary,
      fontWeight: '800',
    },
    tabDot: {
      width: 7,
      height: 7,
      borderRadius: 4,
      backgroundColor: colors.error,
    },
    tabCountBadge: {
      minWidth: 18,
      height: 18,
      paddingHorizontal: 5,
      borderRadius: 9,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.error,
    },
    tabCountText: {
      fontSize: 10,
      fontWeight: '900',
      color: '#FFFFFF',
    },
    notificationDotButton: {
      width: 42,
      height: 42,
      borderRadius: 21,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderWidth: 1,
    },
    notificationDotButtonActive: {
      backgroundColor: colors.primary + '14',
      borderColor: colors.primary + '33',
    },
    notificationBadgeDot: {
      position: 'absolute',
      top: 8,
      right: 8,
      width: 7,
      height: 7,
      borderRadius: 4,
      backgroundColor: colors.error,
      borderWidth: 1,
      borderColor: colors.background,
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
      backgroundColor: colors.error,
    },
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
    selfProfileCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: radius.md,
      padding: spacing.md,
      marginBottom: spacing.md,
    },
    selfProfileTitle: {
      fontSize: 13,
      fontWeight: '900',
      color: colors.textPrimary,
    },
    selfProfileMeta: {
      fontSize: 11,
      fontWeight: '700',
      color: colors.textMuted,
      marginTop: 2,
    },
    profileEditCard: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: radius.md,
      padding: spacing.md,
      gap: spacing.md,
    },
    profileEditTopRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    profileAvatarButton: {
      width: 62,
      height: 62,
      alignItems: 'center',
      justifyContent: 'center',
    },
    profileAvatarBadge: {
      position: 'absolute',
      right: 0,
      bottom: 0,
      width: 24,
      height: 24,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.primary,
      borderWidth: 2,
      borderColor: colors.surface,
    },
    profileEditTitle: { fontSize: 14, fontWeight: '900', color: colors.textPrimary },
    profileEditMeta: { fontSize: 11, fontWeight: '700', color: colors.textMuted, marginTop: 2 },
    avatarRemoveBtn: {
      width: 34,
      height: 34,
      borderRadius: 17,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surfaceRaised,
    },
    profileFieldWrap: { gap: 6 },
    profileFieldLabel: { fontSize: 11, fontWeight: '800', color: colors.textMuted },
    profileNameInput: {
      minHeight: 42,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surfaceRaised,
      paddingHorizontal: spacing.md,
      fontSize: 14,
      fontWeight: '700',
      color: colors.textPrimary,
    },
    shareToggleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surfaceRaised,
      padding: spacing.md,
    },
    shareToggleTitle: { fontSize: 13, fontWeight: '900', color: colors.textPrimary },
    shareToggleBody: { fontSize: 11, fontWeight: '600', color: colors.textMuted, lineHeight: 15, marginTop: 2 },
    profileSaveBtn: {
      minHeight: 38,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      borderRadius: radius.full,
      borderWidth: 1,
      borderColor: colors.primary + '33',
      backgroundColor: colors.primary + '12',
    },
    profileSaveBtnDisabled: {
      borderColor: colors.border,
      backgroundColor: colors.surfaceRaised,
      opacity: 0.72,
    },
    profileSaveText: { fontSize: 12, fontWeight: '900', color: colors.primary },
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
    friendGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      rowGap: spacing.md,
      marginHorizontal: -4,
    },
    friendCircleCard: {
      width: '33.333%',
      alignItems: 'center',
      paddingHorizontal: 4,
      paddingVertical: 4,
      minHeight: 104,
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
    friendCircleName: {
      width: '100%',
      marginTop: 7,
      fontSize: 12,
      fontWeight: '800',
      color: colors.textPrimary,
      textAlign: 'center',
    },
    friendCircleHandle: {
      width: '100%',
      marginTop: 2,
      fontSize: 10,
      fontWeight: '700',
      color: colors.textMuted,
      textAlign: 'center',
    },
    friendCircleOptionsBtn: {
      position: 'absolute',
      // Sit just inside the card padding (paddingHorizontal: 4) at the
      // top-right corner so the dot doesn't overlap the avatar but is
      // still obviously part of the card.
      top: 0,
      right: 4,
      width: 24,
      height: 24,
      borderRadius: 12,
      backgroundColor: colors.surfaceRaised,
      borderWidth: 1,
      borderColor: colors.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
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
    qrInviteCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: radius.md,
      padding: spacing.md,
    },
    qrCodeWrap: {
      padding: 8,
      borderRadius: radius.md,
      backgroundColor: '#FFFFFF',
    },
    qrInviteTitle: { fontSize: 13, fontWeight: '900', color: colors.textPrimary },
    qrInviteBody: { fontSize: 11, fontWeight: '600', color: colors.textMuted, lineHeight: 15, marginTop: 2 },
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
