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
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getTheme, radius, spacing } from '../constants/theme';
import type { AppThemeName } from '../types';
import {
  acceptFriend,
  getSocialDigest,
  getSocialMe,
  listFriends,
  rejectFriend,
  removeFriend,
  requestFriend,
  searchUsers,
  updateSocialMe,
  type SocialDigest,
  type SocialFriend,
  type SocialFriendsList,
  type SocialMe,
  type SocialSearchHit,
} from '../services/api';

interface Props {
  visible: boolean;
  authToken: string;
  onClose: () => void;
  themeName?: AppThemeName;
  /** When true, renders inline (no Modal/backdrop/close button).
   *  Used by the Friends tab so the content fills the tab area. */
  inline?: boolean;
  onViewFriend?: (userId: number, displayName: string, digestFriend?: import('../services/api').SocialDigestFriend) => void;
}

const goalLabel = (g: string | null | undefined): string => {
  if (!g) return '';
  return g
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
};

export default function FriendsModal({ visible, authToken, onClose, themeName, inline, onViewFriend }: Props) {
  const theme = getTheme(themeName);
  const colors = theme.colors;
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [me, setMe] = useState<SocialMe | null>(null);
  const [list, setList] = useState<SocialFriendsList | null>(null);
  const [digest, setDigest] = useState<SocialDigest | null>(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [hits, setHits] = useState<SocialSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [requestPending, setRequestPending] = useState<string | null>(null);
  const [showOptIn, setShowOptIn] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [m, l, d] = await Promise.allSettled([
        getSocialMe(authToken),
        listFriends(authToken),
        getSocialDigest(authToken),
      ]);
      if (m.status === 'fulfilled') setMe(m.value);
      if (l.status === 'fulfilled') setList(l.value);
      if (d.status === 'fulfilled') setDigest(d.value);
    } catch {
      // silent — user sees empty state
    } finally {
      setLoading(false);
    }
  }, [authToken]);

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
      try {
        await acceptFriend(authToken, id);
        await refresh();
        if (me && !me.share_activity_enabled) setShowOptIn(true);
      } catch (e: any) {
        Alert.alert('Could not accept', e?.message ?? 'Try again');
      }
    },
    [authToken, me, refresh],
  );

  const onReject = useCallback(
    async (id: number) => {
      try {
        await rejectFriend(authToken, id);
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

  const incoming = list?.pending.filter((p) => p.direction === 'incoming') ?? [];
  const outgoing = list?.pending.filter((p) => p.direction === 'outgoing') ?? [];
  const friends = list?.friends ?? [];

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

      {loading && !list ? (
            <View style={{ padding: 24, alignItems: 'center' }}>
              <ActivityIndicator color={colors.primary} />
            </View>
          ) : (
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 24 }}>
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
                  {incoming.map((p) => (
                    <View key={p.friendship_id} style={styles.friendRow}>
                      <View style={styles.avatar}>
                        <Text style={styles.avatarText}>
                          {(p.display_name?.[0] ?? p.username[0] ?? '?').toUpperCase()}
                        </Text>
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.friendName}>{p.display_name ?? p.username}</Text>
                        <Text style={styles.friendMeta}>@{p.username}</Text>
                      </View>
                      <TouchableOpacity style={styles.btnSecondary} onPress={() => onReject(p.friendship_id)}>
                        <Text style={styles.btnSecondaryText}>Decline</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={styles.btnPrimary} onPress={() => onAccept(p.friendship_id)}>
                        <Text style={styles.btnPrimaryText}>Accept</Text>
                      </TouchableOpacity>
                    </View>
                  ))}
                </View>
              ) : null}

              {/* Friends list */}
              <View style={styles.section}>
                <Text style={styles.sectionLabel}>FRIENDS{friends.length > 0 ? `  ·  ${friends.length}` : ''}</Text>
                {friends.length === 0 ? (
                  <Text style={styles.empty}>
                    No friends yet. Search by username below to send a request.
                  </Text>
                ) : (
                  friends.map((f) => (
                    <TouchableOpacity
                      key={f.user_id}
                      style={styles.friendRow}
                      activeOpacity={0.7}
                      onPress={() => {
                        if (onViewFriend) {
                          const df = digest?.friends.find((d) => d.user_id === f.user_id);
                          const digestFriend = df ?? {
                            user_id: f.user_id, username: f.username,
                            display_name: f.display_name ?? f.username,
                            goal: f.goal, share_enabled: true,
                            sessions: 0, streak: f.streak,
                            last_active_within_48h: f.last_active_within_48h,
                          };
                          onViewFriend(f.user_id, f.display_name ?? f.username, digestFriend);
                        }
                      }}
                      onLongPress={() => onRemove(f)}
                    >
                      <View style={styles.avatar}>
                        <Text style={styles.avatarText}>
                          {(f.display_name?.[0] ?? f.username[0] ?? '?').toUpperCase()}
                        </Text>
                        <View
                          style={[
                            styles.activeDot,
                            { backgroundColor: f.last_active_within_48h ? colors.success : colors.border },
                          ]}
                        />
                      </View>
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
                      <View style={styles.avatar}>
                        <Text style={styles.avatarText}>
                          {(p.display_name?.[0] ?? p.username[0] ?? '?').toUpperCase()}
                        </Text>
                      </View>
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
                <View style={styles.searchRow}>
                  <Ionicons name="search" size={16} color={colors.textMuted} />
                  <TextInput
                    style={styles.searchInput}
                    placeholder="Search by username"
                    placeholderTextColor={colors.textMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    value={search}
                    onChangeText={setSearch}
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
                      <View style={styles.avatar}>
                        <Text style={styles.avatarText}>
                          {(h.display_name?.[0] ?? h.username[0] ?? '?').toUpperCase()}
                        </Text>
                      </View>
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
    return <View style={{ flex: 1, backgroundColor: colors.background }}>{content}</View>;
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
    avatar: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: colors.primary + '22',
      borderColor: colors.primary + '55',
      borderWidth: 1,
      alignItems: 'center',
      justifyContent: 'center',
    },
    avatarText: { fontSize: 14, fontWeight: '800', color: colors.primary },
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
    btnPrimaryText: { fontSize: 12, fontWeight: '800', color: '#000' },
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
