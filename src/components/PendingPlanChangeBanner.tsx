/**
 * Pending Plan Change Banner — discoverability surface for scheduled
 * settings changes (Goal / Workout / Meal Plan) that haven't taken
 * effect yet.
 *
 * Mid-week edits to those surfaces defer to the next plan-week start
 * (see src/utils/planEffectiveDate.ts). Until that date arrives the
 * change is a *request* the user can still cancel cleanly. Previously
 * the only place to see / cancel these requests was Progress → Trends
 * → Plan Change Requests & History, which testers weren't finding.
 *
 * This component renders a compact card at the top of the workout
 * Plan tab. State is owned by the parent (so the banner doesn't need
 * its own AsyncStorage round-trip and stays in sync with the full
 * history view on Progress).
 */
import { useMemo } from 'react';
import { View, Text, TouchableOpacity, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getTheme, radius } from '../constants/theme';
import type { AppThemeName, PlanChangeEntry, UserProfile } from '../types';
import {
  planChangeIsScheduled,
  planScopeLabel,
  planScopeMatches,
  restorePlanScope,
} from '../utils/pendingPlanChange';
import { formatPlanStartDateShort } from '../utils/planEffectiveDate';

interface Props {
  themeName?: AppThemeName;
  planChanges: PlanChangeEntry[];
  userProfile: UserProfile;
  /** When provided, scheduled changes that still match the current
   *  profile show a "Cancel" pill that restores the previous settings
   *  via this callback. Without it, only "Remove" (history-only delete)
   *  is offered. */
  onCancelScheduledPlanChange?: (restoredProfile: UserProfile) => Promise<void> | void;
  /** Async delete of the local row + caller-side state update.
   *  Returns once the row is gone from storage + parent state. */
  onDeleteChange: (changeId: string) => Promise<void> | void;
}

export default function PendingPlanChangeBanner({
  themeName, planChanges, userProfile, onCancelScheduledPlanChange, onDeleteChange,
}: Props) {
  const tc = getTheme(themeName).colors;

  // Filter + cap. Most users will have 0–1 pending; the cap is defensive
  // against a power user who scheduled goal + workout + mealplan all in
  // one session.
  const pending = useMemo(
    () => planChanges.filter(c => planChangeIsScheduled(c)).slice(0, 3),
    [planChanges],
  );

  if (pending.length === 0) return null;

  const handlePress = (change: PlanChangeEntry) => {
    if (!change.id) return;
    const canCancel = !!change.previousProfile
      && !!change.nextProfile
      && !!onCancelScheduledPlanChange
      && planScopeMatches(userProfile, change.nextProfile, change.scope);

    if (canCancel) {
      Alert.alert(
        'Cancel this request?',
        'This restores your previous settings for the upcoming plan and removes the scheduled request. Your current week stays unchanged.',
        [
          { text: 'Keep', style: 'cancel' },
          {
            text: 'Cancel Request',
            style: 'destructive',
            onPress: async () => {
              try {
                const restored = restorePlanScope(userProfile, change.previousProfile!, change.scope);
                await onCancelScheduledPlanChange!(restored);
                if (change.id) await onDeleteChange(change.id);
              } catch (e: any) {
                Alert.alert('Could not cancel', e?.message ?? 'Try again in a moment.');
              }
            },
          },
        ],
      );
      return;
    }

    // Newer profile edit superseded this request — safer to just drop
    // the row from history than to clobber the newer change.
    Alert.alert(
      'Remove this request?',
      'A more recent settings change has already replaced this one. Removing just clears the row from your history; your current settings stay as they are.',
      [
        { text: 'Keep', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            try {
              if (change.id) await onDeleteChange(change.id);
            } catch (e: any) {
              Alert.alert('Could not remove', e?.message ?? 'Try again in a moment.');
            }
          },
        },
      ],
    );
  };

  return (
    <View
      testID="pending-plan-change-banner"
      style={{
        backgroundColor: tc.surface,
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: tc.primary + '55',
        padding: 14,
        marginBottom: 12,
        gap: pending.length > 1 ? 10 : 6,
      }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View style={{
          width: 26, height: 26, borderRadius: 13,
          backgroundColor: tc.primary + '22',
          alignItems: 'center', justifyContent: 'center',
        }}>
          <Ionicons name="time-outline" size={15} color={tc.primary} />
        </View>
        <Text style={{ fontSize: 11, fontWeight: '800', letterSpacing: 0.5, color: tc.primary }}>
          {pending.length === 1 ? 'SCHEDULED FOR NEXT WEEK' : `${pending.length} CHANGES SCHEDULED`}
        </Text>
      </View>

      {pending.map((change, i) => {
        const canCancel = !!change.previousProfile
          && !!change.nextProfile
          && !!onCancelScheduledPlanChange
          && planScopeMatches(userProfile, change.nextProfile, change.scope);
        return (
          <View
            key={change.id ?? i}
            testID={`pending-plan-change-row-${i}`}
            style={{
              flexDirection: 'row', alignItems: 'flex-start', gap: 10,
              paddingTop: i > 0 ? 10 : 4,
              borderTopWidth: i > 0 ? 1 : 0,
              borderTopColor: tc.border,
            }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ fontSize: 13, fontWeight: '800', color: tc.textPrimary }} numberOfLines={1}>
                {planScopeLabel(change.scope)}
              </Text>
              <Text style={{ fontSize: 12, color: tc.textSecondary, lineHeight: 17, marginTop: 2 }} numberOfLines={3}>
                {change.summary}
              </Text>
              {change.effectiveDate && (
                <Text style={{ fontSize: 11, fontWeight: '700', color: tc.primary, marginTop: 4 }}>
                  Starts {formatPlanStartDateShort(change.effectiveDate)}
                </Text>
              )}
            </View>
            <TouchableOpacity
              testID={`pending-plan-change-action-${i}`}
              onPress={() => handlePress(change)}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              activeOpacity={0.75}
              style={{
                paddingHorizontal: 10, paddingVertical: 6,
                borderRadius: 999,
                borderWidth: 1,
                borderColor: canCancel ? tc.primary + '66' : tc.border,
                backgroundColor: canCancel ? tc.primary + '14' : tc.surfaceRaised,
              }}>
              <Text style={{
                fontSize: 11, fontWeight: '800',
                color: canCancel ? tc.primary : tc.textMuted,
                letterSpacing: 0.3,
              }}>
                {canCancel ? 'Cancel' : 'Remove'}
              </Text>
            </TouchableOpacity>
          </View>
        );
      })}
    </View>
  );
}
