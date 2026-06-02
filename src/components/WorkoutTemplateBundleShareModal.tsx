/**
 * Workout Template Bundle Share — pick templates, mint a bundle code,
 * share via the system Share sheet.
 *
 * Sits next to WorkoutTemplateImportModal (the receiver side). The bundle
 * is server-backed: creating it auto-mints per-template share codes for
 * any included templates that don't have one yet, then mints an 8-char
 * bundle code (vs the 6-char per-template code).
 *
 * Selection state is intentionally local to the modal — closing without
 * sharing discards it. The created bundle code stays visible in a final
 * "share" panel so a tap on a chip → "Copy" still works after the system
 * sheet dismisses.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  View, Text, Modal, TouchableOpacity, ScrollView, ActivityIndicator,
  Alert, TextInput, Share,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getContrastingTextColor, getTheme, radius } from '../constants/theme';
import { AppThemeName, SavedWorkoutTemplate } from '../types';
import {
  createWorkoutTemplateBundle,
  type SharedWorkoutTemplateBundle,
} from '../services/api';

const MAX_BUNDLE_ITEMS = 25;

interface Props {
  visible: boolean;
  themeName?: AppThemeName;
  authToken: string | null;
  templates: SavedWorkoutTemplate[];
  /** Pre-selected template ids — used when entry is via "share these
   *  three workouts" from a multi-select on the library screen. Empty
   *  by default; the user picks from the list. */
  initialSelectedIds?: string[];
  onClose: () => void;
}

export default function WorkoutTemplateBundleShareModal({
  visible, themeName, authToken, templates, initialSelectedIds, onClose,
}: Props) {
  const tc = getTheme(themeName).colors;
  const onPrimary = getContrastingTextColor(tc.primary);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<SharedWorkoutTemplateBundle | null>(null);

  useEffect(() => {
    if (!visible) {
      // Reset only on close — opening with the same templates list
      // shouldn't blow away an in-progress selection from a prior tap.
      setSelected(new Set());
      setName('');
      setCreating(false);
      setCreated(null);
      return;
    }
    if (initialSelectedIds && initialSelectedIds.length > 0) {
      setSelected(new Set(initialSelectedIds));
    }
  }, [visible, initialSelectedIds]);

  const orderedTemplates = useMemo(() => {
    // Stable order — same as the library card so selection mapping is
    // predictable. We don't filter here; templates without exercises
    // are still shareable (they round-trip cleanly).
    return templates;
  }, [templates]);

  const selectedCount = selected.size;
  const overLimit = selectedCount > MAX_BUNDLE_ITEMS;
  const canCreate = selectedCount >= 2 && !overLimit && !!authToken && !creating;

  const toggle = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const onCreate = async () => {
    if (!authToken || selectedCount === 0) return;
    setCreating(true);
    try {
      const ids = orderedTemplates.filter(t => selected.has(t.id)).map(t => t.id);
      const bundle = await createWorkoutTemplateBundle(authToken, {
        name: name.trim(),
        templateIds: ids,
      });
      setCreated(bundle);
    } catch (e: any) {
      Alert.alert('Couldn’t create bundle', e?.message ?? 'Try again in a moment.');
    } finally {
      setCreating(false);
    }
  };

  const onShare = async () => {
    if (!created) return;
    const count = created.items.filter(i => i.available).length;
    const label = created.name?.trim() || `${count} Thallo workouts`;
    try {
      await Share.share({
        message: `Try my Thallo workout bundle "${label}" — bundle code: ${created.bundleCode}\n\nOpen in app: thallo://template-bundle/${created.bundleCode}`,
      });
    } catch {
      // System share dismissal — silent.
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={{
        flex: 1, backgroundColor: '#0009',
        justifyContent: 'center', padding: 20,
      }}>
        <View style={{
          backgroundColor: tc.background, borderRadius: radius.lg,
          borderWidth: 1, borderColor: tc.border, padding: 20, gap: 14,
          maxHeight: '88%',
        }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text style={{ fontSize: 17, fontWeight: '800', color: tc.textPrimary }}>
              {created ? 'Bundle ready' : 'Share multiple templates'}
            </Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close" size={22} color={tc.textMuted} />
            </TouchableOpacity>
          </View>

          {/* ── Pre-create state: pick templates + name ────────────── */}
          {!created && (
            <>
              <Text style={{ fontSize: 13, color: tc.textMuted, lineHeight: 18 }}>
                Pick the templates to bundle. Selected templates without a
                share code will get one automatically. Up to {MAX_BUNDLE_ITEMS}.
              </Text>

              <TextInput
                testID="bundle-share-name"
                value={name}
                onChangeText={setName}
                autoCapitalize="sentences"
                autoCorrect={false}
                spellCheck={false}
                placeholder="Bundle name (optional)"
                placeholderTextColor={tc.textMuted + '88'}
                maxLength={120}
                style={{
                  fontSize: 15, color: tc.textPrimary,
                  borderWidth: 1, borderColor: tc.border, borderRadius: radius.md,
                  backgroundColor: tc.surface, paddingVertical: 10, paddingHorizontal: 14,
                }}
              />

              <ScrollView
                style={{ maxHeight: 320 }}
                contentContainerStyle={{ gap: 8 }}
                showsVerticalScrollIndicator={false}>
                {orderedTemplates.length === 0 ? (
                  <Text style={{ fontSize: 13, color: tc.textMuted, textAlign: 'center', paddingVertical: 20 }}>
                    Save a few templates first, then come back here.
                  </Text>
                ) : (
                  orderedTemplates.map(t => {
                    const isSelected = selected.has(t.id);
                    const exerciseCount = (t.workout?.exercises ?? []).length;
                    return (
                      <TouchableOpacity
                        key={t.id}
                        testID={`bundle-share-row-${t.id}`}
                        onPress={() => toggle(t.id)}
                        activeOpacity={0.7}
                        style={{
                          flexDirection: 'row', alignItems: 'center', gap: 10,
                          padding: 12, borderRadius: radius.md,
                          borderWidth: 1,
                          borderColor: isSelected ? tc.primary : tc.border,
                          backgroundColor: isSelected ? tc.primary + '12' : tc.surface,
                        }}>
                        <Ionicons
                          name={isSelected ? 'checkbox' : 'square-outline'}
                          size={20}
                          color={isSelected ? tc.primary : tc.textMuted}
                        />
                        <View style={{ flex: 1 }}>
                          <Text style={{ fontSize: 14, fontWeight: '700', color: tc.textPrimary }} numberOfLines={1}>
                            {t.name}
                          </Text>
                          <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 2 }}>
                            {(t.workout?.focus as any) ?? 'Workout'} · {exerciseCount} exercise{exerciseCount === 1 ? '' : 's'}
                            {t.shareCode ? ` · code ${t.shareCode}` : ''}
                          </Text>
                        </View>
                      </TouchableOpacity>
                    );
                  })
                )}
              </ScrollView>

              {overLimit && (
                <Text style={{ fontSize: 12, color: tc.error ?? '#EF4444' }}>
                  Bundles can hold at most {MAX_BUNDLE_ITEMS} templates.
                </Text>
              )}
              {selectedCount === 1 && (
                <Text style={{ fontSize: 12, color: tc.textMuted }}>
                  Pick at least one more — bundles are for two or more
                  templates. Use the per-template share button for a single
                  workout.
                </Text>
              )}

              <TouchableOpacity
                testID="bundle-share-create"
                disabled={!canCreate}
                onPress={onCreate}
                activeOpacity={0.8}
                style={{
                  paddingVertical: 13, borderRadius: radius.md,
                  backgroundColor: canCreate ? tc.primary : tc.primary + '55',
                  alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8,
                }}>
                {creating ? <ActivityIndicator color={onPrimary} />
                  : <Ionicons name="link-outline" size={16} color={onPrimary} />}
                <Text style={{ color: onPrimary, fontSize: 14, fontWeight: '800', letterSpacing: 0.3 }}>
                  {creating ? 'Creating bundle…' : `Create bundle (${selectedCount})`}
                </Text>
              </TouchableOpacity>
            </>
          )}

          {/* ── Post-create state: show bundle code + share button ── */}
          {created && (
            <>
              <View style={{
                padding: 16, borderRadius: radius.md, borderWidth: 1,
                borderColor: tc.border, backgroundColor: tc.surface, gap: 6,
                alignItems: 'center',
              }}>
                <Text style={{ fontSize: 11, color: tc.textMuted, letterSpacing: 1.5, fontWeight: '700' }}>
                  BUNDLE CODE
                </Text>
                <Text
                  testID="bundle-share-code"
                  style={{ fontSize: 28, fontWeight: '900', letterSpacing: 6, color: tc.textPrimary }}>
                  {created.bundleCode}
                </Text>
                <Text style={{ fontSize: 12, color: tc.textMuted, textAlign: 'center', marginTop: 4 }}>
                  {created.items.filter(i => i.available).length} workout{created.items.length === 1 ? '' : 's'} included
                </Text>
              </View>

              <Text style={{ fontSize: 13, color: tc.textSecondary, lineHeight: 18 }}>
                Anyone with this code can preview and import the bundle
                from the &quot;Import shared template&quot; sheet. They&apos;ll see your
                username on each imported workout.
              </Text>

              <TouchableOpacity
                testID="bundle-share-system-sheet"
                onPress={onShare}
                activeOpacity={0.8}
                style={{
                  paddingVertical: 13, borderRadius: radius.md,
                  backgroundColor: tc.primary,
                  alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8,
                }}>
                <Ionicons name="share-outline" size={16} color={onPrimary} />
                <Text style={{ color: onPrimary, fontSize: 14, fontWeight: '800', letterSpacing: 0.3 }}>
                  Share bundle code
                </Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}
