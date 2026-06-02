/**
 * Workout Template Import — paste a share code, preview the workout, import it.
 *
 * Handles two code shapes:
 *   • 6 chars → single-template share code (legacy single-share path).
 *   • 8 chars → bundle code (multi-template share). Renders a preview
 *     list with per-item checkboxes, defaults to all available items
 *     selected, and imports the chosen subset in one round trip.
 *
 * Both shapes share the ambiguity-stripped alphabet (no 0/O/1/I/L). The
 * TextInput auto-normalizes paste-from-clipboard, so codes shared from
 * iMessage / Slack / etc. work without manual cleanup.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  View, Text, Modal, TouchableOpacity, TextInput, ActivityIndicator, Alert,
  ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getContrastingTextColor, getTheme, radius } from '../constants/theme';
import { AppThemeName, SavedWorkoutTemplate } from '../types';
import {
  importSharedWorkoutTemplate,
  importSharedWorkoutTemplateBundle,
  previewSharedWorkoutTemplate,
  previewSharedWorkoutTemplateBundle,
  type SharedWorkoutTemplatePreview,
  type SharedWorkoutTemplateBundle,
  type WorkoutTemplateRecord,
} from '../services/api';
import {
  BUNDLE_CODE_LENGTH,
  classifyShareCode,
  normalizeShareCode,
} from '../utils/workoutTemplateShareCode';

const MAX_INPUT_LENGTH = BUNDLE_CODE_LENGTH;

function genClientId(): string {
  // Same shape used elsewhere in the app for SavedWorkoutTemplate.id.
  return `tpl_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

interface Props {
  visible: boolean;
  themeName?: AppThemeName;
  authToken: string | null;
  /** Pre-fill the code box. Used by the deep-link handler so a tap on
   *  `thallo://template/ABC234` (single) or `thallo://template-bundle/ABC23456`
   *  (bundle) lands you on a populated, ready-to-confirm import sheet
   *  instead of an empty one. */
  initialCode?: string | null;
  onClose: () => void;
  onImported?: (template: SavedWorkoutTemplate) => void;
  /** Called once with all templates created from a bundle import. The
   *  single-import path uses `onImported` only — kept separate so the
   *  caller can batch its cache refresh for bundles. Optional; if
   *  omitted the bundle path falls back to calling `onImported` per
   *  imported row. */
  onBundleImported?: (templates: SavedWorkoutTemplate[]) => void;
}

function recordToSaved(r: WorkoutTemplateRecord): SavedWorkoutTemplate {
  return {
    id: r.id,
    name: r.name,
    workout: r.workout,
    notes: r.notes ?? null,
    shareCode: r.shareCode,
    timesImported: r.timesImported,
    sourceShareCode: r.sourceShareCode,
    sourceOwnerUsername: r.sourceOwnerUsername,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export default function WorkoutTemplateImportModal({
  visible, themeName, authToken, initialCode, onClose, onImported, onBundleImported,
}: Props) {
  const tc = getTheme(themeName).colors;
  const onPrimary = getContrastingTextColor(tc.primary);
  const [code, setCode] = useState('');
  const [preview, setPreview] = useState<SharedWorkoutTemplatePreview | null>(null);
  const [bundlePreview, setBundlePreview] = useState<SharedWorkoutTemplateBundle | null>(null);
  const [bundleSelected, setBundleSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    if (!visible) {
      setCode('');
      setPreview(null);
      setBundlePreview(null);
      setBundleSelected(new Set());
      setLoading(false);
      setImporting(false);
      return;
    }
    // On open, hydrate from the deep-link code if one was supplied.
    if (initialCode) setCode(normalizeShareCode(initialCode));
  }, [visible, initialCode]);

  // Resolve the input to a code shape. Length is the only signal we
  // need — both code types use the same alphabet.
  const codeShape = classifyShareCode(code);
  const ready = codeShape !== null;

  // Auto-fetch preview as soon as the code is complete. We dispatch to
  // the right preview endpoint based on length — bundle codes are
  // strictly 8 chars, so there's no ambiguity, and the wrong length
  // simply leaves the preview empty.
  useEffect(() => {
    if (!visible || !authToken) return;
    if (!ready) {
      setPreview(null);
      setBundlePreview(null);
      setBundleSelected(new Set());
      return;
    }
    let cancelled = false;
    setLoading(true);
    setPreview(null);
    setBundlePreview(null);
    const job = codeShape === 'single'
      ? previewSharedWorkoutTemplate(authToken, code).then(p => {
          if (!cancelled) setPreview(p);
        })
      : previewSharedWorkoutTemplateBundle(authToken, code).then(b => {
          if (cancelled) return;
          setBundlePreview(b);
          // Default-select every available item — that's the most
          // common intent (import the whole bundle). Tombstones
          // (available:false) are excluded.
          setBundleSelected(new Set(
            b.items.filter(i => i.available).map(i => i.shareCode),
          ));
        });
    job
      .catch(() => {
        if (cancelled) return;
        setPreview(null);
        setBundlePreview(null);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [code, ready, codeShape, visible, authToken]);

  const exerciseCount = preview?.workout?.exercises?.length ?? 0;

  const toggleBundleItem = (shareCode: string) => {
    setBundleSelected(prev => {
      const next = new Set(prev);
      if (next.has(shareCode)) next.delete(shareCode); else next.add(shareCode);
      return next;
    });
  };

  const bundleAvailableCount = bundlePreview
    ? bundlePreview.items.filter(i => i.available).length : 0;
  const bundleSelectedCount = bundleSelected.size;
  // "All selected" lets us flip a single header control instead of
  // checking each row to clear/restore selection.
  const allBundleSelected = bundlePreview != null
    && bundleAvailableCount > 0
    && bundleSelectedCount === bundleAvailableCount;

  const onConfirmImport = async () => {
    if (!authToken) return;
    setImporting(true);
    try {
      if (codeShape === 'single') {
        if (!preview) return;
        const record = await importSharedWorkoutTemplate(authToken, code, genClientId());
        onImported?.(recordToSaved(record));
        // Funnel: which share codes drive imports? Ties to templateShared.
        try {
          const { analytics } = await import('../services/analytics');
          analytics.templateImported({ share_code: code, token: authToken });
        } catch { /* analytics is best-effort */ }
      } else if (codeShape === 'bundle') {
        if (!bundlePreview) return;
        const items = Array.from(bundleSelected).map(sc => ({
          shareCode: sc,
          clientId: genClientId(),
        }));
        if (items.length === 0) {
          Alert.alert('Pick at least one workout', 'Select the workouts you want to import from this bundle.');
          setImporting(false);
          return;
        }
        const result = await importSharedWorkoutTemplateBundle(authToken, code, items);
        const saved = result.imported.map(recordToSaved);
        if (onBundleImported) {
          onBundleImported(saved);
        } else {
          for (const s of saved) onImported?.(s);
        }
        if (result.skipped.length > 0) {
          // Soft surface — let the user know which items were skipped
          // (already-owned, not-found) without blocking close.
          const noun = result.skipped.length === 1 ? 'item was' : 'items were';
          Alert.alert(
            'Some items skipped',
            `${result.skipped.length} ${noun} skipped (already imported or no longer available).`,
          );
        }
      }
      onClose();
    } catch (e: any) {
      Alert.alert('Import failed', e?.message ?? 'Could not import template.');
    } finally {
      setImporting(false);
    }
  };

  // Shared empty / loading / not-found states keep the per-shape
  // branches below focused on rendering the actual preview content.
  const renderEmptyOrLoading = () => {
    if (!ready) return null;
    if (loading) {
      return (
        <View style={{ flexDirection: 'row', justifyContent: 'center', paddingVertical: 12 }}>
          <ActivityIndicator color={tc.primary} />
        </View>
      );
    }
    const noResult = (codeShape === 'single' && !preview)
      || (codeShape === 'bundle' && !bundlePreview);
    if (!noResult) return null;
    return (
      <View style={{
        padding: 14, borderRadius: radius.md, borderWidth: 1,
        borderColor: tc.border, backgroundColor: tc.surface,
      }}>
        <Text style={{ fontSize: 13, color: tc.error ?? '#EF4444', textAlign: 'center' }}>
          No {codeShape === 'bundle' ? 'bundle' : 'template'} found for that code.
        </Text>
      </View>
    );
  };

  const importDisabled = importing || !authToken
    || (codeShape === 'single' && !preview)
    || (codeShape === 'bundle' && (!bundlePreview || bundleSelectedCount === 0));

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
              {codeShape === 'bundle' ? 'Import shared bundle' : 'Import shared template'}
            </Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close" size={22} color={tc.textMuted} />
            </TouchableOpacity>
          </View>

          <Text style={{ fontSize: 13, color: tc.textMuted, lineHeight: 18 }}>
            Paste a 6-character template code or an 8-character bundle
            code from your friend.
          </Text>

          <TextInput
            testID="workout-template-import-code"
            value={code}
            onChangeText={t => setCode(normalizeShareCode(t))}
            autoCapitalize="characters"
            autoCorrect={false}
            spellCheck={false}
            placeholder="ABC234"
            placeholderTextColor={tc.textMuted + '88'}
            maxLength={MAX_INPUT_LENGTH}
            style={{
              fontSize: 24, fontWeight: '800', letterSpacing: 6,
              color: tc.textPrimary, textAlign: 'center',
              borderWidth: 1, borderColor: tc.border, borderRadius: radius.md,
              backgroundColor: tc.surface, paddingVertical: 14, paddingHorizontal: 16,
            }}
          />

          {renderEmptyOrLoading()}

          {/* ── Single-template preview ─────────────────────────────── */}
          {codeShape === 'single' && preview && !loading && (
            <View style={{
              padding: 14, borderRadius: radius.md, borderWidth: 1,
              borderColor: tc.border, backgroundColor: tc.surface, gap: 6,
            }}>
              <Text style={{ fontSize: 15, fontWeight: '800', color: tc.textPrimary }}>
                {preview.name}
              </Text>
              <Text style={{ fontSize: 12, color: tc.textMuted }}>
                {preview.workout?.focus ?? 'Workout'} · {exerciseCount} exercise{exerciseCount === 1 ? '' : 's'}
                {preview.ownerUsername ? ` · from @${preview.ownerUsername}` : ''}
              </Text>
            </View>
          )}

          {/* ── Bundle preview with per-item selection ──────────────── */}
          {codeShape === 'bundle' && bundlePreview && !loading && (
            <View style={{ gap: 10 }}>
              <View style={{
                padding: 12, borderRadius: radius.md, borderWidth: 1,
                borderColor: tc.border, backgroundColor: tc.surface, gap: 4,
              }}>
                <Text style={{ fontSize: 15, fontWeight: '800', color: tc.textPrimary }}>
                  {bundlePreview.name?.trim() || `Workout bundle (${bundleAvailableCount})`}
                </Text>
                <Text style={{ fontSize: 12, color: tc.textMuted }}>
                  {bundleAvailableCount} workout{bundleAvailableCount === 1 ? '' : 's'} available
                  {bundlePreview.ownerUsername ? ` · from @${bundlePreview.ownerUsername}` : ''}
                </Text>
              </View>

              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text style={{ fontSize: 12, fontWeight: '700', color: tc.textSecondary }}>
                  {bundleSelectedCount} of {bundleAvailableCount} selected
                </Text>
                {bundleAvailableCount > 0 && (
                  <TouchableOpacity
                    testID="workout-template-import-toggle-all"
                    onPress={() => {
                      if (allBundleSelected) {
                        setBundleSelected(new Set());
                      } else {
                        setBundleSelected(new Set(
                          bundlePreview.items.filter(i => i.available).map(i => i.shareCode),
                        ));
                      }
                    }}
                    hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                    <Text style={{ fontSize: 12, fontWeight: '700', color: tc.primary }}>
                      {allBundleSelected ? 'Clear all' : 'Select all'}
                    </Text>
                  </TouchableOpacity>
                )}
              </View>

              <ScrollView
                style={{ maxHeight: 280 }}
                contentContainerStyle={{ gap: 6 }}
                showsVerticalScrollIndicator={false}>
                {bundlePreview.items.map((item, idx) => {
                  const isAvailable = item.available;
                  const isSelected = isAvailable && bundleSelected.has(item.shareCode);
                  const exCount = isAvailable
                    ? (item.workout?.exercises?.length ?? 0)
                    : 0;
                  return (
                    <TouchableOpacity
                      key={item.shareCode}
                      testID={`workout-template-import-bundle-row-${idx}`}
                      disabled={!isAvailable}
                      onPress={() => toggleBundleItem(item.shareCode)}
                      activeOpacity={0.7}
                      style={{
                        flexDirection: 'row', alignItems: 'center', gap: 10,
                        padding: 12, borderRadius: radius.md,
                        borderWidth: 1,
                        borderColor: isSelected ? tc.primary : tc.border,
                        backgroundColor: isSelected
                          ? tc.primary + '12'
                          : !isAvailable ? tc.surface + 'AA' : tc.surface,
                        opacity: isAvailable ? 1 : 0.5,
                      }}>
                      <Ionicons
                        name={isSelected ? 'checkbox' : 'square-outline'}
                        size={20}
                        color={isSelected ? tc.primary : tc.textMuted}
                      />
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 14, fontWeight: '700', color: tc.textPrimary }} numberOfLines={1}>
                          {isAvailable ? item.name : 'Unavailable'}
                        </Text>
                        <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 2 }}>
                          {isAvailable
                            ? `${(item.workout?.focus as any) ?? 'Workout'} · ${exCount} exercise${exCount === 1 ? '' : 's'}${item.ownerUsername ? ` · from @${item.ownerUsername}` : ''}`
                            : 'This template was deleted or its share code was revoked.'}
                        </Text>
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </View>
          )}

          <TouchableOpacity
            testID="workout-template-import-confirm"
            disabled={importDisabled}
            onPress={onConfirmImport}
            activeOpacity={0.8}
            style={{
              paddingVertical: 13, borderRadius: radius.md,
              backgroundColor: !importDisabled ? tc.primary : tc.primary + '55',
              alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8,
            }}>
            {importing ? <ActivityIndicator color={onPrimary} />
              : <Ionicons name="download-outline" size={16} color={onPrimary} />}
            <Text style={{ color: onPrimary, fontSize: 14, fontWeight: '800', letterSpacing: 0.3 }}>
              {importing
                ? 'Importing…'
                : codeShape === 'bundle'
                  ? `Import ${bundleSelectedCount} workout${bundleSelectedCount === 1 ? '' : 's'}`
                  : 'Import to my templates'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}
