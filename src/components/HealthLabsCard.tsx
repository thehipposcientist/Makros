import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';

import {
  deleteHealthLabResult,
  getHealthLabResults,
  getLabMarkers,
  saveHealthLabResult,
  saveHealthLabResultsBatch,
  scanLabReport,
  type HealthLabResultItem,
  type HealthLabResultPayload,
  type LabMarker,
  type LabScanCandidate,
} from '../services/api';
import { getContrastingTextColor, getTheme, radius, typography, elevations } from '../constants/theme';
import type { AppThemeName, UserProfile } from '../types';
import { requirePro } from '../utils/subscription';

type ThemeColors = ReturnType<typeof getTheme>['colors'];

interface Props {
  authToken: string;
  userProfile: UserProfile;
  themeName?: AppThemeName;
  isActive?: boolean;
}

const FALLBACK_MARKERS: LabMarker[] = [
  { key: 'a1c', label: 'A1C', default_unit: '%' },
  { key: 'fasting_glucose', label: 'Fasting glucose', default_unit: 'mg/dL' },
  { key: 'ldl', label: 'LDL', default_unit: 'mg/dL' },
  { key: 'hdl', label: 'HDL', default_unit: 'mg/dL' },
  { key: 'triglycerides', label: 'Triglycerides', default_unit: 'mg/dL' },
  { key: 'ferritin', label: 'Ferritin', default_unit: 'ng/mL' },
  { key: 'vitamin_d', label: 'Vitamin D', default_unit: 'ng/mL' },
  { key: 'vitamin_b12', label: 'Vitamin B12', default_unit: 'pg/mL' },
  { key: 'total_testosterone', label: 'Total testosterone', default_unit: 'ng/dL' },
  { key: 'free_testosterone', label: 'Free testosterone', default_unit: 'pg/mL' },
  { key: 'shbg', label: 'SHBG', default_unit: 'nmol/L' },
  { key: 'estradiol', label: 'Estradiol', default_unit: 'pg/mL' },
  { key: 'progesterone', label: 'Progesterone', default_unit: 'ng/mL' },
  { key: 'cortisol', label: 'Cortisol', default_unit: 'ug/dL' },
  { key: 'bone_mineral_density', label: 'Bone mineral density', default_unit: 'g/cm2' },
  { key: 'bone_density_t_score', label: 'Bone density T-score', default_unit: 'T-score' },
  { key: 'tsh', label: 'TSH', default_unit: 'mIU/L' },
  { key: 'hs_crp', label: 'hs-CRP', default_unit: 'mg/L' },
];

function todayDateKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function displayDate(value: string | null | undefined): string {
  if (!value) return 'Date unknown';
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return value.slice(0, 10);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function cleanBase64(input: string): string {
  const prefixMatch = input.match(/^data:[^;]+;base64,/i);
  const withoutPrefix = prefixMatch ? input.slice(prefixMatch[0].length) : input;
  return withoutPrefix.replace(/\s+/g, '');
}

function numberFromInput(value: string): number | null {
  if (!value.trim()) return null;
  const n = Number(value.trim());
  return Number.isFinite(n) ? n : null;
}

function rowKey(row: HealthLabResultItem | LabScanCandidate, index: number): string {
  return `${row.lab_type}-${row.value}-${row.unit}-${row.collected_at ?? 'date'}-${index}`;
}

export default function HealthLabsCard({ authToken, userProfile, themeName, isActive = true }: Props) {
  const tc = getTheme(themeName).colors;
  const styles = useMemo(() => createStyles(tc), [tc]);
  const primaryText = getContrastingTextColor(tc.primary);

  const [markers, setMarkers] = useState<LabMarker[]>(FALLBACK_MARKERS);
  const [labs, setLabs] = useState<HealthLabResultItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [scanLoading, setScanLoading] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [scanCandidates, setScanCandidates] = useState<LabScanCandidate[] | null>(null);
  const [scanWarnings, setScanWarnings] = useState<string[]>([]);

  const [draftType, setDraftType] = useState(FALLBACK_MARKERS[0].key);
  const [draftValue, setDraftValue] = useState('');
  const [draftUnit, setDraftUnit] = useState(FALLBACK_MARKERS[0].default_unit);
  const [draftDate, setDraftDate] = useState(todayDateKey());
  const [draftRefLow, setDraftRefLow] = useState('');
  const [draftRefHigh, setDraftRefHigh] = useState('');

  const markerByKey = useMemo(() => {
    const map = new Map<string, LabMarker>();
    markers.forEach(marker => map.set(marker.key, marker));
    return map;
  }, [markers]);

  const loadLabs = useCallback(async () => {
    if (!authToken) return;
    setLoading(true);
    try {
      const [markerResp, rows] = await Promise.all([
        getLabMarkers(authToken).catch(() => ({ markers: FALLBACK_MARKERS })),
        getHealthLabResults(authToken, 730).catch(() => []),
      ]);
      if (markerResp.markers?.length) setMarkers(markerResp.markers);
      setLabs(rows);
    } finally {
      setLoading(false);
    }
  }, [authToken]);

  useEffect(() => {
    if (!isActive) return;
    loadLabs().catch(() => {});
  }, [isActive, loadLabs]);

  const latestByType = useMemo(() => {
    const seen = new Set<string>();
    const out: HealthLabResultItem[] = [];
    for (const row of labs) {
      if (seen.has(row.lab_type)) continue;
      seen.add(row.lab_type);
      out.push(row);
      if (out.length >= 6) break;
    }
    return out;
  }, [labs]);

  const resetManualDraft = useCallback((markerKey = draftType) => {
    const marker = markerByKey.get(markerKey) ?? markers[0] ?? FALLBACK_MARKERS[0];
    setDraftType(marker.key);
    setDraftValue('');
    setDraftUnit(marker.default_unit || '');
    setDraftDate(todayDateKey());
    setDraftRefLow('');
    setDraftRefHigh('');
  }, [draftType, markerByKey, markers]);

  const saveManual = useCallback(async () => {
    const value = numberFromInput(draftValue);
    if (value == null) {
      Alert.alert('Value needed', 'Enter the numeric result from your lab report.');
      return;
    }
    const reference_range_low = numberFromInput(draftRefLow);
    const reference_range_high = numberFromInput(draftRefHigh);
    const payload: HealthLabResultPayload = {
      lab_type: draftType,
      value,
      unit: draftUnit.trim() || markerByKey.get(draftType)?.default_unit || '',
      collected_at: draftDate.trim() || todayDateKey(),
      source: 'manual',
      reference_range_low,
      reference_range_high,
    };
    setSaving(true);
    try {
      await saveHealthLabResult(authToken, payload);
      setManualOpen(false);
      resetManualDraft();
      await loadLabs();
    } catch (e: any) {
      Alert.alert('Could not save lab', e?.message ?? 'Try again in a moment.');
    } finally {
      setSaving(false);
    }
  }, [authToken, draftDate, draftRefHigh, draftRefLow, draftType, draftUnit, draftValue, loadLabs, markerByKey, resetManualDraft]);

  const handleScanResult = useCallback((result: Awaited<ReturnType<typeof scanLabReport>>) => {
    if (!result.labs?.length) {
      Alert.alert('No lab markers found', 'Try a clearer photo, screenshot, or a text-based PDF.');
      return;
    }
    setScanCandidates(result.labs);
    setScanWarnings(result.warnings ?? []);
  }, []);

  const scanPhoto = useCallback(async (source: 'camera' | 'library') => {
    if (!requirePro(userProfile, 'ai_lab_scan')) return;
    setScanLoading(true);
    try {
      const ImagePicker = await import('expo-image-picker');
      if (source === 'camera') {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) {
          Alert.alert('Camera permission needed', 'Allow camera access in Settings to scan a lab report.');
          return;
        }
      } else {
        const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!perm.granted) {
          Alert.alert('Photo access needed', 'Allow photo library access in Settings to choose a lab report image.');
          return;
        }
      }
      const picked = source === 'camera'
        ? await ImagePicker.launchCameraAsync({ base64: true, quality: 0.45, mediaTypes: 'images' as any })
        : await ImagePicker.launchImageLibraryAsync({ base64: true, quality: 0.45, mediaTypes: 'images' as any });
      if (picked.canceled) return;
      const asset = picked.assets?.[0];
      if (!asset?.base64) {
        Alert.alert('Could not read image', 'Try a different image or take a new photo.');
        return;
      }
      const imageBase64 = cleanBase64(asset.base64);
      if (imageBase64.length > 4_500_000) {
        Alert.alert('Image too large', 'Try a screenshot or a lower-resolution photo of the report.');
        return;
      }
      const result = await scanLabReport(authToken, {
        image_base64: imageBase64,
        mime_type: asset.mimeType || 'image/jpeg',
      });
      handleScanResult(result);
    } catch (e: any) {
      Alert.alert('Scan failed', e?.message ?? 'Could not scan that report.');
    } finally {
      setScanLoading(false);
    }
  }, [authToken, handleScanResult, userProfile]);

  const scanFile = useCallback(async () => {
    if (!requirePro(userProfile, 'ai_lab_scan')) return;
    setScanLoading(true);
    try {
      const DocumentPicker = await import('expo-document-picker');
      const FileSystem = await import('expo-file-system');
      const picked = await DocumentPicker.getDocumentAsync({
        type: ['application/pdf', 'image/*'],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (picked.canceled || !picked.assets?.length) return;
      const file = picked.assets[0];
      if (file.size != null && file.size > 8_000_000) {
        Alert.alert('File too large', 'Upload a smaller PDF, screenshot, or photo of the report.');
        return;
      }
      const base64Encoding = (FileSystem as any).EncodingType?.Base64 ?? 'base64';
      const fileBase64 = await FileSystem.readAsStringAsync(file.uri, { encoding: base64Encoding });
      if (fileBase64.length > 11_000_000) {
        Alert.alert('File too large', 'Upload a smaller PDF, screenshot, or photo of the report.');
        return;
      }
      const result = await scanLabReport(authToken, {
        file_base64: cleanBase64(fileBase64),
        mime_type: file.mimeType || (file.name?.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg'),
        filename: file.name,
      });
      handleScanResult(result);
    } catch (e: any) {
      Alert.alert('Scan failed', e?.message ?? 'Could not scan that report.');
    } finally {
      setScanLoading(false);
    }
  }, [authToken, handleScanResult, userProfile]);

  const promptScanSource = useCallback(() => {
    Alert.alert(
      'Scan lab report',
      'Choose a clear report photo, screenshot, or text-based PDF. You will review values before saving.',
      [
        { text: 'Camera', onPress: () => scanPhoto('camera') },
        { text: 'Photo', onPress: () => scanPhoto('library') },
        { text: 'File', onPress: () => scanFile() },
        { text: 'Cancel', style: 'cancel' },
      ],
    );
  }, [scanFile, scanPhoto]);

  const saveScannedLabs = useCallback(async () => {
    if (!scanCandidates?.length) return;
    setSaving(true);
    try {
      const payloads: HealthLabResultPayload[] = scanCandidates.map(row => ({
        lab_type: row.lab_type,
        value: row.value,
        unit: row.unit,
        collected_at: row.collected_at || todayDateKey(),
        source: 'scan',
        reference_range_low: row.reference_range_low ?? null,
        reference_range_high: row.reference_range_high ?? null,
      }));
      await saveHealthLabResultsBatch(authToken, payloads);
      setScanCandidates(null);
      setScanWarnings([]);
      await loadLabs();
    } catch (e: any) {
      Alert.alert('Could not save labs', e?.message ?? 'Review the rows and try again.');
    } finally {
      setSaving(false);
    }
  }, [authToken, loadLabs, scanCandidates]);

  const deleteLab = useCallback((row: HealthLabResultItem) => {
    Alert.alert(
      'Delete lab result?',
      `${row.lab_label} from ${displayDate(row.collected_at)} will be removed.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteHealthLabResult(authToken, row.id);
              setLabs(prev => prev.filter(item => item.id !== row.id));
            } catch (e: any) {
              Alert.alert('Could not delete', e?.message ?? 'Try again in a moment.');
            }
          },
        },
      ],
    );
  }, [authToken]);

  const actionButton = (
    label: string,
    icon: ComponentProps<typeof Ionicons>['name'],
    onPress: () => void,
    primary = false,
  ) => (
    <TouchableOpacity
      activeOpacity={0.85}
      disabled={scanLoading || saving}
      onPress={onPress}
      style={[
        styles.actionButton,
        primary
          ? { backgroundColor: tc.primary, borderColor: tc.primary }
          : { backgroundColor: tc.surfaceRaised, borderColor: tc.border },
        (scanLoading || saving) && { opacity: 0.55 },
      ]}>
      <Ionicons name={icon} size={16} color={primary ? primaryText : tc.textPrimary} />
      <Text style={[styles.actionButtonText, { color: primary ? primaryText : tc.textPrimary }]} numberOfLines={1}>
        {label}
      </Text>
    </TouchableOpacity>
  );

  return (
    <>
      <View testID="health-labs-card" style={styles.card}>
        <View style={styles.header}>
          <View style={styles.iconCircle}>
            <Ionicons name="flask-outline" size={17} color={tc.primary} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.eyebrow}>Optional context</Text>
            <Text style={styles.title} numberOfLines={1}>Labs</Text>
          </View>
          {labs.length > 0 ? (
            <View style={styles.countPill}>
              <Text style={styles.countPillText}>{labs.length} saved</Text>
            </View>
          ) : null}
        </View>

        <Text style={styles.bodyText}>
          Add confirmed bloodwork as optional health context alongside Apple Health, sleep, and check-ins. Thallo does not diagnose lab results.
        </Text>

        <View style={styles.actionRow}>
          {actionButton('Scan', 'scan-outline', promptScanSource, true)}
          {actionButton('Manual', 'add-circle-outline', () => {
            resetManualDraft();
            setManualOpen(true);
          })}
        </View>

        {scanLoading || loading ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator color={tc.primary} />
            <Text style={styles.mutedText}>{scanLoading ? 'Reading report...' : 'Loading labs...'}</Text>
          </View>
        ) : latestByType.length > 0 ? (
          <View style={styles.labList}>
            {latestByType.map((row, index) => (
              <View key={rowKey(row, index)} style={styles.labRow}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.labName} numberOfLines={1}>{row.lab_label}</Text>
                  <Text style={styles.labMeta} numberOfLines={1}>
                    {displayDate(row.collected_at)} · {row.source === 'scan' ? 'Scanned' : 'Manual'}
                  </Text>
                </View>
                <View style={styles.labValueWrap}>
                  <Text style={styles.labValue} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.72}>
                    {Number(row.value).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  </Text>
                  <Text style={styles.labUnit} numberOfLines={1}>{row.unit}</Text>
                </View>
                <TouchableOpacity
                  onPress={() => deleteLab(row)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  style={styles.deleteButton}>
                  <Ionicons name="trash-outline" size={16} color={tc.textMuted} />
                </TouchableOpacity>
              </View>
            ))}
          </View>
        ) : (
          <View style={styles.emptyState}>
            <Ionicons name="document-text-outline" size={24} color={tc.textMuted} />
            <Text style={styles.emptyTitle}>No labs yet</Text>
            <Text style={styles.emptyBody}>A1C, glucose, lipids, ferritin, vitamin D, B12, thyroid, and optional hormone markers are useful first context.</Text>
          </View>
        )}
      </View>

      <Modal
        visible={manualOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setManualOpen(false)}>
        <View style={styles.modalBackdrop}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setManualOpen(false)} />
          <View style={styles.sheet}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>Add lab result</Text>
              <TouchableOpacity onPress={() => setManualOpen(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={20} color={tc.textMuted} />
              </TouchableOpacity>
            </View>
            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 8 }}>
              <Text style={styles.fieldLabel}>Marker</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.markerScroller}>
                {markers.slice(0, 20).map(marker => {
                  const active = draftType === marker.key;
                  return (
                    <TouchableOpacity
                      key={marker.key}
                      activeOpacity={0.82}
                      onPress={() => {
                        setDraftType(marker.key);
                        setDraftUnit(marker.default_unit || '');
                      }}
                      style={[
                        styles.markerChip,
                        { borderColor: active ? tc.primary : tc.border, backgroundColor: active ? tc.primary + '18' : tc.surfaceRaised },
                      ]}>
                      <Text style={[styles.markerChipText, { color: active ? tc.primary : tc.textSecondary }]}>{marker.label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>

              <View style={styles.fieldRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.fieldLabel}>Value</Text>
                  <TextInput
                    value={draftValue}
                    onChangeText={setDraftValue}
                    keyboardType="decimal-pad"
                    placeholder="0"
                    placeholderTextColor={tc.textMuted}
                    style={styles.input}
                  />
                </View>
                <View style={{ width: 112 }}>
                  <Text style={styles.fieldLabel}>Unit</Text>
                  <TextInput
                    value={draftUnit}
                    onChangeText={setDraftUnit}
                    autoCapitalize="none"
                    placeholder={markerByKey.get(draftType)?.default_unit || ''}
                    placeholderTextColor={tc.textMuted}
                    style={styles.input}
                  />
                </View>
              </View>

              <Text style={styles.fieldLabel}>Collection date</Text>
              <TextInput
                value={draftDate}
                onChangeText={setDraftDate}
                autoCapitalize="none"
                placeholder="YYYY-MM-DD"
                placeholderTextColor={tc.textMuted}
                style={styles.input}
              />

              <Text style={styles.fieldLabel}>Reference range</Text>
              <View style={styles.fieldRow}>
                <TextInput
                  value={draftRefLow}
                  onChangeText={setDraftRefLow}
                  keyboardType="decimal-pad"
                  placeholder="Low"
                  placeholderTextColor={tc.textMuted}
                  style={[styles.input, { flex: 1 }]}
                />
                <TextInput
                  value={draftRefHigh}
                  onChangeText={setDraftRefHigh}
                  keyboardType="decimal-pad"
                  placeholder="High"
                  placeholderTextColor={tc.textMuted}
                  style={[styles.input, { flex: 1 }]}
                />
              </View>

              <Text style={styles.disclaimerText}>
                Save only values you have reviewed. Out-of-range labs should be discussed with a clinician.
              </Text>

              <TouchableOpacity
                activeOpacity={0.86}
                disabled={saving}
                onPress={saveManual}
                style={[styles.primarySheetButton, saving && { opacity: 0.6 }]}>
                {saving ? <ActivityIndicator color={primaryText} /> : <Text style={[styles.primarySheetButtonText, { color: primaryText }]}>Save lab</Text>}
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>

      <Modal
        visible={scanCandidates != null}
        transparent
        animationType="fade"
        onRequestClose={() => setScanCandidates(null)}>
        <View style={styles.modalBackdrop}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setScanCandidates(null)} />
          <View style={styles.sheet}>
            <View style={styles.sheetHeader}>
              <View style={{ flex: 1 }}>
                <Text style={styles.sheetTitle}>Review scanned labs</Text>
                <Text style={styles.sheetSubtitle}>Nothing is saved until you confirm.</Text>
              </View>
              <TouchableOpacity onPress={() => setScanCandidates(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={20} color={tc.textMuted} />
              </TouchableOpacity>
            </View>

            <ScrollView style={{ maxHeight: 420 }} showsVerticalScrollIndicator={false}>
              {scanWarnings.map((warning, index) => (
                <View key={`${warning}-${index}`} style={styles.warningRow}>
                  <Ionicons name="alert-circle-outline" size={15} color={tc.warning ?? '#F59E0B'} />
                  <Text style={styles.warningText}>{warning}</Text>
                </View>
              ))}
              {(scanCandidates ?? []).map((row, index) => (
                <View key={rowKey(row, index)} style={styles.reviewRow}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.labName} numberOfLines={1}>{row.lab_label}</Text>
                    <Text style={styles.labMeta} numberOfLines={1}>
                      {row.collected_at ?? todayDateKey()} · {row.confidence ?? 'low'} confidence
                    </Text>
                  </View>
                  <View style={styles.labValueWrap}>
                    <Text style={styles.labValue} numberOfLines={1}>{row.value}</Text>
                    <Text style={styles.labUnit} numberOfLines={1}>{row.unit}</Text>
                  </View>
                  <TouchableOpacity
                    onPress={() => setScanCandidates(prev => prev ? prev.filter((_, i) => i !== index) : prev)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    style={styles.deleteButton}>
                    <Ionicons name="close-circle-outline" size={18} color={tc.textMuted} />
                  </TouchableOpacity>
                </View>
              ))}
              <Text style={styles.disclaimerText}>
                Check values, units, and date against your report. Thallo uses saved labs for wellness context only.
              </Text>
            </ScrollView>

            <View style={styles.sheetActionRow}>
              <TouchableOpacity
                activeOpacity={0.85}
                onPress={() => setScanCandidates(null)}
                style={[styles.secondarySheetButton, { borderColor: tc.border }]}>
                <Text style={styles.secondarySheetButtonText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                activeOpacity={0.86}
                disabled={saving || !scanCandidates?.length}
                onPress={saveScannedLabs}
                style={[styles.primarySheetButton, { flex: 1, marginTop: 0 }, (saving || !scanCandidates?.length) && { opacity: 0.55 }]}>
                {saving ? <ActivityIndicator color={primaryText} /> : <Text style={[styles.primarySheetButtonText, { color: primaryText }]}>Save selected</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    card: {
      backgroundColor: colors.surface,
      borderRadius: 20,
      padding: 16,
      marginBottom: 14,
      borderWidth: 1,
      borderColor: colors.border,
      ...elevations.card,
    },
    header: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
    iconCircle: {
      width: 34,
      height: 34,
      borderRadius: 17,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.primary + '18',
      borderWidth: 1,
      borderColor: colors.primary + '35',
    },
    eyebrow: { fontSize: 10, fontWeight: '900', color: colors.textMuted, textTransform: 'uppercase' },
    title: { ...typography.cardTitle, color: colors.textPrimary },
    bodyText: { fontSize: 12, lineHeight: 18, color: colors.textSecondary, marginBottom: 12 },
    countPill: {
      borderRadius: radius.full,
      borderWidth: 1,
      borderColor: colors.primary + '45',
      backgroundColor: colors.primary + '14',
      paddingHorizontal: 9,
      paddingVertical: 5,
    },
    countPillText: { fontSize: 10, fontWeight: '900', color: colors.primary },
    actionRow: { flexDirection: 'row', gap: 8 },
    actionButton: {
      flex: 1,
      minHeight: 40,
      borderRadius: radius.md,
      borderWidth: 1,
      alignItems: 'center',
      justifyContent: 'center',
      flexDirection: 'row',
      gap: 6,
      paddingHorizontal: 10,
    },
    actionButtonText: { fontSize: 12, fontWeight: '900' },
    loadingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 14 },
    mutedText: { fontSize: 12, color: colors.textMuted },
    labList: { marginTop: 14, borderTopWidth: 1, borderTopColor: colors.border + '66' },
    labRow: {
      minHeight: 58,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      borderBottomWidth: 1,
      borderBottomColor: colors.border + '55',
      paddingVertical: 9,
    },
    reviewRow: {
      minHeight: 58,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      borderBottomWidth: 1,
      borderBottomColor: colors.border + '55',
      paddingVertical: 10,
    },
    labName: { fontSize: 14, fontWeight: '900', color: colors.textPrimary },
    labMeta: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
    labValueWrap: { minWidth: 72, alignItems: 'flex-end' },
    labValue: { fontSize: 17, fontWeight: '900', color: colors.textPrimary },
    labUnit: { fontSize: 10, fontWeight: '700', color: colors.textMuted, marginTop: 1 },
    deleteButton: {
      width: 28,
      height: 28,
      borderRadius: 14,
      alignItems: 'center',
      justifyContent: 'center',
    },
    emptyState: { alignItems: 'center', paddingTop: 18, gap: 6 },
    emptyTitle: { fontSize: 14, fontWeight: '900', color: colors.textPrimary },
    emptyBody: { fontSize: 12, lineHeight: 17, color: colors.textMuted, textAlign: 'center' },
    modalBackdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.45)',
      justifyContent: 'flex-end',
      padding: 16,
    },
    sheet: {
      maxHeight: '86%',
      borderRadius: 20,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 16,
    },
    sheetHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
    sheetTitle: { fontSize: 18, fontWeight: '900', color: colors.textPrimary },
    sheetSubtitle: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
    fieldLabel: { fontSize: 11, fontWeight: '900', color: colors.textMuted, textTransform: 'uppercase', marginBottom: 6, marginTop: 10 },
    markerScroller: { gap: 8, paddingRight: 12, paddingBottom: 2 },
    markerChip: { borderRadius: radius.full, borderWidth: 1, paddingHorizontal: 11, paddingVertical: 8 },
    markerChipText: { fontSize: 12, fontWeight: '800' },
    fieldRow: { flexDirection: 'row', gap: 10 },
    input: {
      minHeight: 44,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surfaceRaised,
      color: colors.textPrimary,
      paddingHorizontal: 12,
      fontSize: 14,
      fontWeight: '700',
    },
    disclaimerText: { fontSize: 11, lineHeight: 16, color: colors.textMuted, marginTop: 12 },
    primarySheetButton: {
      minHeight: 44,
      marginTop: 14,
      borderRadius: radius.md,
      backgroundColor: colors.primary,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 14,
    },
    primarySheetButtonText: { fontSize: 14, fontWeight: '900' },
    sheetActionRow: { flexDirection: 'row', gap: 10, marginTop: 14 },
    secondarySheetButton: {
      minHeight: 44,
      borderRadius: radius.md,
      borderWidth: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 16,
    },
    secondarySheetButtonText: { fontSize: 14, fontWeight: '800', color: colors.textPrimary },
    warningRow: {
      flexDirection: 'row',
      gap: 7,
      alignItems: 'flex-start',
      paddingVertical: 7,
      borderBottomWidth: 1,
      borderBottomColor: colors.border + '44',
    },
    warningText: { flex: 1, fontSize: 11, lineHeight: 16, color: colors.textSecondary },
  });
}
