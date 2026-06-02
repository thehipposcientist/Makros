// Import-from-other-app screen.
//
// Lives inside Settings → "Import from another app." Flows:
//   1. MyFitnessPal — user uploads a CSV (90-day web export) or a ZIP
//      (GDPR data request, takes 1-7 days to arrive in their email).
//   2. Strong — user uploads a workout CSV from Settings → Export
//      inside the Strong app. Strong Pro feature.
//   3. FitNotes — user uploads a workout CSV from Spreadsheet Export.
//   4. Strava — OAuth handshake via WebBrowser; backend pulls the
//      historical activity feed once the user has connected.
//
// Each flow posts to the backend, then the screen polls
// /imports/{id}/status until status="complete" so the user sees real
// progress. History list at the bottom shows past imports + supports
// rollback per batch.

import { useCallback, useEffect, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, ActivityIndicator,
  StyleSheet, Modal, Alert, Linking, Platform, ImageBackground,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as WebBrowser from 'expo-web-browser';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getTheme, radius } from '../constants/theme';
import { STOCK_IMAGES } from '../constants/stockImages';
import { AppThemeName } from '../types';
import {
  ImportBatch, StrongImportPreview, getImportStatus, listImports,
  previewFitNotes, previewStrong, rollbackImport, stravaAuthorize, stravaBackfill,
  uploadFitNotes, uploadMyFitnessPal, uploadStrong,
} from '../services/imports';
import { getAppleHealthWorkouts, isHealthKitAvailable } from '../services/appleHealth';
import { completeWorkoutWithOfflineQueue } from '../utils/workoutCompletionQueue';
import { appleHealthMetricsFromWorkoutSession } from '../utils/workoutCompletion';
import { dateKey } from '../utils/workoutHistory';
import {
  detectUnloggedWorkouts, importCandidate, classifyActivity,
  type ImportCandidate,
} from '../utils/workoutAutoImport';

// Lazy reference so expo-document-picker doesn't load on cold-start —
// matches the existing expo-image-picker pattern.
let _DocPicker: typeof import('expo-document-picker') | null = null;
function getDocumentPicker(): typeof import('expo-document-picker') {
  if (!_DocPicker) _DocPicker = require('expo-document-picker');
  return _DocPicker!;
}


interface Props {
  visible: boolean;
  themeName?: AppThemeName;
  authToken: string;
  onClose: () => void;
  onImportIntent?: (source: string) => void;
  onImportComplete?: (source: string) => void;
}


type SourceKey = 'myfitnesspal' | 'strong' | 'fitnotes' | 'strava' | 'apple_health';

interface SourceConfig {
  key: SourceKey;
  label: string;
  blurb: string;
  icon: keyof typeof Ionicons.glyphMap;
  accentColor: string;
  exportInstructions: string[];
  exportUrl?: string;        // optional deep-link to the source app's data-export page
  flow: 'file' | 'oauth' | 'native';
  fileTypes?: string[];      // for DocumentPicker MIME filter
}

const ALL_SOURCES: SourceConfig[] = [
  {
    key: 'myfitnesspal',
    label: 'MyFitnessPal',
    blurb: 'Import meals and macros from MFP exports.',
    icon: 'nutrition-outline',
    accentColor: '#0066EE',
    exportInstructions: [
      'Open MyFitnessPal → More → Nutrition → Export, or use Reports → Export on the website.',
      'Choose the date range and export your information. MFP may require Premium for file export.',
      'Download the ZIP from the email MFP sends you.',
      'Upload the ZIP, or unzip it and upload the Nutrition CSV.',
    ],
    exportUrl: 'https://www.myfitnesspal.com/reports/export',
    flow: 'file',
    fileTypes: [
      'text/csv',
      'text/comma-separated-values',
      'application/csv',
      'application/vnd.ms-excel',
      'application/zip',
      'application/x-zip',
      'application/x-zip-compressed',
      'application/octet-stream',
      'public.comma-separated-values-text',
      'public.zip-archive',
      'com.pkware.zip-archive',
    ],
  },
  {
    key: 'strong',
    label: 'Strong',
    blurb: 'Import workout history, PRs, and set data.',
    icon: 'barbell-outline',
    accentColor: '#FF8800',
    exportInstructions: [
      'Open Strong → Profile → Settings → Export Workouts.',
      'Tap "Export to CSV" (requires Strong Pro).',
      'Share the CSV to Files, then tap "Choose file" below.',
    ],
    flow: 'file',
    fileTypes: [
      'text/csv',
      'text/comma-separated-values',
      'application/csv',
      'application/vnd.ms-excel',
      'public.comma-separated-values-text',
    ],
  },
  {
    key: 'fitnotes',
    label: 'FitNotes',
    blurb: 'Import logged sets, reps, weights, and cardio rows.',
    icon: 'reader-outline',
    accentColor: '#2FA84F',
    exportInstructions: [
      'Open FitNotes → Settings → Spreadsheet Export or Export CSV.',
      'Choose Workout Data, then save or share the CSV to Files.',
      'Tap "Choose file" below and select the FitNotes workout CSV.',
    ],
    flow: 'file',
    fileTypes: [
      'text/csv',
      'text/comma-separated-values',
      'application/csv',
      'application/vnd.ms-excel',
      'public.comma-separated-values-text',
    ],
  },
  {
    key: 'strava',
    label: 'Strava',
    blurb: 'Import runs, rides, and other endurance activities.',
    icon: 'walk-outline',
    accentColor: '#FC4C02',
    exportInstructions: [
      'Tap "Connect Strava" below to sign in and authorize.',
      "After Strava redirects you back, we'll automatically pull your last 180 days.",
    ],
    flow: 'oauth',
  },
  {
    key: 'apple_health',
    label: 'Apple Health',
    blurb: 'Backfill 180 days of cardio: runs, rides, walks, swims, and more.',
    icon: 'heart-outline',
    accentColor: '#FF3B30',
    exportInstructions: [
      'Make sure Apple Health permissions are granted (Settings → Health → Data Access → Thallo).',
      'Tap "Scan Apple Health" below to find cardio workouts from the last 180 days.',
      'Strength workouts are skipped — Apple Health stores them without set/rep data. Use the Strong import for strength history.',
    ],
    flow: 'native',
  },
];

const SOURCES: SourceConfig[] = ALL_SOURCES.filter(
  source => source.key !== 'apple_health' || Platform.OS === 'ios',
);


export default function ImportScreen({ visible, themeName, authToken, onClose, onImportIntent, onImportComplete }: Props) {
  const insets = useSafeAreaInsets();
  const tc = getTheme(themeName).colors;
  const [selected, setSelected] = useState<SourceKey | null>(null);
  const [busy, setBusy] = useState<SourceKey | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [history, setHistory] = useState<ImportBatch[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  // Workout CSV sources get a preview-then-confirm flow. When non-null,
  // the modal is visible. `fileUri` + `filename` are stashed so the
  // confirm button can upload without re-prompting.
  const [workoutPreview, setWorkoutPreview] = useState<{
    source: 'strong' | 'fitnotes';
    sourceLabel: string;
    accentColor: string;
    preview: StrongImportPreview;
    fileUri: string;
    filename: string;
  } | null>(null);
  const [workoutUploading, setWorkoutUploading] = useState(false);
  // Apple Health bulk-import state. `preview` non-null opens the preview
  // modal with the candidate list; `importing` blocks Cancel during the
  // batch loop. Progress (done/total) drives the running status line.
  const [applePreview, setApplePreview] = useState<{
    candidates: ImportCandidate[];
    selectedIds: string[];
    totalFound: number;
    skippedStrength: number;
    skippedDuplicates: number;
  } | null>(null);
  const [appleImporting, setAppleImporting] = useState(false);
  const [appleProgress, setAppleProgress] = useState({ done: 0, total: 0 });

  const refreshHistory = useCallback(async () => {
    if (!authToken) return;
    setHistoryLoading(true);
    try {
      const items = await listImports(authToken);
      setHistory(items);
    } catch (e: any) {
      // Silent — empty history is acceptable UX.
    } finally {
      setHistoryLoading(false);
    }
  }, [authToken]);

  useEffect(() => {
    if (visible) refreshHistory();
  }, [visible, refreshHistory]);

  // Poll an in-progress import until it lands in a terminal state.
  const pollUntilDone = useCallback(async (batchId: number) => {
    const maxAttempts = 60;  // 60 × 2s = up to 2 min
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const b = await getImportStatus(authToken, batchId);
        if (b.status === 'complete' || b.status === 'failed' || b.status === 'rolled_back') {
          return b;
        }
      } catch {
        // transient — keep polling
      }
    }
    return null;
  }, [authToken]);

  const handlePickAndUpload = useCallback(async (source: SourceConfig) => {
    if (source.flow !== 'file') return;
    setBusy(source.key);
    setStatusMessage(`Choosing ${source.label} file…`);
    try {
      const dp = getDocumentPicker();
      const result = await dp.getDocumentAsync({
        type: source.fileTypes,
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled || !result.assets?.length) {
        setStatusMessage(null);
        return;
      }
      const file = result.assets[0];
      const filename = file.name ?? 'upload.csv';
      onImportIntent?.(source.key);

      // Workout CSV sources get a preview-then-confirm step so the
      // user can verify parsed sessions before they commit. MFP keeps
      // its direct-upload behavior — diary import is line-by-line and
      // per-meal rollback is granular.
      if (source.key === 'strong' || source.key === 'fitnotes') {
        setStatusMessage(`Parsing ${filename}…`);
        const preview = source.key === 'strong'
          ? await previewStrong(authToken, file.uri, filename)
          : await previewFitNotes(authToken, file.uri, filename);
        setStatusMessage(null);
        setWorkoutPreview({
          source: source.key,
          sourceLabel: source.label,
          accentColor: source.accentColor,
          preview,
          fileUri: file.uri,
          filename,
        });
        return;
      }

      setStatusMessage(`Uploading ${filename}…`);
      let batch = await uploadMyFitnessPal(authToken, file.uri, filename);

      if (batch.status === 'processing') {
        setStatusMessage(`Processing ${batch.total_rows} rows…`);
        const finished = await pollUntilDone(batch.id);
        if (finished) batch = finished;
      }
      if (batch.status === 'complete') onImportComplete?.(source.key);
      setStatusMessage(_summarize(batch));
      refreshHistory();
    } catch (e: any) {
      Alert.alert('Import failed', String(e?.message ?? e));
      setStatusMessage(null);
    } finally {
      setBusy(null);
    }
  }, [authToken, onImportComplete, onImportIntent, pollUntilDone, refreshHistory]);

  const handleConfirmWorkoutImport = useCallback(async () => {
    if (!workoutPreview) return;
    const { source, fileUri, filename, preview } = workoutPreview;
    setWorkoutUploading(true);
    setBusy(source);
    setStatusMessage(`Importing ${preview.new_sessions} workouts…`);
    try {
      let batch = source === 'strong'
        ? await uploadStrong(authToken, fileUri, filename)
        : await uploadFitNotes(authToken, fileUri, filename);
      if (batch.status === 'processing') {
        const finished = await pollUntilDone(batch.id);
        if (finished) batch = finished;
      }
      if (batch.status === 'complete') onImportComplete?.(source);
      setStatusMessage(_summarize(batch));
      setWorkoutPreview(null);
      refreshHistory();
    } catch (e: any) {
      Alert.alert('Import failed', String(e?.message ?? e));
      setStatusMessage(null);
    } finally {
      setWorkoutUploading(false);
      setBusy(null);
    }
  }, [authToken, onImportComplete, pollUntilDone, refreshHistory, workoutPreview]);

  const handleCancelWorkoutPreview = useCallback(() => {
    if (workoutUploading) return;
    setWorkoutPreview(null);
    setStatusMessage(null);
  }, [workoutUploading]);

  const handleAppleHealthScan = useCallback(async () => {
    setBusy('apple_health');
    setStatusMessage('Reading Apple Health…');
    onImportIntent?.('apple_health');
    try {
      if (!isHealthKitAvailable()) {
        Alert.alert(
          'Apple Health not available',
          Platform.OS === 'ios'
            ? 'Apple Health permissions are required. Grant access in Settings → Health → Data Access → Thallo.'
            : 'Apple Health is only available on iOS.',
        );
        return;
      }
      const now = Date.now();
      const start = now - 180 * 86400000;
      const raw = await getAppleHealthWorkouts(start, now);
      if (raw.length === 0) {
        Alert.alert(
          'No workouts found',
          'Apple Health returned no workouts in the last 180 days. If you have data in Apple Health, double-check Thallo has read permission for Workouts.',
        );
        return;
      }
      // Dedupe against local history + dismissed list. Returns
      // candidates inside the lookback window already filtered.
      const allCandidates = await detectUnloggedWorkouts(raw as any[], 180);
      const skippedDuplicates = raw.length - allCandidates.length;
      // Cardio + mobility + sport only — HK strength has no set/rep
      // data, so importing the shell adds noise without info.
      let skippedStrength = 0;
      const cardioCandidates = allCandidates.filter(c => {
        const cat = classifyActivity(c.activityName).category;
        if (cat === 'strength') { skippedStrength += 1; return false; }
        return true;
      });
      setApplePreview({
        candidates: cardioCandidates,
        selectedIds: cardioCandidates.map(c => c.externalId),
        totalFound: raw.length,
        skippedStrength,
        skippedDuplicates,
      });
    } catch (e: any) {
      Alert.alert('Scan failed', String(e?.message ?? e));
    } finally {
      setBusy(null);
      setStatusMessage(null);
    }
  }, [onImportIntent]);

  const handleConfirmAppleHealthImport = useCallback(async () => {
    if (!applePreview || applePreview.candidates.length === 0) return;
    const selectedIds = new Set(applePreview.selectedIds);
    const candidates = applePreview.candidates.filter(c => selectedIds.has(c.externalId));
    if (candidates.length === 0) {
      Alert.alert('Pick workouts', 'Select at least one Apple Health workout to import.');
      return;
    }
    setAppleImporting(true);
    setBusy('apple_health');
    setAppleProgress({ done: 0, total: candidates.length });
    let imported = 0;
    let failed = 0;
    for (let i = 0; i < candidates.length; i++) {
      try {
        const session = await importCandidate(candidates[i]);
        const sessionDate = dateKey(new Date(session.date));
        await completeWorkoutWithOfflineQueue(
          authToken,
          {
            workout_date: sessionDate,
            focus_label: session.focus,
            duration_seconds: session.durationSeconds,
            activity: session.manualActivity ? {
              category: session.manualActivity.category,
              subtype: session.manualActivity.subtype,
              intensity: session.manualActivity.intensity,
              source: session.manualActivity.source,
              cardioStyle: session.manualActivity.cardioStyle,
              distanceMiles: session.manualActivity.distanceMiles,
              caloriesBurned: session.manualActivity.caloriesBurned,
              avgHeartRate: session.manualActivity.avgHeartRate,
              details: session.manualActivity.details,
              routeCoords: session.manualActivity.routeCoords,
            } : undefined,
            healthMetrics: appleHealthMetricsFromWorkoutSession(session),
            source: {
              sourceContext: 'apple_health',
              startedAt: session.startedAt ?? session.date,
              endedAt: session.endedAt ?? null,
              externalSourceId: session.id,
            },
          },
          session,
        ).catch(() => undefined);
        imported += 1;
      } catch {
        failed += 1;
      }
      setAppleProgress({ done: i + 1, total: candidates.length });
      setStatusMessage(`Importing ${i + 1} of ${candidates.length}…`);
    }
    setAppleImporting(false);
    setApplePreview(null);
    setBusy(null);
    setStatusMessage(
      `Imported ${imported} cardio workout${imported === 1 ? '' : 's'}` +
      (failed > 0 ? ` · ${failed} failed` : ''),
    );
    if (imported > 0) onImportComplete?.('apple_health');
    Alert.alert(
      'Apple Health import complete',
      `Imported ${imported} workout${imported === 1 ? '' : 's'}.` +
      (failed > 0 ? `\n${failed} failed — try scanning again.` : ''),
    );
  }, [applePreview, authToken, onImportComplete]);

  const handleCancelApplePreview = useCallback(() => {
    if (appleImporting) return;
    setApplePreview(null);
    setStatusMessage(null);
  }, [appleImporting]);

  const handleToggleAppleCandidate = useCallback((externalId: string) => {
    setApplePreview(prev => {
      if (!prev) return prev;
      const selected = new Set(prev.selectedIds);
      if (selected.has(externalId)) selected.delete(externalId);
      else selected.add(externalId);
      return { ...prev, selectedIds: Array.from(selected) };
    });
  }, []);

  const handleSetAllAppleCandidates = useCallback((selected: boolean) => {
    setApplePreview(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        selectedIds: selected ? prev.candidates.map(c => c.externalId) : [],
      };
    });
  }, []);

  const handleStravaConnect = useCallback(async () => {
    setBusy('strava');
    setStatusMessage('Opening Strava…');
    onImportIntent?.('strava');
    try {
      const { authorize_url } = await stravaAuthorize(authToken);
      // openAuthSessionAsync handles the post-OAuth redirect back into
      // our app via the `thallo://imports/strava` scheme registered in
      // app.json. The backend callback persists the token + 302s to
      // that scheme; the browser closes and control returns here.
      const result = await WebBrowser.openAuthSessionAsync(authorize_url, 'thallo://imports/strava');
      if (result.type !== 'success') {
        setStatusMessage(null);
        setBusy(null);
        return;
      }
      setStatusMessage('Connected — pulling activities…');
      let batch = await stravaBackfill(authToken, 180);
      if (batch.status === 'processing') {
        const finished = await pollUntilDone(batch.id);
        if (finished) batch = finished;
      }
      if (batch.status === 'complete') onImportComplete?.('strava');
      setStatusMessage(_summarize(batch));
      refreshHistory();
    } catch (e: any) {
      Alert.alert('Strava import failed', String(e?.message ?? e));
      setStatusMessage(null);
    } finally {
      setBusy(null);
    }
  }, [authToken, onImportComplete, onImportIntent, pollUntilDone, refreshHistory]);

  const handleRollback = useCallback(async (batch: ImportBatch) => {
    Alert.alert(
      'Undo this import?',
      `This removes ${batch.matched_rows + batch.ai_matched_rows + batch.fallback_rows} ${batch.data_type} entries from this import. You can't undo this action.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Undo Import',
          style: 'destructive',
          onPress: async () => {
            try {
              await rollbackImport(authToken, batch.id);
              refreshHistory();
            } catch (e: any) {
              Alert.alert('Couldn\'t undo', String(e?.message ?? e));
            }
          },
        },
      ],
    );
  }, [authToken, refreshHistory]);

  const selectedSource = SOURCES.find(s => s.key === selected) ?? null;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <View style={[styles.root, { backgroundColor: tc.background, paddingTop: insets.top }]}>
        {/* Header */}
        <View style={[styles.header, { borderBottomColor: tc.border }]}>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <Ionicons name="close" size={26} color={tc.textPrimary} />
          </TouchableOpacity>
          <Text style={[styles.title, { color: tc.textPrimary }]}>Import History</Text>
          <View style={{ width: 26 }} />
        </View>

        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 32 }}>
          {/* Intro */}
          <ImageBackground
            source={{ uri: STOCK_IMAGES.imports.hero }}
            style={styles.importHero}
            imageStyle={styles.importHeroImage}
          >
            <LinearGradient
              colors={['rgba(0,0,0,0.04)', 'rgba(0,0,0,0.58)']}
              style={styles.importHeroGradient}
            />
            <View style={styles.importHeroCopy}>
              <Text style={styles.importHeroTitle}>Bring history forward</Text>
              <Text style={styles.importHeroMeta}>Meals · workouts · weight · cardio</Text>
            </View>
          </ImageBackground>

          {/* Source picker */}
          <View style={{ gap: 10, marginTop: 18 }}>
            {SOURCES.map(s => (
              <TouchableOpacity
                key={s.key}
                style={[
                  styles.sourceRow,
                  {
                    backgroundColor: tc.surface,
                    borderColor: selected === s.key ? s.accentColor : tc.border,
                    borderWidth: selected === s.key ? 2 : 1,
                  },
                ]}
                onPress={() => setSelected(s.key === selected ? null : s.key)}
                activeOpacity={0.85}
              >
                <View style={[styles.sourceIcon, { backgroundColor: s.accentColor + '22' }]}>
                  <Ionicons name={s.icon} size={22} color={s.accentColor} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.sourceLabel, { color: tc.textPrimary }]}>{s.label}</Text>
                  <Text style={[styles.sourceBlurb, { color: tc.textMuted }]}>{s.blurb}</Text>
                </View>
                <Ionicons
                  name={selected === s.key ? 'chevron-up' : 'chevron-down'}
                  size={18}
                  color={tc.textMuted}
                />
              </TouchableOpacity>
            ))}
          </View>

          {/* Selected-source instructions + action */}
          {selectedSource && (
            <View style={[styles.actionPanel, { backgroundColor: tc.surface, borderColor: tc.border }]}>
              <Text style={[styles.actionTitle, { color: tc.textPrimary }]}>
                How to import from {selectedSource.label}
              </Text>
              {selectedSource.exportInstructions.map((step, i) => (
                <View key={i} style={styles.stepRow}>
                  <View style={[styles.stepBullet, { backgroundColor: selectedSource.accentColor + '33' }]}>
                    <Text style={[styles.stepBulletText, { color: selectedSource.accentColor }]}>{i + 1}</Text>
                  </View>
                  <Text style={[styles.stepText, { color: tc.textSecondary }]}>{step}</Text>
                </View>
              ))}

              {/* Open-source-app shortcut */}
              {selectedSource.exportUrl && (
                <TouchableOpacity
                  onPress={() => {
                    onImportIntent?.(selectedSource.key);
                    Linking.openURL(selectedSource.exportUrl!);
                  }}
                  style={[styles.linkBtn, { borderColor: tc.border }]}
                  activeOpacity={0.85}
                >
                  <Ionicons name="open-outline" size={16} color={tc.textSecondary} />
                  <Text style={[styles.linkBtnText, { color: tc.textSecondary }]}>
                    Open {selectedSource.label}
                  </Text>
                </TouchableOpacity>
              )}

              {/* Primary action */}
              <TouchableOpacity
                onPress={() => {
                  if (selectedSource.flow === 'oauth') return handleStravaConnect();
                  if (selectedSource.flow === 'native') return handleAppleHealthScan();
                  return handlePickAndUpload(selectedSource);
                }}
                style={[
                  styles.primaryBtn,
                  { backgroundColor: selectedSource.accentColor },
                  busy === selectedSource.key && { opacity: 0.7 },
                ]}
                disabled={busy === selectedSource.key}
                activeOpacity={0.85}
              >
                {busy === selectedSource.key ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <>
                    <Ionicons
                      name={
                        selectedSource.flow === 'oauth' ? 'link'
                        : selectedSource.flow === 'native' ? 'search-outline'
                        : 'cloud-upload-outline'
                      }
                      size={18}
                      color="#fff"
                    />
                    <Text style={styles.primaryBtnText}>
                      {selectedSource.flow === 'oauth' ? `Connect ${selectedSource.label}`
                        : selectedSource.flow === 'native' ? 'Scan Apple Health'
                        : 'Choose file…'}
                    </Text>
                  </>
                )}
              </TouchableOpacity>

              {statusMessage && busy === selectedSource.key && (
                <Text style={[styles.statusMsg, { color: tc.textMuted }]}>{statusMessage}</Text>
              )}
              {statusMessage && busy === null && (
                <Text style={[styles.statusMsg, { color: tc.textSecondary }]}>{statusMessage}</Text>
              )}
            </View>
          )}

          {/* History */}
          <Text style={[styles.sectionHeader, { color: tc.textSecondary }]}>Recent imports</Text>
          {historyLoading && history.length === 0 && (
            <View style={{ paddingVertical: 16, alignItems: 'center' }}>
              <ActivityIndicator color={tc.primary} />
            </View>
          )}
          {!historyLoading && history.length === 0 && (
            <View style={[styles.emptyState, { backgroundColor: tc.surface, borderColor: tc.border }]}>
              <ImageBackground
                source={{ uri: STOCK_IMAGES.imports.empty }}
                style={styles.emptyStateImage}
                imageStyle={styles.emptyStateImagePhoto}
              >
                <LinearGradient
                  colors={['rgba(0,0,0,0.02)', 'rgba(0,0,0,0.28)']}
                  style={styles.emptyStateImageGradient}
                />
              </ImageBackground>
              <Text style={{ color: tc.textMuted, fontSize: 13, textAlign: 'center' }}>
                No imports yet. Pick a source above to bring your history in.
              </Text>
            </View>
          )}
          {history.map(batch => (
            <View
              key={batch.id}
              style={[styles.historyRow, { backgroundColor: tc.surface, borderColor: tc.border }]}
            >
              <View style={{ flex: 1 }}>
                <Text style={[styles.historyLabel, { color: tc.textPrimary }]}>
                  {_sourceLabel(batch.source)}
                  {batch.filename ? ` · ${batch.filename}` : ''}
                </Text>
                <Text style={[styles.historyMeta, { color: tc.textMuted }]} numberOfLines={2}>
                  {_summarize(batch)}
                </Text>
                {_batchIssueText(batch) && (
                  <Text style={[styles.historyMeta, { color: tc.error }]} numberOfLines={2}>
                    {_batchIssueText(batch)}
                  </Text>
                )}
              </View>
              {batch.status === 'complete' && (
                <TouchableOpacity
                  onPress={() => handleRollback(batch)}
                  style={styles.undoBtn}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Text style={{ color: tc.error, fontSize: 12, fontWeight: '700' }}>Undo</Text>
                </TouchableOpacity>
              )}
            </View>
          ))}
        </ScrollView>

        <WorkoutPreviewModal
          state={workoutPreview}
          uploading={workoutUploading}
          themeName={themeName}
          onConfirm={handleConfirmWorkoutImport}
          onCancel={handleCancelWorkoutPreview}
        />

        <AppleHealthPreviewModal
          state={applePreview}
          importing={appleImporting}
          progress={appleProgress}
          themeName={themeName}
          onConfirm={handleConfirmAppleHealthImport}
          onCancel={handleCancelApplePreview}
          onToggleCandidate={handleToggleAppleCandidate}
          onSetAllCandidates={handleSetAllAppleCandidates}
        />
      </View>
    </Modal>
  );
}


function WorkoutPreviewModal({
  state, uploading, themeName, onConfirm, onCancel,
}: {
  state: {
    source: 'strong' | 'fitnotes';
    sourceLabel: string;
    accentColor: string;
    preview: StrongImportPreview;
    fileUri: string;
    filename: string;
  } | null;
  uploading: boolean;
  themeName?: AppThemeName;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const insets = useSafeAreaInsets();
  const tc = getTheme(themeName).colors;
  const visible = state !== null;
  const preview = state?.preview;
  const nothingNew = !preview || preview.new_sessions === 0;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={uploading ? () => {} : onCancel}
    >
      <View style={[styles.root, { backgroundColor: tc.background, paddingTop: insets.top }]}>
        <View style={[styles.header, { borderBottomColor: tc.border }]}>
          <TouchableOpacity
            onPress={onCancel}
            disabled={uploading}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          >
            <Ionicons name="close" size={26} color={uploading ? tc.textMuted : tc.textPrimary} />
          </TouchableOpacity>
          <Text style={[styles.title, { color: tc.textPrimary }]}>
            Review {state?.sourceLabel ?? 'Workout'} Import
          </Text>
          <View style={{ width: 26 }} />
        </View>

        <ScrollView
          contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 96 }}
          showsVerticalScrollIndicator={false}
        >
          {preview && (
            <>
              <View style={[styles.previewSummary, { backgroundColor: tc.surface, borderColor: tc.border }]}>
                <Text style={[styles.previewSummaryTitle, { color: tc.textPrimary }]}>
                  {preview.new_sessions} workout{preview.new_sessions === 1 ? '' : 's'} ready to import
                </Text>
                <Text style={[styles.previewSummaryBody, { color: tc.textSecondary }]}>
                  {preview.total_sets} total sets · {preview.matched_exercises} exercises matched · {preview.fallback_exercises} kept as raw names
                </Text>
                {preview.skipped_sessions > 0 && (
                  <Text style={[styles.previewSummaryBody, { color: tc.textMuted, marginTop: 4 }]}>
                    {preview.skipped_sessions} already imported · will be skipped
                  </Text>
                )}
                {preview.errors.length > 0 && (
                  <Text style={[styles.previewSummaryBody, { color: tc.error, marginTop: 4 }]}>
                    {preview.errors.length} row issue{preview.errors.length === 1 ? '' : 's'} — first: {preview.errors[0]?.message}
                  </Text>
                )}
              </View>

              <Text style={[styles.previewListHeader, { color: tc.textSecondary }]}>
                SESSIONS
              </Text>

              {preview.sessions.map((s, idx) => {
                const dateLabel = (() => {
                  const d = new Date(s.workout_date + 'T12:00:00Z');
                  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
                })();
                const durationLabel = s.duration_seconds
                  ? `${Math.round(s.duration_seconds / 60)} min`
                  : null;
                return (
                  <View
                    key={`${s.workout_date}-${s.workout_name}-${idx}`}
                    style={[
                      styles.previewSessionRow,
                      {
                        backgroundColor: s.already_imported ? tc.surface : tc.surfaceRaised,
                        borderColor: tc.border,
                        opacity: s.already_imported ? 0.55 : 1,
                      },
                    ]}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Text style={[styles.previewSessionTitle, { color: tc.textPrimary }]}>
                        {s.workout_name ?? 'Untitled workout'}
                      </Text>
                      {s.already_imported && (
                        <View style={{ backgroundColor: tc.surfaceRaised, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4, borderWidth: 1, borderColor: tc.border }}>
                          <Text style={{ fontSize: 9, fontWeight: '700', color: tc.textMuted }}>ALREADY IMPORTED</Text>
                        </View>
                      )}
                    </View>
                    <Text style={[styles.previewSessionMeta, { color: tc.textMuted }]}>
                      {dateLabel}
                      {durationLabel ? ` · ${durationLabel}` : ''}
                      {` · ${s.exercise_count} exercise${s.exercise_count === 1 ? '' : 's'}`}
                      {` · ${s.set_count} set${s.set_count === 1 ? '' : 's'}`}
                    </Text>
                    {s.fallback_exercises > 0 && (
                      <Text style={[styles.previewSessionMeta, { color: tc.textMuted, marginTop: 2 }]}>
                        {s.fallback_exercises} unmatched: {s.exercises.filter(e => !e.matched_name).map(e => e.raw_name).join(', ')}
                      </Text>
                    )}
                  </View>
                );
              })}
            </>
          )}
        </ScrollView>

        {/* Sticky action bar */}
        <View style={[styles.previewActions, { backgroundColor: tc.background, borderTopColor: tc.border, paddingBottom: Math.max(insets.bottom, 12) }]}>
          <TouchableOpacity
            onPress={onCancel}
            disabled={uploading}
            style={[styles.previewSecondaryBtn, { borderColor: tc.border }]}
            activeOpacity={0.85}
          >
            <Text style={{ fontSize: 14, fontWeight: '700', color: tc.textSecondary }}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={onConfirm}
            disabled={uploading || nothingNew}
            style={[styles.previewPrimaryBtn, { backgroundColor: state?.accentColor ?? '#FF8800' }, (uploading || nothingNew) && { opacity: 0.6 }]}
            activeOpacity={0.85}
          >
            {uploading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.primaryBtnText}>
                {nothingNew ? 'Nothing to import' : `Import ${preview?.new_sessions ?? 0} workout${preview?.new_sessions === 1 ? '' : 's'}`}
              </Text>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}


function AppleHealthPreviewModal({
  state, importing, progress, themeName, onConfirm, onCancel, onToggleCandidate, onSetAllCandidates,
}: {
  state: {
    candidates: ImportCandidate[];
    selectedIds: string[];
    totalFound: number;
    skippedStrength: number;
    skippedDuplicates: number;
  } | null;
  importing: boolean;
  progress: { done: number; total: number };
  themeName?: AppThemeName;
  onConfirm: () => void;
  onCancel: () => void;
  onToggleCandidate: (externalId: string) => void;
  onSetAllCandidates: (selected: boolean) => void;
}) {
  const insets = useSafeAreaInsets();
  const tc = getTheme(themeName).colors;
  const visible = state !== null;
  const nothingNew = !state || state.candidates.length === 0;
  const importCount = state?.candidates.length ?? 0;
  const selectedSet = new Set(state?.selectedIds ?? []);
  const selectedCount = state?.candidates.filter(c => selectedSet.has(c.externalId)).length ?? 0;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={importing ? () => {} : onCancel}
    >
      <View style={[styles.root, { backgroundColor: tc.background, paddingTop: insets.top }]}>
        <View style={[styles.header, { borderBottomColor: tc.border }]}>
          <TouchableOpacity
            onPress={onCancel}
            disabled={importing}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          >
            <Ionicons name="close" size={26} color={importing ? tc.textMuted : tc.textPrimary} />
          </TouchableOpacity>
          <Text style={[styles.title, { color: tc.textPrimary }]}>Review Apple Health Import</Text>
          <View style={{ width: 26 }} />
        </View>

        <ScrollView
          contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 96 }}
          showsVerticalScrollIndicator={false}
        >
          {state && (
            <>
              <View style={[styles.previewSummary, { backgroundColor: tc.surface, borderColor: tc.border }]}>
                <Text style={[styles.previewSummaryTitle, { color: tc.textPrimary }]}>
                  {selectedCount} of {importCount} workout{importCount === 1 ? '' : 's'} selected
                </Text>
                <Text style={[styles.previewSummaryBody, { color: tc.textSecondary }]}>
                  {state.totalFound} found in last 180 days
                </Text>
                {state.skippedDuplicates > 0 && (
                  <Text style={[styles.previewSummaryBody, { color: tc.textMuted, marginTop: 4 }]}>
                    {state.skippedDuplicates} already in Thallo · skipped
                  </Text>
                )}
                {state.skippedStrength > 0 && (
                  <Text style={[styles.previewSummaryBody, { color: tc.textMuted, marginTop: 4 }]}>
                    {state.skippedStrength} strength workout{state.skippedStrength === 1 ? '' : 's'} · skipped (no set data in Apple Health)
                  </Text>
                )}
                {importing && (
                  <Text style={[styles.previewSummaryBody, { color: tc.primary, marginTop: 6, fontWeight: '700' }]}>
                    Importing {progress.done} of {progress.total}…
                  </Text>
                )}
              </View>

              <Text style={[styles.previewListHeader, { color: tc.textSecondary }]}>
                WORKOUTS
              </Text>
              {state.candidates.length > 0 && (
                <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
                  <TouchableOpacity
                    onPress={() => onSetAllCandidates(true)}
                    disabled={importing || selectedCount === importCount}
                    style={[styles.previewPickerBtn, { borderColor: tc.border }, (importing || selectedCount === importCount) && { opacity: 0.5 }]}
                    activeOpacity={0.82}
                  >
                    <Text style={{ fontSize: 12, fontWeight: '800', color: tc.textSecondary }}>Select all</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => onSetAllCandidates(false)}
                    disabled={importing || selectedCount === 0}
                    style={[styles.previewPickerBtn, { borderColor: tc.border }, (importing || selectedCount === 0) && { opacity: 0.5 }]}
                    activeOpacity={0.82}
                  >
                    <Text style={{ fontSize: 12, fontWeight: '800', color: tc.textSecondary }}>Clear</Text>
                  </TouchableOpacity>
                </View>
              )}

              {state.candidates.map((c, idx) => {
                const dateLabel = (() => {
                  try {
                    const d = new Date(c.startDate);
                    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
                  } catch { return c.startDate; }
                })();
                const guess = classifyActivity(c.activityName);
                const distancePart = c.distanceMiles ? ` · ${c.distanceMiles.toFixed(1)} mi` : '';
                const caloriePart = c.calories ? ` · ${Math.round(c.calories)} cal` : '';
                const selected = selectedSet.has(c.externalId);
                return (
                  <TouchableOpacity
                    key={`${c.externalId}-${idx}`}
                    onPress={() => {
                      if (!importing) onToggleCandidate(c.externalId);
                    }}
                    activeOpacity={0.82}
                    style={[
                      styles.previewSessionRow,
                      { backgroundColor: tc.surfaceRaised, borderColor: selected ? '#FF3B30AA' : tc.border },
                    ]}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
                      <Ionicons
                        name={selected ? 'checkmark-circle' : 'ellipse-outline'}
                        size={21}
                        color={selected ? '#FF3B30' : tc.textMuted}
                        style={{ marginTop: 1 }}
                      />
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                          <Text style={[styles.previewSessionTitle, { color: tc.textPrimary, flex: 1 }]} numberOfLines={1}>
                            {c.activityName || 'Workout'}
                          </Text>
                          <View style={{ backgroundColor: '#FF3B3022', paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4 }}>
                            <Text style={{ fontSize: 9, fontWeight: '700', color: '#FF3B30', textTransform: 'uppercase' }}>
                              {guess.subtype}
                            </Text>
                          </View>
                        </View>
                        <Text style={[styles.previewSessionMeta, { color: tc.textMuted }]}>
                          {dateLabel} · {c.durationMin} min{distancePart}{caloriePart}
                        </Text>
                      </View>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </>
          )}
        </ScrollView>

        <View style={[styles.previewActions, { backgroundColor: tc.background, borderTopColor: tc.border, paddingBottom: Math.max(insets.bottom, 12) }]}>
          <TouchableOpacity
            onPress={onCancel}
            disabled={importing}
            style={[styles.previewSecondaryBtn, { borderColor: tc.border }]}
            activeOpacity={0.85}
          >
            <Text style={{ fontSize: 14, fontWeight: '700', color: tc.textSecondary }}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={onConfirm}
            disabled={importing || nothingNew || selectedCount === 0}
            style={[styles.previewPrimaryBtn, { backgroundColor: '#FF3B30' }, (importing || nothingNew || selectedCount === 0) && { opacity: 0.6 }]}
            activeOpacity={0.85}
          >
            {importing ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.primaryBtnText}>
                {nothingNew ? 'Nothing to import' : selectedCount === 0 ? 'Pick workouts' : `Import ${selectedCount} workout${selectedCount === 1 ? '' : 's'}`}
              </Text>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}


function _sourceLabel(source: ImportBatch['source']): string {
  switch (source) {
    case 'myfitnesspal': return 'MyFitnessPal';
    case 'strong':       return 'Strong';
    case 'fitnotes':     return 'FitNotes';
    case 'strava':       return 'Strava';
    case 'cronometer':   return 'Cronometer';
    case 'hevy':         return 'Hevy';
    case 'csv':          return 'CSV';
    default:             return String(source);
  }
}


function _summarize(batch: ImportBatch): string {
  if (batch.status === 'processing') return `Processing ${batch.total_rows || 0} rows…`;
  if (batch.status === 'failed') {
    return `Import failed — ${_friendlyImportError(batch.errors[0]?.message)}`;
  }
  if (batch.status === 'rolled_back') return 'Rolled back.';
  const imported = batch.matched_rows + batch.ai_matched_rows + batch.fallback_rows;
  const matched = batch.matched_rows + batch.ai_matched_rows;
  const verb = batch.data_type === 'workouts' ? 'workouts' : 'meals';
  if (imported === 0 && batch.total_rows === 0) return 'No new rows.';
  return `Imported ${imported} ${verb} (${matched} matched, ${batch.fallback_rows} kept raw).`;
}


function _batchIssueText(batch: ImportBatch): string | null {
  if (!batch.errors?.length || batch.status === 'failed') return null;
  return `${batch.errors.length} row issue${batch.errors.length === 1 ? '' : 's'} — first: ${batch.errors[0]?.message}`;
}


function _friendlyImportError(message?: string): string {
  const raw = String(message || '').replace(/^orchestrator:\s*/i, '').trim();
  if (!raw) return 'try again.';
  if (/uq_exercise_set_number|workout_exercise_id, set_number/i.test(raw)) {
    return 'duplicate set numbers hit an older importer. Re-upload the file; workouts already in Thallo will be skipped.';
  }
  if (/duplicate key value/i.test(raw)) {
    return 'some records already exist in Thallo. Re-uploading is safe; duplicates are skipped when possible.';
  }
  return raw;
}


const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1,
  },
  title: { fontSize: 17, fontWeight: '800' },
  intro: { fontSize: 13, lineHeight: 19 },
  importHero: {
    height: 138,
    borderRadius: radius.lg,
    overflow: 'hidden',
    justifyContent: 'flex-end',
  },
  importHeroImage: { borderRadius: radius.lg },
  importHeroGradient: { ...StyleSheet.absoluteFillObject },
  importHeroCopy: { padding: 14 },
  importHeroTitle: { color: '#fff', fontSize: 20, fontWeight: '900' },
  importHeroMeta: { color: '#fff', fontSize: 12, fontWeight: '800', marginTop: 3, opacity: 0.88 },
  sourceRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    padding: 14, borderRadius: radius.lg, borderWidth: 1,
  },
  sourceIcon: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
  },
  sourceLabel: { fontSize: 15, fontWeight: '700' },
  sourceBlurb: { fontSize: 12, marginTop: 2 },
  actionPanel: {
    marginTop: 16, padding: 16, borderRadius: radius.lg, borderWidth: 1,
    gap: 12,
  },
  actionTitle: { fontSize: 14, fontWeight: '800', marginBottom: 4 },
  stepRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  stepBullet: {
    width: 22, height: 22, borderRadius: 11,
    alignItems: 'center', justifyContent: 'center',
    marginTop: 1,
  },
  stepBulletText: { fontSize: 11, fontWeight: '800' },
  stepText: { flex: 1, fontSize: 13, lineHeight: 19 },
  linkBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, paddingVertical: 10, borderRadius: radius.md, borderWidth: 1,
  },
  linkBtnText: { fontSize: 12, fontWeight: '700' },
  primaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, paddingVertical: 14, borderRadius: radius.md,
  },
  primaryBtnText: { color: '#fff', fontSize: 14, fontWeight: '800' },
  statusMsg: { fontSize: 12, textAlign: 'center', fontWeight: '600' },
  sectionHeader: {
    marginTop: 28, marginBottom: 10, fontSize: 11,
    fontWeight: '800', letterSpacing: 0.7,
  },
  emptyState: {
    padding: 24, borderRadius: radius.lg, borderWidth: 1,
  },
  emptyStateImage: {
    height: 116,
    borderRadius: radius.md,
    overflow: 'hidden',
    marginBottom: 14,
  },
  emptyStateImagePhoto: { borderRadius: radius.md },
  emptyStateImageGradient: { ...StyleSheet.absoluteFillObject },
  historyRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    padding: 12, marginBottom: 8, borderRadius: radius.md, borderWidth: 1,
  },
  historyLabel: { fontSize: 13, fontWeight: '700' },
  historyMeta: { fontSize: 11, marginTop: 2, lineHeight: 15 },
  undoBtn: { paddingHorizontal: 8, paddingVertical: 6 },
  // Strong preview modal
  previewSummary: {
    padding: 14, borderRadius: radius.lg, borderWidth: 1, marginBottom: 18,
  },
  previewSummaryTitle: { fontSize: 15, fontWeight: '800' },
  previewSummaryBody: { fontSize: 12, marginTop: 4, lineHeight: 17 },
  previewListHeader: {
    marginTop: 6, marginBottom: 10, fontSize: 11,
    fontWeight: '800', letterSpacing: 0.7,
  },
  previewPickerBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 9,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  previewSessionRow: {
    padding: 12, marginBottom: 8, borderRadius: radius.md, borderWidth: 1,
  },
  previewSessionTitle: { fontSize: 13, fontWeight: '700', flexShrink: 1 },
  previewSessionMeta: { fontSize: 11, marginTop: 2, lineHeight: 15 },
  previewActions: {
    flexDirection: 'row', gap: 10,
    paddingHorizontal: 16, paddingTop: 12,
    borderTopWidth: 1,
  },
  previewSecondaryBtn: {
    flex: 1,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: 14, borderRadius: radius.md, borderWidth: 1,
  },
  previewPrimaryBtn: {
    flex: 2,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: 14, borderRadius: radius.md,
  },
});
