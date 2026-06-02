import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getContrastingTextColor, getTheme, radius, toggleOffTrack } from '../constants/theme';
import type { AppThemeName } from '../types';
import {
  acceptTrainerRelationship,
  createTrainerClientNote,
  getTrainerDashboard,
  getTrainerProfile,
  listTrainerRelationships,
  requestMyTrainer,
  requestTrainerClient,
  revokeTrainerRelationship,
  updateTrainerProfile,
  type TrainerClientSummary,
  type TrainerDashboard,
  type TrainerPermissionFlags,
  type TrainerProfile,
  type TrainerRelationship,
  type TrainerRelationshipsResponse,
} from '../services/api';

interface Props {
  authToken: string;
  themeName?: AppThemeName;
}

const DEFAULT_PERMS: TrainerPermissionFlags = {
  share_workouts: true,
  share_nutrition: false,
  share_body_metrics: false,
  share_recovery: true,
};

function normalizeUsername(value: string): string {
  return value.trim().replace(/^@+/, '').toLowerCase();
}

function displayName(user: { display_name?: string | null; username: string }): string {
  return user.display_name || user.username;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return 'None';
  const t = new Date(value).getTime();
  if (!Number.isFinite(t)) return value;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function flagLabel(flag: string): string {
  if (flag === 'missed_workouts') return 'Missed workouts';
  if (flag === 'low_nutrition_logging') return 'Low food logging';
  if (flag === 'recovery_attention') return 'Recovery';
  if (flag === 'no_training_logged') return 'No workouts';
  return flag.replace(/_/g, ' ');
}

export default function TrainerPortal({ authToken, themeName }: Props) {
  const tc = getTheme(themeName).colors;
  const styles = useMemo(() => createStyles(tc), [tc]);
  const [profile, setProfile] = useState<TrainerProfile | null>(null);
  const [relationships, setRelationships] = useState<TrainerRelationshipsResponse>({ as_trainer: [], as_client: [] });
  const [dashboard, setDashboard] = useState<TrainerDashboard | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [profileDraft, setProfileDraft] = useState({ display_name: '', business_name: '', bio: '' });
  const [clientUsername, setClientUsername] = useState('');
  const [trainerUsername, setTrainerUsername] = useState('');
  const [clientPerms, setClientPerms] = useState<TrainerPermissionFlags>(DEFAULT_PERMS);
  const [trainerPerms, setTrainerPerms] = useState<TrainerPermissionFlags>(DEFAULT_PERMS);
  const [expandedClientId, setExpandedClientId] = useState<number | null>(null);
  const [noteDraft, setNoteDraft] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [prof, rels, dash] = await Promise.allSettled([
        getTrainerProfile(authToken),
        listTrainerRelationships(authToken),
        getTrainerDashboard(authToken, 7),
      ]);
      if (prof.status === 'fulfilled') {
        setProfile(prof.value);
        setProfileDraft({
          display_name: prof.value?.display_name ?? '',
          business_name: prof.value?.business_name ?? '',
          bio: prof.value?.bio ?? '',
        });
      }
      if (rels.status === 'fulfilled') setRelationships(rels.value);
      if (dash.status === 'fulfilled') setDashboard(dash.value);
    } finally {
      setLoading(false);
    }
  }, [authToken]);

  useEffect(() => {
    refresh().catch(() => null);
  }, [refresh]);

  const pending = [
    ...relationships.as_trainer.filter(r => r.status === 'pending'),
    ...relationships.as_client.filter(r => r.status === 'pending'),
  ];
  const activeTrainer = relationships.as_client.find(r => r.status === 'active');

  const saveProfile = async () => {
    setBusy('profile');
    try {
      const next = await updateTrainerProfile(authToken, {
        display_name: profileDraft.display_name || null,
        business_name: profileDraft.business_name || null,
        bio: profileDraft.bio || null,
        is_accepting_clients: true,
      });
      setProfile(next);
      await refresh();
    } catch (e: any) {
      Alert.alert('Could not save trainer profile', e?.message ?? 'Try again.');
    } finally {
      setBusy(null);
    }
  };

  const sendClientInvite = async () => {
    const username = normalizeUsername(clientUsername);
    if (!username) return;
    setBusy('clientInvite');
    try {
      await requestTrainerClient(authToken, { username, ...clientPerms });
      setClientUsername('');
      await refresh();
    } catch (e: any) {
      Alert.alert('Could not invite client', e?.message ?? 'Try again.');
    } finally {
      setBusy(null);
    }
  };

  const sendTrainerInvite = async () => {
    const username = normalizeUsername(trainerUsername);
    if (!username) return;
    setBusy('trainerInvite');
    try {
      await requestMyTrainer(authToken, { username, ...trainerPerms });
      setTrainerUsername('');
      await refresh();
    } catch (e: any) {
      Alert.alert('Could not add trainer', e?.message ?? 'Try again.');
    } finally {
      setBusy(null);
    }
  };

  const acceptRelationship = async (rel: TrainerRelationship) => {
    setBusy(`accept-${rel.id}`);
    try {
      await acceptTrainerRelationship(authToken, rel.id, {
        share_workouts: rel.share_workouts,
        share_nutrition: rel.share_nutrition,
        share_body_metrics: rel.share_body_metrics,
        share_recovery: rel.share_recovery,
      });
      await refresh();
    } catch (e: any) {
      Alert.alert('Could not accept', e?.message ?? 'Try again.');
    } finally {
      setBusy(null);
    }
  };

  const revokeRelationship = async (rel: TrainerRelationship) => {
    setBusy(`revoke-${rel.id}`);
    try {
      await revokeTrainerRelationship(authToken, rel.id);
      await refresh();
    } catch (e: any) {
      Alert.alert('Could not update connection', e?.message ?? 'Try again.');
    } finally {
      setBusy(null);
    }
  };

  const saveNote = async (client: TrainerClientSummary) => {
    const body = noteDraft.trim();
    if (!body) return;
    setBusy(`note-${client.client.user_id}`);
    try {
      await createTrainerClientNote(authToken, client.client.user_id, { body });
      setNoteDraft('');
      setExpandedClientId(null);
      await refresh();
    } catch (e: any) {
      Alert.alert('Could not save note', e?.message ?? 'Try again.');
    } finally {
      setBusy(null);
    }
  };

  const renderPermissionToggles = (
    perms: TrainerPermissionFlags,
    setPerms: (next: TrainerPermissionFlags) => void,
  ) => (
    <View style={styles.permissionGrid}>
      {([
        ['share_workouts', 'Workouts'],
        ['share_recovery', 'Recovery'],
        ['share_nutrition', 'Nutrition'],
        ['share_body_metrics', 'Body'],
      ] as Array<[keyof TrainerPermissionFlags, string]>).map(([key, label]) => (
        <View key={key} style={styles.permissionRow}>
          <Text style={styles.permissionLabel}>{label}</Text>
          <Switch
            value={perms[key]}
            onValueChange={(value) => setPerms({ ...perms, [key]: value })}
            trackColor={{ false: toggleOffTrack(tc), true: tc.primary }}
          />
        </View>
      ))}
    </View>
  );

  const renderRelationship = (rel: TrainerRelationship) => {
    const other = rel.role === 'trainer' ? rel.client : rel.trainer;
    const incoming = rel.direction === 'incoming';
    return (
      <View key={rel.id} style={styles.pendingRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.rowTitle}>{displayName(other)}</Text>
          <Text style={styles.rowSub}>
            {rel.role === 'trainer' ? 'Client' : 'Trainer'} · {incoming ? 'Incoming' : 'Sent'} · {formatDate(rel.requested_at)}
          </Text>
        </View>
        {incoming ? (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={`Accept ${displayName(other)}`}
            disabled={busy === `accept-${rel.id}`}
            onPress={() => acceptRelationship(rel)}
            style={[styles.iconButton, { backgroundColor: tc.primary, borderColor: tc.primary }]}>
            {busy === `accept-${rel.id}`
              ? <ActivityIndicator size="small" color={getContrastingTextColor(tc.primary)} />
              : <Ionicons name="checkmark" size={18} color={getContrastingTextColor(tc.primary)} />}
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={`Cancel ${displayName(other)} request`}
            disabled={busy === `revoke-${rel.id}`}
            onPress={() => revokeRelationship(rel)}
            style={styles.iconButton}>
            <Ionicons name="close" size={18} color={tc.textSecondary} />
          </TouchableOpacity>
        )}
      </View>
    );
  };

  const renderClient = (client: TrainerClientSummary) => {
    const expanded = expandedClientId === client.client.user_id;
    return (
      <View key={client.relationship_id} style={styles.clientCard}>
        <View style={styles.clientHeader}>
          <View style={{ flex: 1 }}>
            <Text style={styles.clientName}>{displayName(client.client)}</Text>
            <Text style={styles.rowSub}>@{client.client.username}</Text>
          </View>
          <View style={styles.adherencePill}>
            <Text style={styles.adherenceText}>{client.workouts.adherence_pct}%</Text>
          </View>
        </View>

        {client.flags.length > 0 && (
          <View style={styles.flagRow}>
            {client.flags.map(flag => (
              <View key={flag} style={styles.flagPill}>
                <Text style={styles.flagText}>{flagLabel(flag)}</Text>
              </View>
            ))}
          </View>
        )}

        <View style={styles.metricGrid}>
          <Metric label="Done" value={String(client.workouts.completed)} />
          <Metric label="Planned" value={String(client.workouts.planned)} />
          <Metric label="Missed" value={String(client.workouts.missed)} />
          <Metric label="Last" value={formatDate(client.workouts.last_workout_date)} />
        </View>

        <View style={styles.signalBlock}>
          <SignalLine
            icon="restaurant-outline"
            text={client.nutrition.shared
              ? `${client.nutrition.days_logged ?? 0} logged · ${client.nutrition.avg_protein_g ?? '—'}g protein`
              : 'Nutrition hidden'}
          />
          <SignalLine
            icon="body-outline"
            text={client.body.shared
              ? `${client.body.latest_weight_lbs ?? '—'} lb · ${formatDate(client.body.latest_weight_date)}`
              : 'Body metrics hidden'}
          />
          <SignalLine
            icon="pulse-outline"
            text={client.recovery.shared
              ? `${client.recovery.pain_present ? 'Pain noted' : 'No pain note'}${client.recovery.soreness_body_part ? ` · ${client.recovery.soreness_body_part}` : ''}`
              : 'Recovery hidden'}
          />
        </View>

        {expanded && (
          <View style={styles.noteBox}>
            <TextInput
              value={noteDraft}
              onChangeText={setNoteDraft}
              placeholder="Private coach note"
              placeholderTextColor={tc.textMuted}
              multiline
              style={styles.noteInput}
            />
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={`Save note for ${displayName(client.client)}`}
              disabled={busy === `note-${client.client.user_id}` || !noteDraft.trim()}
              onPress={() => saveNote(client)}
              style={[styles.primaryButton, (!noteDraft.trim() || busy === `note-${client.client.user_id}`) && styles.disabledButton]}>
              {busy === `note-${client.client.user_id}`
                ? <ActivityIndicator size="small" color={getContrastingTextColor(tc.primary)} />
                : <Text style={styles.primaryButtonText}>Save Note</Text>}
            </TouchableOpacity>
          </View>
        )}

        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={`${expanded ? 'Close' : 'Add'} note for ${displayName(client.client)}`}
          onPress={() => {
            setExpandedClientId(expanded ? null : client.client.user_id);
            if (!expanded) setNoteDraft('');
          }}
          style={styles.secondaryButton}>
          <Ionicons name={expanded ? 'chevron-up' : 'create-outline'} size={16} color={tc.textSecondary} />
          <Text style={styles.secondaryButtonText}>
            {expanded ? 'Close' : `Notes ${client.notes_count ? `(${client.notes_count})` : ''}`}
          </Text>
        </TouchableOpacity>
      </View>
    );
  };

  const Metric = ({ label, value }: { label: string; value: string }) => (
    <View style={styles.metricCell}>
      <Text numberOfLines={1} adjustsFontSizeToFit style={styles.metricValue}>{value}</Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </View>
  );

  const SignalLine = ({ icon, text }: { icon: keyof typeof Ionicons.glyphMap; text: string }) => (
    <View style={styles.signalLine}>
      <Ionicons name={icon} size={15} color={tc.textMuted} />
      <Text style={styles.signalText}>{text}</Text>
    </View>
  );

  return (
    <View>
      <View style={styles.headerRow}>
        <Text style={styles.sectionLabel}>COACH</Text>
        {loading && <ActivityIndicator size="small" color={tc.primary} />}
      </View>

      <View style={styles.card}>
        <View style={styles.cardTitleRow}>
          <Ionicons name="briefcase-outline" size={18} color={tc.primary} />
          <Text style={styles.cardTitle}>Trainer Profile</Text>
        </View>
        <TextInput
          value={profileDraft.display_name}
          onChangeText={(display_name) => setProfileDraft(v => ({ ...v, display_name }))}
          placeholder="Display name"
          placeholderTextColor={tc.textMuted}
          style={styles.input}
        />
        <TextInput
          value={profileDraft.business_name}
          onChangeText={(business_name) => setProfileDraft(v => ({ ...v, business_name }))}
          placeholder="Business name"
          placeholderTextColor={tc.textMuted}
          style={styles.input}
        />
        <TextInput
          value={profileDraft.bio}
          onChangeText={(bio) => setProfileDraft(v => ({ ...v, bio }))}
          placeholder="Short bio"
          placeholderTextColor={tc.textMuted}
          multiline
          style={[styles.input, styles.bioInput]}
        />
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Save trainer profile"
          disabled={busy === 'profile'}
          onPress={saveProfile}
          style={styles.primaryButton}>
          {busy === 'profile'
            ? <ActivityIndicator size="small" color={getContrastingTextColor(tc.primary)} />
            : <Text style={styles.primaryButtonText}>{profile ? 'Save Profile' : 'Enable Trainer Mode'}</Text>}
        </TouchableOpacity>
      </View>

      <View style={styles.card}>
        <View style={styles.cardTitleRow}>
          <Ionicons name="person-add-outline" size={18} color={tc.primary} />
          <Text style={styles.cardTitle}>Invite Client</Text>
        </View>
        <TextInput
          value={clientUsername}
          onChangeText={setClientUsername}
          autoCapitalize="none"
          placeholder="client_username"
          placeholderTextColor={tc.textMuted}
          style={styles.input}
        />
        {renderPermissionToggles(clientPerms, setClientPerms)}
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Invite client"
          disabled={busy === 'clientInvite' || !normalizeUsername(clientUsername)}
          onPress={sendClientInvite}
          style={[styles.primaryButton, (!normalizeUsername(clientUsername) || busy === 'clientInvite') && styles.disabledButton]}>
          {busy === 'clientInvite'
            ? <ActivityIndicator size="small" color={getContrastingTextColor(tc.primary)} />
            : <Text style={styles.primaryButtonText}>Send Invite</Text>}
        </TouchableOpacity>
      </View>

      <View style={styles.card}>
        <View style={styles.cardTitleRow}>
          <Ionicons name="fitness-outline" size={18} color={tc.primary} />
          <Text style={styles.cardTitle}>My Trainer</Text>
        </View>
        {activeTrainer ? (
          <View style={styles.pendingRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle}>{displayName(activeTrainer.trainer)}</Text>
              <Text style={styles.rowSub}>Connected · {formatDate(activeTrainer.accepted_at)}</Text>
            </View>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="Remove trainer"
              onPress={() => revokeRelationship(activeTrainer)}
              style={styles.iconButton}>
              <Ionicons name="remove-circle-outline" size={18} color={tc.textSecondary} />
            </TouchableOpacity>
          </View>
        ) : (
          <>
            <TextInput
              value={trainerUsername}
              onChangeText={setTrainerUsername}
              autoCapitalize="none"
              placeholder="trainer_username"
              placeholderTextColor={tc.textMuted}
              style={styles.input}
            />
            {renderPermissionToggles(trainerPerms, setTrainerPerms)}
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="Add trainer"
              disabled={busy === 'trainerInvite' || !normalizeUsername(trainerUsername)}
              onPress={sendTrainerInvite}
              style={[styles.primaryButton, (!normalizeUsername(trainerUsername) || busy === 'trainerInvite') && styles.disabledButton]}>
              {busy === 'trainerInvite'
                ? <ActivityIndicator size="small" color={getContrastingTextColor(tc.primary)} />
                : <Text style={styles.primaryButtonText}>Add Trainer</Text>}
            </TouchableOpacity>
          </>
        )}
      </View>

      {pending.length > 0 && (
        <View style={styles.card}>
          <View style={styles.cardTitleRow}>
            <Ionicons name="time-outline" size={18} color={tc.primary} />
            <Text style={styles.cardTitle}>Pending</Text>
          </View>
          {pending.map(renderRelationship)}
        </View>
      )}

      <View style={styles.card}>
        <View style={styles.cardTitleRow}>
          <Ionicons name="speedometer-outline" size={18} color={tc.primary} />
          <Text style={styles.cardTitle}>Client Roster</Text>
        </View>
        {dashboard?.clients.length ? (
          dashboard.clients.map(renderClient)
        ) : (
          <View style={styles.emptyState}>
            <Ionicons name="people-outline" size={24} color={tc.textMuted} />
            <Text style={styles.emptyText}>No active clients yet.</Text>
          </View>
        )}
      </View>
    </View>
  );
}

function createStyles(tc: ReturnType<typeof getTheme>['colors']) {
  return StyleSheet.create({
    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginTop: 24,
      marginBottom: 8,
      paddingHorizontal: 4,
    },
    sectionLabel: {
      fontSize: 11,
      fontWeight: '700',
      letterSpacing: 1,
      color: tc.textMuted,
    },
    card: {
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: tc.border,
      backgroundColor: tc.surface,
      padding: 14,
      marginBottom: 14,
    },
    cardTitleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginBottom: 12,
    },
    cardTitle: {
      fontSize: 15,
      fontWeight: '800',
      color: tc.textPrimary,
    },
    input: {
      minHeight: 46,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: tc.border,
      backgroundColor: tc.surfaceRaised,
      color: tc.textPrimary,
      paddingHorizontal: 12,
      paddingVertical: 10,
      marginBottom: 10,
      fontSize: 14,
    },
    bioInput: {
      minHeight: 78,
      textAlignVertical: 'top',
    },
    primaryButton: {
      minHeight: 46,
      borderRadius: radius.md,
      backgroundColor: tc.primary,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 14,
      paddingVertical: 12,
      flexDirection: 'row',
      gap: 8,
    },
    primaryButtonText: {
      color: getContrastingTextColor(tc.primary),
      fontSize: 13,
      fontWeight: '900',
    },
    disabledButton: {
      opacity: 0.55,
    },
    secondaryButton: {
      minHeight: 42,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: tc.border,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 12,
      flexDirection: 'row',
      gap: 6,
      marginTop: 12,
    },
    secondaryButtonText: {
      color: tc.textSecondary,
      fontSize: 12,
      fontWeight: '800',
    },
    permissionGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
      marginBottom: 12,
    },
    permissionRow: {
      width: '48%',
      minHeight: 44,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: tc.border,
      backgroundColor: tc.surfaceRaised,
      paddingHorizontal: 10,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
    },
    permissionLabel: {
      color: tc.textSecondary,
      fontSize: 12,
      fontWeight: '800',
    },
    pendingRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
      paddingVertical: 10,
      borderTopWidth: 1,
      borderTopColor: tc.border,
    },
    rowTitle: {
      color: tc.textPrimary,
      fontSize: 14,
      fontWeight: '800',
    },
    rowSub: {
      color: tc.textMuted,
      fontSize: 11,
      marginTop: 2,
      lineHeight: 15,
    },
    iconButton: {
      width: 42,
      height: 42,
      borderRadius: 21,
      borderWidth: 1,
      borderColor: tc.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    clientCard: {
      borderTopWidth: 1,
      borderTopColor: tc.border,
      paddingTop: 14,
      marginTop: 2,
      marginBottom: 12,
    },
    clientHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      marginBottom: 10,
    },
    clientName: {
      color: tc.textPrimary,
      fontSize: 16,
      fontWeight: '900',
    },
    adherencePill: {
      minWidth: 54,
      borderRadius: radius.full,
      backgroundColor: tc.primary,
      paddingHorizontal: 10,
      paddingVertical: 7,
      alignItems: 'center',
    },
    adherenceText: {
      color: getContrastingTextColor(tc.primary),
      fontSize: 13,
      fontWeight: '900',
    },
    flagRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 6,
      marginBottom: 10,
    },
    flagPill: {
      borderRadius: radius.full,
      borderWidth: 1,
      borderColor: tc.warning,
      paddingHorizontal: 8,
      paddingVertical: 4,
    },
    flagText: {
      color: tc.warning,
      fontSize: 10,
      fontWeight: '900',
      textTransform: 'uppercase',
      letterSpacing: 0.4,
    },
    metricGrid: {
      flexDirection: 'row',
      gap: 8,
      marginBottom: 12,
    },
    metricCell: {
      flex: 1,
      minHeight: 58,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: tc.border,
      backgroundColor: tc.surfaceRaised,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 5,
    },
    metricValue: {
      color: tc.textPrimary,
      fontSize: 14,
      fontWeight: '900',
      maxWidth: '100%',
    },
    metricLabel: {
      color: tc.textMuted,
      fontSize: 10,
      fontWeight: '800',
      marginTop: 2,
      textTransform: 'uppercase',
    },
    signalBlock: {
      gap: 7,
    },
    signalLine: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
    },
    signalText: {
      color: tc.textSecondary,
      fontSize: 12,
      flex: 1,
    },
    noteBox: {
      marginTop: 12,
      gap: 10,
    },
    noteInput: {
      minHeight: 78,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: tc.border,
      backgroundColor: tc.surfaceRaised,
      color: tc.textPrimary,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 13,
      textAlignVertical: 'top',
    },
    emptyState: {
      minHeight: 92,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      borderTopWidth: 1,
      borderTopColor: tc.border,
      paddingTop: 16,
    },
    emptyText: {
      color: tc.textMuted,
      fontSize: 12,
      fontWeight: '700',
    },
  });
}
