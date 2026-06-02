import React, { memo, useMemo } from 'react';
import { Pressable, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import type { UserProfile } from '../types';
import SocialAvatar from './SocialAvatar';
import { getContrastingTextColor } from '../constants/theme';
import { effectiveAge } from '../utils/age';
import { tierOf } from '../utils/subscription';
import { formatWeight, type WeightUnit } from '../utils/units';

interface HomeYouTabProps {
  userProfile: UserProfile;
  username?: string | null;
  weightUnit: WeightUnit;
  themeColors: any;
  styles: any;
  onOpenSettings: () => void;
  onOpenProfilePhotoActions: () => void;
  onEditBody: () => void;
  onViewAccount: () => void;
  onOpenGear: () => void;
  onOpenImport?: () => void;
  onDismissPendingImport?: (source: string) => void;
}

function cleanText(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && text.toLowerCase() !== 'undefined' && text.toLowerCase() !== 'null' ? text : '';
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

const IMPORT_SOURCE_LABELS: Record<string, string> = {
  myfitnesspal: 'MyFitnessPal',
  strong: 'Strong',
  strava: 'Strava',
  apple_health: 'Apple Health',
};

function importSourceLabel(source: string): string {
  return IMPORT_SOURCE_LABELS[source] ?? source.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function HomeYouTabInner({
  userProfile,
  username,
  weightUnit,
  themeColors,
  styles,
  onOpenSettings,
  onOpenProfilePhotoActions,
  onEditBody,
  onViewAccount,
  onOpenGear,
  onOpenImport,
  onDismissPendingImport,
}: HomeYouTabProps) {
  const isProTier = tierOf(userProfile) === 'pro';
  const profile = useMemo(() => {
    const stats = userProfile.physicalStats as any;
    const details = (userProfile.goalDetails ?? {}) as any;
    const latestWeightFromLog = (() => {
      const entries = userProfile.weightEntries ?? [];
      if (!Array.isArray(entries) || entries.length === 0) return null;
      const sorted = [...entries].sort((a, b) =>
        String(b.logged_at ?? b.date ?? '').localeCompare(String(a.logged_at ?? a.date ?? '')),
      );
      const latest = numberValue(sorted[0]?.weight_lbs);
      return latest != null && latest > 0 ? latest : null;
    })();
    const weightLbs = latestWeightFromLog ?? numberValue(stats?.weightLbs ?? stats?.weight_lbs);
    const heightFeet = numberValue(stats?.heightFeet ?? stats?.height_feet);
    const heightInches = numberValue(stats?.heightInches ?? stats?.height_inches);
    const birthdate = cleanText(stats?.birthdate ?? stats?.birth_date);
    const age = effectiveAge({ birthdate: birthdate || null, age: numberValue(stats?.age) });
    const targetWeightLbs = numberValue(details?.targetWeightLbs ?? details?.target_weight_lbs);
    const displayName = cleanText(userProfile.firstName) || cleanText(username) || 'Your Profile';
    const currentWeightLabel = weightLbs != null && weightLbs > 0
      ? formatWeight(weightLbs, weightUnit, { precision: weightUnit === 'kg' ? 1 : 0 })
      : null;
    const targetWeightLabel = targetWeightLbs != null && targetWeightLbs > 0
      ? formatWeight(targetWeightLbs, weightUnit, { precision: weightUnit === 'kg' ? 1 : 0 })
      : null;
    const heightLabel = heightFeet != null && heightInches != null ? `${Math.round(heightFeet)}'${Math.round(heightInches)}"` : null;
    const heroSummary = [
      age != null && age > 0 ? `age ${Math.round(age)}` : null,
    ].filter((part): part is string => !!part);
    const heroStats = [
      currentWeightLabel ? { key: 'current', label: 'Current', value: currentWeightLabel } : null,
      targetWeightLabel ? { key: 'target', label: 'Target', value: targetWeightLabel } : null,
      heightLabel ? { key: 'height', label: 'Height', value: heightLabel } : null,
    ].filter((part): part is { key: string; label: string; value: string } => !!part).slice(0, 3);

    return { displayName, heroSummary, heroStats };
  }, [userProfile, username, weightUnit]);
  const pendingImport = useMemo(() => (
    (userProfile.pendingImports ?? []).find(entry => entry.source && !entry.completed_at && !entry.dismissed_at) ?? null
  ), [userProfile.pendingImports]);

  return (
    <ScrollView
      testID="you-tab-screen"
      style={styles.profileScrollView}
      contentContainerStyle={styles.scrollContent}>
      <View style={[styles.profileHero, { backgroundColor: themeColors.surface, borderColor: themeColors.border }]}>
        <View style={styles.profileHeroTop}>
          <Text style={[styles.profileHeroEyebrow, { color: themeColors.textMuted }]}>Your dashboard</Text>
          <Pressable
            onPress={onOpenSettings}
            testID="profile-settings-open"
            accessibilityLabel="profile-settings-open"
            accessibilityRole="button"
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            style={({ pressed }) => [
              styles.profileHeroSettingsBtn,
              { backgroundColor: themeColors.surfaceRaised, borderColor: themeColors.border },
              pressed && { opacity: 0.72 },
            ]}
          >
            <Ionicons name="settings-outline" size={19} color={themeColors.textPrimary} />
          </Pressable>
        </View>
        <View style={styles.profileHeroBody}>
          <TouchableOpacity
            onPress={onOpenProfilePhotoActions}
            activeOpacity={0.78}
            accessibilityLabel="Update profile photo"
            testID="profile-avatar-button">
            <SocialAvatar
              avatarUrl={userProfile.avatarUrl}
              name={profile.displayName}
              username={username ?? undefined}
              size={96}
              backgroundColor={themeColors.primary + '12'}
              borderColor={themeColors.border}
              textColor={themeColors.primary}
              textSize={34}
              style={styles.profileAvatar}>
              <View style={[styles.profileAvatarEdit, { backgroundColor: themeColors.primary, borderColor: themeColors.surface }]}>
                <Ionicons name="camera" size={12} color={getContrastingTextColor(themeColors.primary)} />
              </View>
            </SocialAvatar>
          </TouchableOpacity>
          <View style={styles.profileHeroCopy}>
            <View style={styles.profileHeroNameRow}>
              <Text style={[styles.profileHeroName, { color: themeColors.textPrimary }]} numberOfLines={1}>
                {profile.displayName}
              </Text>
              {isProTier && (
                <View
                  testID="profile-pro-badge"
                  accessibilityLabel="Thallo Pro"
                  style={[
                    styles.profileHeroProBadge,
                    { backgroundColor: themeColors.primary, borderColor: themeColors.primary },
                  ]}>
                  <Ionicons name="sparkles-outline" size={11} color={getContrastingTextColor(themeColors.primary)} />
                  <Text style={[styles.profileHeroProBadgeText, { color: getContrastingTextColor(themeColors.primary) }]}>
                    PRO
                  </Text>
                </View>
              )}
            </View>
            <Text style={[styles.profileHeroMeta, { color: themeColors.textSecondary }]} numberOfLines={2}>
              {profile.heroSummary.length > 0 ? profile.heroSummary.join('  ·  ') : 'Personal dashboard'}
            </Text>
            {profile.heroStats.length > 0 ? (
              <View style={styles.profileHeroStatRow}>
                {profile.heroStats.map(stat => (
                  <View key={stat.key} style={[styles.profileHeroStatPill, { backgroundColor: themeColors.surfaceRaised, borderColor: themeColors.border }]}>
                    <Text style={[styles.profileHeroStatLabel, { color: themeColors.textMuted }]} numberOfLines={1}>{stat.label}</Text>
                    <Text style={[styles.profileHeroStatValue, { color: themeColors.textPrimary }]} numberOfLines={1}>{stat.value}</Text>
                  </View>
                ))}
              </View>
            ) : (
              <TouchableOpacity
                onPress={onEditBody}
                activeOpacity={0.8}
                style={[styles.profileHeroCompleteButton, { backgroundColor: themeColors.surfaceRaised, borderColor: themeColors.border }]}
              >
                <Ionicons name="create-outline" size={13} color={themeColors.textPrimary} />
                <Text style={[styles.profileHeroCompleteText, { color: themeColors.textPrimary }]}>
                  Complete profile
                </Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      </View>

      {pendingImport && (
        <View style={[styles.profileMenuList, styles.profileMenuListFloating, { backgroundColor: 'transparent', borderColor: 'transparent', marginTop: 12 }]}>
          <View style={[styles.profileMenuItem, styles.profileFloatingMenuItem, { backgroundColor: themeColors.surface, borderColor: themeColors.border, alignItems: 'flex-start' }]}>
            <View style={[styles.profileRowIcon, { backgroundColor: themeColors.primary + '22', marginTop: 2 }]}>
              <Ionicons name="download-outline" size={18} color={themeColors.primary} />
            </View>
            <View style={{ flex: 1, marginLeft: 10 }}>
              <Text style={[styles.profileMenuLabel, { color: themeColors.textPrimary }]}>
                Finish {importSourceLabel(pendingImport.source)} import
              </Text>
              <Text style={{ fontSize: 11, color: themeColors.textMuted, marginTop: 2 }}>
                Bring the exported history into Thallo when the file or connection is ready.
              </Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 }}>
                <TouchableOpacity
                  onPress={onOpenImport ?? onOpenSettings}
                  activeOpacity={0.8}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 6,
                    paddingHorizontal: 11,
                    paddingVertical: 7,
                    borderRadius: 8,
                    backgroundColor: themeColors.primary,
                  }}>
                  <Ionicons name="arrow-forward" size={13} color={getContrastingTextColor(themeColors.primary)} />
                  <Text style={{ fontSize: 12, fontWeight: '800', color: getContrastingTextColor(themeColors.primary) }}>Continue</Text>
                </TouchableOpacity>
                {onDismissPendingImport && (
                  <TouchableOpacity
                    onPress={() => onDismissPendingImport(pendingImport.source)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <Text style={{ fontSize: 12, fontWeight: '700', color: themeColors.textMuted }}>Dismiss</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
          </View>
        </View>
      )}

      <Text style={[styles.profileSectionLabel, { color: themeColors.textMuted, marginTop: 4 }]}>MY STUFF</Text>
      <View style={[styles.profileMenuList, styles.profileMenuListFloating, { backgroundColor: 'transparent', borderColor: 'transparent' }]}>
        <Pressable
          style={({ pressed }) => [styles.profileMenuItem, styles.profileFloatingMenuItem, { backgroundColor: themeColors.surface, borderColor: themeColors.border }, pressed && { opacity: 0.72 }]}
          onPress={onOpenSettings}
          testID="profile-settings-row"
          accessibilityLabel="profile-settings-row"
          accessibilityRole="button">
          <View style={[styles.profileRowIcon, { backgroundColor: themeColors.primary + '22' }]}>
            <Ionicons name="notifications-outline" size={18} color={themeColors.primary} />
          </View>
          <View style={{ flex: 1, marginLeft: 10 }}>
            <Text style={[styles.profileMenuLabel, { color: themeColors.textPrimary }]}>Settings</Text>
            <Text style={{ fontSize: 11, color: themeColors.textMuted }}>Themes, notifications, units, plan pause, and permissions</Text>
          </View>
          <Text style={[styles.profileMenuChevron, { color: themeColors.textMuted }]}>›</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.profileMenuItem, styles.profileFloatingMenuItem, { backgroundColor: themeColors.surface, borderColor: themeColors.border }, pressed && { opacity: 0.72 }]}
          onPress={onViewAccount}
          testID="profile-account-open"
          accessibilityLabel="profile-account-open"
          accessibilityRole="button">
          <View style={[styles.profileRowIcon, { backgroundColor: themeColors.primary + '22' }]}>
            <Ionicons name="id-card-outline" size={18} color={themeColors.primary} />
          </View>
          <View style={{ flex: 1, marginLeft: 10 }}>
            <Text style={[styles.profileMenuLabel, { color: themeColors.textPrimary }]}>Account</Text>
            <Text style={{ fontSize: 11, color: themeColors.textMuted }}>Name, email, password recovery, legal, and support</Text>
          </View>
          <Text style={[styles.profileMenuChevron, { color: themeColors.textMuted }]}>›</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.profileMenuItem, styles.profileFloatingMenuItem, { backgroundColor: themeColors.surface, borderColor: themeColors.border }, pressed && { opacity: 0.72 }]}
          onPress={onOpenGear}
          testID="profile-gear-open"
          accessibilityLabel="profile-gear-open"
          accessibilityRole="button">
          <View style={[styles.profileRowIcon, { backgroundColor: themeColors.primary + '22' }]}>
            <Ionicons name="walk-outline" size={18} color={themeColors.primary} />
          </View>
          <View style={{ flex: 1, marginLeft: 10 }}>
            <Text style={[styles.profileMenuLabel, { color: themeColors.textPrimary }]}>Gear Tracker</Text>
            <Text style={{ fontSize: 11, color: themeColors.textMuted }}>Track mileage on shoes, bikes & equipment</Text>
          </View>
          <Text style={[styles.profileMenuChevron, { color: themeColors.textMuted }]}>›</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

export default memo(HomeYouTabInner);
