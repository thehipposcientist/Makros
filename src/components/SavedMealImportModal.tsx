import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getContrastingTextColor, getTheme, radius } from '../constants/theme';
import { AppThemeName } from '../types';
import {
  importSharedSavedMeal,
  previewSharedSavedMeal,
  type SavedMeal,
  type SharedSavedMealPreview,
} from '../services/api';
import {
  normalizeSavedMealShareCode,
  SAVED_MEAL_CODE_LENGTH,
} from '../utils/savedMealShareCode';

interface Props {
  visible: boolean;
  themeName?: AppThemeName;
  authToken: string | null;
  initialCode?: string | null;
  onClose: () => void;
  onImported?: (savedMeal: SavedMeal) => void | Promise<void>;
}

export default function SavedMealImportModal({
  visible, themeName, authToken, initialCode, onClose, onImported,
}: Props) {
  const tc = getTheme(themeName).colors;
  const onPrimary = getContrastingTextColor(tc.primary);
  const [code, setCode] = useState('');
  const [preview, setPreview] = useState<SharedSavedMealPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    if (!visible) {
      setCode('');
      setPreview(null);
      setLoading(false);
      setImporting(false);
      return;
    }
    if (initialCode) setCode(normalizeSavedMealShareCode(initialCode));
  }, [visible, initialCode]);

  const ready = code.length === SAVED_MEAL_CODE_LENGTH;

  useEffect(() => {
    if (!visible || !authToken || !ready) {
      if (!ready) setPreview(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setPreview(null);
    previewSharedSavedMeal(authToken, code)
      .then(p => { if (!cancelled) setPreview(p); })
      .catch(() => { if (!cancelled) setPreview(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [authToken, code, ready, visible]);

  const itemCount = preview?.items?.length ?? 0;
  const ownerLabel = useMemo(() => {
    const owner = preview?.owner_username || preview?.source_owner_username;
    return owner ? `@${owner}` : 'Thallo';
  }, [preview?.owner_username, preview?.source_owner_username]);

  const handleImport = async () => {
    if (!authToken || !preview || preview.owned_by_viewer) return;
    setImporting(true);
    try {
      const imported = await importSharedSavedMeal(authToken, code);
      await Promise.resolve(onImported?.(imported));
      onClose();
    } catch (e: any) {
      Alert.alert('Import failed', e?.message ?? 'Could not import meal.');
    } finally {
      setImporting(false);
    }
  };

  const importDisabled = importing || !authToken || !preview || preview.owned_by_viewer;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={{
        flex: 1,
        backgroundColor: '#0009',
        justifyContent: 'center',
        padding: 20,
      }}>
        <View style={{
          backgroundColor: tc.background,
          borderRadius: radius.lg,
          borderWidth: 1,
          borderColor: tc.border,
          padding: 20,
          gap: 14,
          maxHeight: '88%',
        }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text style={{ fontSize: 17, fontWeight: '800', color: tc.textPrimary }}>
              Import shared meal
            </Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close" size={22} color={tc.textMuted} />
            </TouchableOpacity>
          </View>

          <Text style={{ fontSize: 13, color: tc.textMuted, lineHeight: 18 }}>
            Paste a 6-character meal code from a friend.
          </Text>

          <TextInput
            testID="saved-meal-import-code"
            value={code}
            onChangeText={t => setCode(normalizeSavedMealShareCode(t))}
            autoCapitalize="characters"
            autoCorrect={false}
            spellCheck={false}
            placeholder="ABC234"
            placeholderTextColor={tc.textMuted + '88'}
            maxLength={SAVED_MEAL_CODE_LENGTH}
            style={{
              fontSize: 24,
              fontWeight: '800',
              letterSpacing: 6,
              color: tc.textPrimary,
              textAlign: 'center',
              borderWidth: 1,
              borderColor: tc.border,
              borderRadius: radius.md,
              backgroundColor: tc.surface,
              paddingVertical: 12,
              paddingHorizontal: 14,
            }}
          />

          {ready && loading && (
            <View style={{ flexDirection: 'row', justifyContent: 'center', paddingVertical: 12 }}>
              <ActivityIndicator color={tc.primary} />
            </View>
          )}

          {ready && !loading && !preview && (
            <View style={{
              padding: 14,
              borderRadius: radius.md,
              borderWidth: 1,
              borderColor: tc.border,
              backgroundColor: tc.surface,
            }}>
              <Text style={{ fontSize: 13, color: tc.error ?? '#EF4444', textAlign: 'center' }}>
                No saved meal found for that code.
              </Text>
            </View>
          )}

          {preview && (
            <View style={{
              borderRadius: radius.md,
              borderWidth: 1,
              borderColor: tc.border,
              backgroundColor: tc.surface,
              padding: 14,
              gap: 10,
            }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <View style={{
                  width: 36,
                  height: 36,
                  borderRadius: 10,
                  backgroundColor: tc.primary + '14',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}>
                  <Ionicons name="restaurant-outline" size={18} color={tc.primary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 15, fontWeight: '800', color: tc.textPrimary }} numberOfLines={1}>
                    {preview.name}
                  </Text>
                  <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 2 }} numberOfLines={1}>
                    Shared by {ownerLabel} · {itemCount} item{itemCount === 1 ? '' : 's'}
                  </Text>
                </View>
              </View>

              <View style={{ flexDirection: 'row', gap: 8 }}>
                {[
                  `${Math.round(preview.total_calories)} cal`,
                  `${Math.round(preview.total_protein_g)}g P`,
                  `${Math.round(preview.total_carbs_g)}g C`,
                  `${Math.round(preview.total_fat_g)}g F`,
                ].map(label => (
                  <View
                    key={label}
                    style={{
                      paddingVertical: 5,
                      paddingHorizontal: 8,
                      borderRadius: 8,
                      backgroundColor: tc.background,
                      borderWidth: 1,
                      borderColor: tc.border,
                    }}>
                    <Text style={{ fontSize: 10, fontWeight: '700', color: tc.textSecondary }}>
                      {label}
                    </Text>
                  </View>
                ))}
              </View>

              <ScrollView style={{ maxHeight: 150 }} showsVerticalScrollIndicator={false}>
                {(preview.items ?? []).map((item, index) => (
                  <View
                    key={`${item.food_name}-${index}`}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      paddingVertical: 6,
                      borderTopWidth: index === 0 ? 0 : 1,
                      borderTopColor: tc.border + '66',
                    }}>
                    <Text style={{ flex: 1, fontSize: 12, color: tc.textPrimary }} numberOfLines={1}>
                      {item.food_name}
                    </Text>
                    <Text style={{ fontSize: 11, color: tc.textMuted }}>
                      {item.quantity} {item.unit}
                    </Text>
                  </View>
                ))}
              </ScrollView>

              {preview.owned_by_viewer && (
                <Text style={{ fontSize: 12, color: tc.textMuted, textAlign: 'center' }}>
                  This meal is already in your favorites.
                </Text>
              )}
            </View>
          )}

          <TouchableOpacity
            testID="saved-meal-import-submit"
            disabled={importDisabled}
            onPress={handleImport}
            activeOpacity={0.8}
            style={{
              paddingVertical: 13,
              borderRadius: radius.md,
              backgroundColor: importDisabled ? tc.primary + '55' : tc.primary,
              alignItems: 'center',
              flexDirection: 'row',
              justifyContent: 'center',
              gap: 8,
            }}>
            {importing ? <ActivityIndicator color={onPrimary} />
              : <Ionicons name="download-outline" size={16} color={onPrimary} />}
            <Text style={{ color: onPrimary, fontSize: 14, fontWeight: '800' }}>
              {importing ? 'Importing...' : 'Import to favorites'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}
