import { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Modal,
  Alert,
  ActivityIndicator,
  StyleSheet,
  Image,
  ImageBackground,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { DEFAULT_THEME_NAME, getContrastingTextColor, getTheme, radius } from '../constants/theme';
import { AppThemeName } from '../types';
import { formatDistance, unitToMi, type DistanceUnit } from '../utils/units';
import { STOCK_IMAGES, gearStockImageUri } from '../constants/stockImages';
import {
  listGear,
  addGear,
  updateGear,
  deleteGear,
  logGearMiles,
  identifyGear,
  GearItem,
  GearItemCreate,
} from '../services/api';

// ─── Constants ────────────────────────────────────────────────────────────────

const GEAR_TYPES: { value: string; label: string; icon: string; defaultKeywords: string[] }[] = [
  // Cardio / running / cycling — primary mile-tracked items.
  { value: 'running_shoe',   label: 'Running Shoes',   icon: 'walk-outline',       defaultKeywords: ['run', 'treadmill', 'jog', 'walk'] },
  { value: 'trail_shoe',     label: 'Trail Shoes',     icon: 'trail-sign-outline', defaultKeywords: ['trail run', 'hike', 'walk'] },
  { value: 'cycling_shoe',   label: 'Cycling Shoes',   icon: 'bicycle-outline',    defaultKeywords: ['cycling', 'spin', 'bike'] },
  { value: 'bike',           label: 'Bike',            icon: 'bicycle-outline',    defaultKeywords: ['cycling', 'spin', 'bike', 'road bike'] },
  { value: 'stationary_bike', label: 'Stationary Bike', icon: 'bicycle-outline',   defaultKeywords: ['stationary bike', 'indoor bike', 'spin', 'bike zone 2', 'bike'] },
  { value: 'bike_tire',      label: 'Bike Tire',       icon: 'ellipse-outline',    defaultKeywords: ['cycling', 'spin', 'bike'] },
  { value: 'bike_chain',     label: 'Bike Chain',      icon: 'link-outline',       defaultKeywords: ['cycling', 'spin', 'bike'] },
  { value: 'treadmill_belt', label: 'Treadmill Belt',  icon: 'fitness-outline',    defaultKeywords: ['treadmill', 'run', 'walk'] },
  { value: 'jump_rope',      label: 'Jump Rope',       icon: 'infinite-outline',   defaultKeywords: ['jump rope', 'cardio'] },
  // Lifting accessories — session-tracked. Keywords match exercise names
  // and focus labels (e.g. "Back Squat", "Romanian Deadlift", "Legs").
  { value: 'lifting_shoe',   label: 'Lifting Shoes',   icon: 'footsteps-outline',  defaultKeywords: ['squat', 'deadlift', 'snatch', 'clean', 'olympic'] },
  { value: 'lifting_belt',   label: 'Lifting Belt',    icon: 'shield-half-outline', defaultKeywords: ['squat', 'deadlift'] },
  { value: 'knee_sleeves',   label: 'Knee Sleeves',    icon: 'bandage-outline',    defaultKeywords: ['squat', 'lunge', 'leg'] },
  { value: 'wrist_wraps',    label: 'Wrist Wraps',     icon: 'medkit-outline',     defaultKeywords: ['bench', 'press', 'overhead', 'push'] },
  { value: 'lifting_straps', label: 'Lifting Straps',  icon: 'git-branch-outline', defaultKeywords: ['deadlift', 'row', 'pull-up', 'pull', 'shrug'] },
  // Recovery / specialty — session-tracked.
  { value: 'chest_strap',    label: 'HR Chest Strap',  icon: 'heart-outline',      defaultKeywords: ['cardio', 'run', 'cycling', 'spin', 'bike'] },
  { value: 'yoga_mat',       label: 'Yoga Mat',        icon: 'leaf-outline',       defaultKeywords: ['yoga', 'pilates', 'stretch', 'mobility'] },
  { value: 'climbing_shoe',  label: 'Climbing Shoes',  icon: 'triangle-outline',   defaultKeywords: ['climb', 'bouldering'] },
  { value: 'resistance_band',label: 'Resistance Bands',icon: 'options-outline',    defaultKeywords: ['band', 'mobility', 'warmup'] },
  { value: 'foam_roller',    label: 'Foam Roller',     icon: 'remove-outline',     defaultKeywords: ['mobility', 'recovery', 'foam'] },
  { value: 'massage_gun',    label: 'Massage Gun',     icon: 'flash-outline',      defaultKeywords: ['recovery'] },
  { value: 'boxing_gloves',  label: 'Boxing Gloves',   icon: 'hand-right-outline', defaultKeywords: ['box', 'kickbox', 'martial'] },
  { value: 'other',          label: 'Other',           icon: 'cube-outline',       defaultKeywords: [] },
];

const DEFAULT_THRESHOLDS: Record<string, number | null> = {
  running_shoe:    400,
  trail_shoe:      350,
  cycling_shoe:    null,
  bike:            null,
  stationary_bike: null,
  bike_tire:       2000,
  bike_chain:      1500,
  treadmill_belt:  3000,
  jump_rope:       null,
  lifting_shoe:    null,
  lifting_belt:    null,
  knee_sleeves:    null,
  wrist_wraps:     null,
  lifting_straps:  null,
  chest_strap:     null,
  yoga_mat:        null,
  climbing_shoe:   null,
  resistance_band: null,
  foam_roller:     null,
  massage_gun:     null,
  boxing_gloves:   null,
  other:           null,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getMileageColor(pct: number | null): string {
  if (pct === null) return '#60A5FA';
  if (pct >= 1.0)  return '#EF4444';
  if (pct >= 0.85) return '#F97316';
  if (pct >= 0.65) return '#FBBF24';
  return '#34D399';
}

function gearTypeInfo(type: string) {
  return GEAR_TYPES.find(g => g.value === type) ?? GEAR_TYPES[GEAR_TYPES.length - 1];
}

// Gear types whose wear is meaningfully measured in miles (cardio shoes,
// bikes, drivetrain, treadmill belts). Everything else — lifting accessories,
// recovery tools, boxing gloves, yoga mats — is session-tracked. UI hides
// mileage controls + stats for session-only gear so they don't read as
// "0.0 total mi."
const MILE_TRACKED_TYPES = new Set([
  'running_shoe', 'trail_shoe',
  'bike', 'bike_tire', 'bike_chain',
  'treadmill_belt',
]);
function isMileTracked(gearType: string): boolean {
  return MILE_TRACKED_TYPES.has(gearType);
}

// Default session-based wear estimates for gear that does eventually wear
// out by use rather than miles. Empty for indestructible items (yoga mat,
// foam roller, lifting belt) so the UI stays clean — users can still set a
// custom threshold if they want one.
const DEFAULT_SESSION_THRESHOLDS: Record<string, number | null> = {
  cycling_shoe:    300,
  jump_rope:       500,
  lifting_shoe:    400,
  knee_sleeves:    200,
  wrist_wraps:     200,
  lifting_straps:  300,
  climbing_shoe:   150,
  resistance_band: 200,
  boxing_gloves:   150,
};

// "Last used 3 days ago" — converts an ISO timestamp to a short relative
// hint for the gear card. Returns null when ts is missing.
function formatLastUsed(iso: string | null): string | null {
  if (!iso) return null;
  const then = new Date(iso);
  if (isNaN(then.getTime())) return null;
  const days = Math.floor((Date.now() - then.getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 30) {
    const weeks = Math.floor(days / 7);
    return `${weeks} week${weeks !== 1 ? 's' : ''} ago`;
  }
  if (days < 365) {
    const months = Math.floor(days / 30);
    return `${months} month${months !== 1 ? 's' : ''} ago`;
  }
  const years = Math.floor(days / 365);
  return `${years} year${years !== 1 ? 's' : ''} ago`;
}

function daysSinceLastUsed(iso: string | null): number | null {
  if (!iso) return null;
  const then = new Date(iso);
  if (isNaN(then.getTime())) return null;
  return Math.floor((Date.now() - then.getTime()) / 86_400_000);
}

// ─── Mileage progress bar ─────────────────────────────────────────────────────

function MileageBar({ pct, color }: { pct: number | null; color: string }) {
  if (pct === null) return null;
  const fill = Math.min(1, pct);
  return (
    <View style={{ height: 6, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 3, marginTop: 6 }}>
      <View style={{ height: 6, width: `${fill * 100}%` as any, backgroundColor: color, borderRadius: 3 }} />
    </View>
  );
}

function GearHero() {
  return (
    <ImageBackground
      source={{ uri: STOCK_IMAGES.gear.hero }}
      style={styles.gearHero}
      imageStyle={styles.gearHeroImage}
    >
      <LinearGradient
        colors={['rgba(0,0,0,0.06)', 'rgba(0,0,0,0.58)']}
        style={styles.gearHeroGradient}
      />
      <View style={styles.gearHeroCopy}>
        <Text style={styles.gearHeroTitle}>Gear status</Text>
        <Text style={styles.gearHeroMeta}>Wear signals · rotations · maintenance</Text>
      </View>
    </ImageBackground>
  );
}

function GearInsightPanel({
  gear,
  tc,
  distanceUnit,
}: {
  gear: GearItem[];
  tc: ReturnType<typeof getTheme>['colors'];
  distanceUnit: DistanceUnit;
}) {
  if (gear.length === 0) return null;
  const active = gear.filter(item => item.is_active !== false);
  const nearRetirement = active.filter(item => item.pct_used != null && item.pct_used >= 0.85);
  const watchList = active.filter(item => item.pct_used != null && item.pct_used >= 0.65 && item.pct_used < 0.85);
  const stale = active.filter(item => {
    const days = daysSinceLastUsed(item.last_used_at);
    return days != null && days >= 45;
  });
  const mileTracked = active.filter(item => isMileTracked(item.gear_type));
  const totalMiles = mileTracked.reduce((sum, item) => sum + item.total_miles, 0);
  const totalSessions = active.reduce((sum, item) => sum + item.accumulated_sessions, 0);
  const primaryAlert = nearRetirement[0] ?? watchList[0] ?? null;

  const insightRows = [
    {
      key: 'lifecycle',
      icon: nearRetirement.length ? 'warning-outline' : 'shield-checkmark-outline',
      color: nearRetirement.length ? '#F97316' : tc.primary,
      title: nearRetirement.length
        ? `${nearRetirement.length} item${nearRetirement.length === 1 ? '' : 's'} near retirement`
        : watchList.length
          ? `${watchList.length} item${watchList.length === 1 ? '' : 's'} on the watch list`
          : 'Lifecycle looks clean',
      detail: primaryAlert?.recommendation ?? 'Thresholds are comfortably below alert levels.',
    },
    {
      key: 'load',
      icon: 'analytics-outline',
      color: tc.primary,
      title: `${formatDistance(totalMiles, distanceUnit)} tracked · ${totalSessions} session${totalSessions === 1 ? '' : 's'}`,
      detail: mileTracked.length > 1
        ? 'Rotate mile-tracked gear to spread wear across shoes, bikes, and tires.'
        : 'Add a second pair or bike part when rotation matters for your training.',
    },
    {
      key: 'signal',
      icon: stale.length ? 'time-outline' : 'trending-up-outline',
      color: stale.length ? '#F59E0B' : '#22C55E',
      title: stale.length ? `${stale.length} item${stale.length === 1 ? '' : 's'} not used recently` : 'Session signals are current',
      detail: stale.length
        ? `${stale[0].name} last appeared ${formatLastUsed(stale[0].last_used_at)}. Archive or update keywords if that is wrong.`
        : 'Usage is fresh enough to catch maintenance and performance patterns after workouts.',
    },
  ];

  return (
    <View style={[styles.insightPanel, { backgroundColor: tc.surface, borderColor: tc.border }]}>
      <View style={styles.insightHeader}>
        <Ionicons name="sparkles-outline" size={16} color={tc.primary} />
        <Text style={[styles.insightTitle, { color: tc.textPrimary }]}>Lifecycle Insights</Text>
      </View>
      {insightRows.map(row => (
        <View
          key={row.key}
          style={styles.insightRow}
          accessible
          accessibilityLabel={`${row.title}. ${row.detail}`}
        >
          <View style={[styles.insightIcon, { backgroundColor: row.color + '1F' }]}>
            <Ionicons name={row.icon as any} size={15} color={row.color} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[styles.insightRowTitle, { color: tc.textPrimary }]}>{row.title}</Text>
            <Text style={[styles.insightRowDetail, { color: tc.textSecondary }]}>{row.detail}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

// ─── Gear card ─────────────────────────────────────────────────────────────────

function GearCard({
  item,
  tc,
  distanceUnit,
  onEdit,
  onLogMiles,
  onDelete,
}: {
  item: GearItem;
  tc: ReturnType<typeof getTheme>['colors'];
  distanceUnit: DistanceUnit;
  onEdit: () => void;
  onLogMiles: () => void;
  onDelete: () => void;
}) {
  const info = gearTypeInfo(item.gear_type);
  const color = getMileageColor(item.pct_used);
  const pctLabel = item.pct_used !== null ? `${Math.round(item.pct_used * 100)}%` : null;
  const hasPhotos = !!item.photos?.length;

  return (
    <View style={[styles.card, { backgroundColor: tc.surface, borderColor: tc.border }]}>
      {!hasPhotos && (
        <ImageBackground
          source={{ uri: gearStockImageUri(item.gear_type) }}
          style={styles.gearStockImage}
          imageStyle={styles.gearStockImagePhoto}
        >
          <LinearGradient
            colors={['rgba(0,0,0,0.01)', 'rgba(0,0,0,0.26)']}
            style={styles.gearStockGradient}
          />
        </ImageBackground>
      )}

      <View style={styles.cardHeader}>
        <View style={[styles.gearIcon, { backgroundColor: color + '22' }]}>
          <Ionicons name={info.icon as any} size={22} color={color} />
        </View>
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text style={[styles.gearName, { color: tc.textPrimary }]}>{item.name}</Text>
          <Text style={[styles.gearType, { color: tc.textSecondary }]}>{info.label}</Text>
        </View>
        <View style={styles.cardActions}>
          <TouchableOpacity onPress={onLogMiles} style={styles.actionBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityRole="button" accessibilityLabel={`Log usage for ${item.name}`}>
            <Ionicons name="add-circle-outline" size={22} color={tc.primary} />
          </TouchableOpacity>
          <TouchableOpacity onPress={onEdit} style={styles.actionBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityRole="button" accessibilityLabel={`Edit ${item.name}`}>
            <Ionicons name="pencil-outline" size={20} color={tc.textSecondary} />
          </TouchableOpacity>
          <TouchableOpacity onPress={onDelete} style={styles.actionBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityRole="button" accessibilityLabel={`Delete ${item.name}`}>
            <Ionicons name="trash-outline" size={18} color={tc.textMuted} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Photo strip — shown when the item has reference photos */}
      {hasPhotos && (
        <View style={{ flexDirection: 'row', gap: 6, marginTop: 10 }}>
          {item.photos.slice(0, 4).map((uri, idx) => (
            <Image
              key={idx}
              source={{ uri }}
              style={{ width: 56, height: 56, borderRadius: 8, backgroundColor: color + '11' }}
              resizeMode="cover"
            />
          ))}
        </View>
      )}

      <View style={styles.statsRow}>
        {isMileTracked(item.gear_type) && (
          <View style={styles.stat}>
            <Text style={[styles.statValue, { color: tc.textPrimary }]}>{formatDistance(item.total_miles, distanceUnit, { suffix: false })}</Text>
            <Text style={[styles.statLabel, { color: tc.textSecondary }]}>total {distanceUnit}</Text>
          </View>
        )}
        <View style={styles.stat}>
          <Text style={[styles.statValue, { color: tc.textPrimary }]}>{item.accumulated_sessions}</Text>
          <Text style={[styles.statLabel, { color: tc.textSecondary }]}>sessions</Text>
        </View>
        {item.pct_used !== null ? (
          <View style={styles.stat}>
            <Text style={[styles.statValue, { color }]}>{pctLabel}</Text>
            <Text style={[styles.statLabel, { color: tc.textSecondary }]}>used</Text>
          </View>
        ) : null}
        {(() => {
          const lastUsed = formatLastUsed(item.last_used_at);
          if (!lastUsed) return null;
          return (
            <View style={styles.stat}>
              <Text style={[styles.statValue, { color: tc.textPrimary, fontSize: 13 }]}>{lastUsed}</Text>
              <Text style={[styles.statLabel, { color: tc.textSecondary }]}>last used</Text>
            </View>
          );
        })()}
      </View>

      {/* Wear progress bar — shown for both mile-tracked and session-tracked
          gear once a threshold is set. pct_used is computed by the backend
          off whichever metric applies. */}
      {item.pct_used !== null && <MileageBar pct={item.pct_used} color={color} />}

      {item.recommendation ? (
        <Text style={[styles.recommendation, { color: item.pct_used !== null && item.pct_used >= 0.85 ? color : tc.textSecondary }]}>
          {item.recommendation}
        </Text>
      ) : null}
    </View>
  );
}

// ─── Add/Edit modal ───────────────────────────────────────────────────────────

const MAX_PHOTOS = 4;

function GearFormModal({
  visible,
  initial,
  tc,
  authToken,
  distanceUnit,
  onSave,
  onCancel,
}: {
  visible: boolean;
  initial: GearItem | null;
  tc: ReturnType<typeof getTheme>['colors'];
  authToken: string;
  distanceUnit: DistanceUnit;
  onSave: (body: GearItemCreate) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [gearType, setGearType] = useState('running_shoe');
  const [startingMiles, setStartingMiles] = useState('0');
  const [threshold, setThreshold] = useState('');
  const [sessionThreshold, setSessionThreshold] = useState('');
  const [keywords, setKeywords] = useState('');
  const [notes, setNotes] = useState('');
  const [aiScanning, setAiScanning] = useState(false);
  const [photos, setPhotos] = useState<string[]>([]);  // data URIs
  const [aiNote, setAiNote] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setName(initial?.name ?? '');
      setGearType(initial?.gear_type ?? 'running_shoe');
      setStartingMiles(formatDistance(initial?.starting_miles ?? 0, distanceUnit, { suffix: false }).replace(/\.0$/, ''));
      setThreshold(initial?.retirement_threshold_miles != null ? formatDistance(initial.retirement_threshold_miles, distanceUnit, { suffix: false }).replace(/\.0$/, '') : '');
      setSessionThreshold(initial?.retirement_threshold_sessions != null ? String(initial.retirement_threshold_sessions) : '');
      setKeywords((initial?.auto_track_keywords ?? []).join(', '));
      setNotes(initial?.notes ?? '');
      setPhotos(initial?.photos ?? []);
      setAiNote(null);
    }
  }, [visible, initial, distanceUnit]);

  const handleGearTypeChange = (type: string) => {
    setGearType(type);
    if (!threshold) {
      const def = DEFAULT_THRESHOLDS[type];
      setThreshold(def != null ? String(def) : '');
    }
    if (!sessionThreshold) {
      const def = DEFAULT_SESSION_THRESHOLDS[type];
      setSessionThreshold(def != null ? String(def) : '');
    }
    if (!keywords) {
      const info = gearTypeInfo(type);
      setKeywords(info.defaultKeywords.join(', '));
    }
  };

  const handleAddPhoto = () => {
    if (photos.length >= MAX_PHOTOS) return;
    Alert.alert(
      'Add Photo',
      'Take a new photo of your gear or pick one from your library.',
      [
        { text: 'Take Photo', onPress: () => pickGearPhoto('camera') },
        { text: 'Choose from Library', onPress: () => pickGearPhoto('library') },
        { text: 'Cancel', style: 'cancel' },
      ],
    );
  };

  const pickGearPhoto = async (source: 'camera' | 'library') => {
    try {
      const ImagePicker = await import('expo-image-picker');
      if (source === 'camera') {
        const cam = await ImagePicker.requestCameraPermissionsAsync();
        if (!cam.granted) {
          Alert.alert('Camera permission needed', 'Allow camera access to take gear photos.');
          return;
        }
        const result = await ImagePicker.launchCameraAsync({
          quality: 0.5,
          base64: true,
          allowsEditing: true,
          aspect: [4, 3],
          mediaTypes: ImagePicker.MediaTypeOptions.Images,
          exif: false,
        });
        const asset = result.assets?.[0];
        if (result.canceled || !asset?.base64) return;
        setPhotos(prev => [...prev, `data:image/jpeg;base64,${asset.base64}`]);
        return;
      }
      const lib = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!lib.granted) {
        Alert.alert('Permission needed', 'Allow photo access to add gear photos.');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.5,
        base64: true,
        allowsEditing: true,
        aspect: [4, 3],
        exif: false,
      });
      const asset = result.assets?.[0];
      if (result.canceled || !asset?.base64) return;
      setPhotos(prev => [...prev, `data:image/jpeg;base64,${asset.base64}`]);
    } catch {
      Alert.alert('Photo error', source === 'camera' ? 'Could not open camera.' : 'Could not open photo library.');
    }
  };

  const handleScanAll = async () => {
    if (photos.length === 0) return;
    setAiScanning(true);
    setAiNote(null);
    try {
      // Send raw base64 strings (strip data URI prefix)
      const b64List = photos.map(p => p.includes(',') ? p.split(',')[1] : p);
      const identified = await identifyGear(authToken, b64List);
      if (!name) setName(identified.name);
      if (GEAR_TYPES.find(g => g.value === identified.gear_type)) {
        handleGearTypeChange(identified.gear_type);
      }
      if (identified.estimated_miles != null && startingMiles === '0') {
        setStartingMiles(formatDistance(identified.estimated_miles, distanceUnit, { suffix: false }).replace(/\.0$/, ''));
      }
      if (identified.retirement_threshold_miles != null && !threshold) {
        setThreshold(formatDistance(identified.retirement_threshold_miles, distanceUnit, { suffix: false }).replace(/\.0$/, ''));
      }
      const conf = identified.confidence === 'high' ? '✓ High confidence'
        : identified.confidence === 'medium' ? '~ Medium confidence'
        : '? Low confidence — please verify';
      setAiNote(`${conf}${identified.notes ? `\n${identified.notes}` : ''}`);
    } catch {
      setAiNote('AI identification failed — fill in manually.');
    } finally {
      setAiScanning(false);
    }
  };

  const handleSave = () => {
    if (!name.trim()) {
      Alert.alert('Name required', 'Give your gear a name.');
      return;
    }
    const isMile = isMileTracked(gearType);
    onSave({
      name: name.trim(),
      gear_type: gearType,
      starting_miles: unitToMi(parseFloat(startingMiles) || 0, distanceUnit),
      // Only persist the unit that applies — keeps the other null so the
      // backend doesn't compute a misleading pct_used off a stale value
      // when the user changes gear type.
      retirement_threshold_miles: isMile && threshold ? unitToMi(parseFloat(threshold), distanceUnit) : null,
      retirement_threshold_sessions: !isMile && sessionThreshold ? parseInt(sessionThreshold, 10) : null,
      auto_track_keywords: keywords.split(',').map(k => k.trim()).filter(Boolean),
      notes: notes.trim() || null,
      photos,
    });
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onCancel}>
      <View testID="gear-form-modal" style={[styles.modal, { backgroundColor: tc.background }]}>
        <View style={styles.modalHeader}>
          <TouchableOpacity
            onPress={onCancel}
            testID="gear-form-cancel"
            accessibilityRole="button"
            accessibilityLabel="Cancel gear form">
            <Text style={[styles.modalCancel, { color: tc.textSecondary }]}>Cancel</Text>
          </TouchableOpacity>
          <Text style={[styles.modalTitle, { color: tc.textPrimary }]}>
            {initial ? 'Edit Gear' : 'Add Gear'}
          </Text>
          <TouchableOpacity
            onPress={handleSave}
            testID="gear-form-save"
            accessibilityRole="button"
            accessibilityLabel="Save gear">
            <Text style={[styles.modalSave, { color: tc.primary }]}>Save</Text>
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 60 }}>
          {/* Photos section — visible when adding or editing (editing shows existing photos) */}
          <View style={{ marginBottom: 20 }}>
            <Text style={[styles.fieldLabel, { color: tc.textSecondary, marginTop: 0 }]}>
              PHOTOS {photos.length > 0 ? `(${photos.length}/${MAX_PHOTOS})` : `— UP TO ${MAX_PHOTOS}`}
            </Text>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              {photos.map((uri, idx) => (
                <View key={idx} style={{ position: 'relative' }}>
                  <Image
                    source={{ uri }}
                    style={{ width: 80, height: 80, borderRadius: 10, backgroundColor: tc.surface }}
                    resizeMode="cover"
                  />
                  <TouchableOpacity
                    onPress={() => setPhotos(prev => prev.filter((_, i) => i !== idx))}
                    style={{
                      position: 'absolute', top: -6, right: -6,
                      width: 20, height: 20, borderRadius: 10,
                      backgroundColor: tc.error ?? '#EF4444',
                      alignItems: 'center', justifyContent: 'center',
                    }}
                    hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
                  >
                    <Ionicons name="close" size={12} color="#fff" />
                  </TouchableOpacity>
                </View>
              ))}
              {photos.length < MAX_PHOTOS && (
                <TouchableOpacity
                  onPress={handleAddPhoto}
                  style={{
                    width: 80, height: 80, borderRadius: 10, borderWidth: 1.5,
                    borderStyle: 'dashed', borderColor: tc.primary + '66',
                    alignItems: 'center', justifyContent: 'center',
                    backgroundColor: tc.primary + '0A',
                  }}
                >
                  <Ionicons name="add" size={26} color={tc.primary} />
                </TouchableOpacity>
              )}
            </View>

            {/* Scan with AI — appears when photos are present */}
            {photos.length > 0 && (
              <TouchableOpacity
                onPress={handleScanAll}
                disabled={aiScanning}
                style={{
                  flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                  backgroundColor: tc.primary + '18', borderRadius: 10, borderWidth: 1,
                  borderColor: tc.primary + '55', padding: 11, gap: 7, marginTop: 10,
                }}
              >
                {aiScanning
                  ? <ActivityIndicator size="small" color={tc.primary} />
                  : <Ionicons name="sparkles-outline" size={17} color={tc.primary} />}
                <Text style={{ color: tc.primary, fontWeight: '700', fontSize: 14 }}>
                  {aiScanning ? 'Scanning…' : `Identify with AI (${photos.length} photo${photos.length > 1 ? 's' : ''})`}
                </Text>
              </TouchableOpacity>
            )}
            {aiNote && !aiScanning && (
              <View style={{ backgroundColor: tc.surface, borderRadius: 8, padding: 10, marginTop: 8, borderWidth: 1, borderColor: tc.border }}>
                <Text style={{ color: tc.textSecondary, fontSize: 12, lineHeight: 18 }}>{aiNote}</Text>
              </View>
            )}
            {photos.length === 0 && (
              <Text style={{ color: tc.textMuted, fontSize: 12, marginTop: 6 }}>
                Add photos of your gear — AI can identify the model, estimate mileage, and pre-fill this form.
              </Text>
            )}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 }}>
              <View style={{ flex: 1, height: 1, backgroundColor: tc.border }} />
              <Text style={{ color: tc.textMuted, fontSize: 11 }}>or fill in manually</Text>
              <View style={{ flex: 1, height: 1, backgroundColor: tc.border }} />
            </View>
          </View>

          <Text style={[styles.fieldLabel, { color: tc.textSecondary }]}>NAME</Text>
          <TextInput
            testID="gear-name-input"
            accessibilityLabel="Gear name"
            style={[styles.input, { backgroundColor: tc.surface, color: tc.textPrimary, borderColor: tc.border }]}
            value={name}
            onChangeText={setName}
            placeholder="e.g. Brooks Ghost 14"
            placeholderTextColor={tc.textMuted}
          />

          <Text style={[styles.fieldLabel, { color: tc.textSecondary }]}>TYPE</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 16 }}>
            {GEAR_TYPES.map(g => (
              <TouchableOpacity
                key={g.value}
                onPress={() => handleGearTypeChange(g.value)}
                style={[
                  styles.typeChip,
                  {
                    backgroundColor: gearType === g.value ? tc.primary + '22' : tc.surface,
                    borderColor: gearType === g.value ? tc.primary : tc.border,
                  },
                ]}
              >
                <Ionicons name={g.icon as any} size={14} color={gearType === g.value ? tc.primary : tc.textSecondary} />
                <Text style={[styles.typeChipText, { color: gearType === g.value ? tc.primary : tc.textSecondary }]}>
                  {g.label}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
          <Text style={[styles.hint, { color: tc.textMuted, marginTop: -4 }]}>
            This tracks gear that wears out over miles or sessions. Adjustable dumbbells and other workout-planning equipment live in your workout equipment profile.
          </Text>

          {/* Wear fields — different unit per gear class. Mile-tracked gear
              (running shoes, bikes) gets miles; session-tracked gear (gloves,
              belts, mats) gets a session count. Either is optional — leaving
              the threshold blank just disables the retirement progress bar. */}
          {isMileTracked(gearType) ? (
            <>
              <Text style={[styles.fieldLabel, { color: tc.textSecondary }]}>{distanceUnit.toUpperCase()} ALREADY ON IT</Text>
              <TextInput
                style={[styles.input, { backgroundColor: tc.surface, color: tc.textPrimary, borderColor: tc.border }]}
                value={startingMiles}
                onChangeText={setStartingMiles}
                keyboardType="decimal-pad"
                placeholder="0"
                placeholderTextColor={tc.textMuted}
              />

              <Text style={[styles.fieldLabel, { color: tc.textSecondary }]}>RETIREMENT THRESHOLD ({distanceUnit})</Text>
              <TextInput
                style={[styles.input, { backgroundColor: tc.surface, color: tc.textPrimary, borderColor: tc.border }]}
                value={threshold}
                onChangeText={setThreshold}
                keyboardType="decimal-pad"
                placeholder="Leave blank to use default"
                placeholderTextColor={tc.textMuted}
              />
            </>
          ) : (
            <>
              <Text style={[styles.fieldLabel, { color: tc.textSecondary }]}>RETIREMENT THRESHOLD (sessions)</Text>
              <TextInput
                style={[styles.input, { backgroundColor: tc.surface, color: tc.textPrimary, borderColor: tc.border }]}
                value={sessionThreshold}
                onChangeText={setSessionThreshold}
                keyboardType="number-pad"
                placeholder="Leave blank for no retirement alert"
                placeholderTextColor={tc.textMuted}
              />
              <Text style={[styles.hint, { color: tc.textMuted }]}>
                Optional — set a session count to track wear (e.g. 150 for boxing gloves).
                Leave blank if the gear doesn't really wear out (yoga mats, foam rollers).
              </Text>
            </>
          )}

          <Text style={[styles.fieldLabel, { color: tc.textSecondary }]}>AUTO-TRACK KEYWORDS (comma separated)</Text>
          <TextInput
            style={[styles.input, { backgroundColor: tc.surface, color: tc.textPrimary, borderColor: tc.border }]}
            value={keywords}
            onChangeText={setKeywords}
            placeholder="run, treadmill, walk"
            placeholderTextColor={tc.textMuted}
            autoCapitalize="none"
          />
          <Text style={[styles.hint, { color: tc.textMuted }]}>
            Miles + sessions auto-accumulate from any workout (manual log or connected health import) whose focus or exercise names match these keywords. Items without a mile threshold track sessions only.
          </Text>

          <Text style={[styles.fieldLabel, { color: tc.textSecondary }]}>NOTES (optional)</Text>
          <TextInput
            style={[styles.input, styles.inputMultiline, { backgroundColor: tc.surface, color: tc.textPrimary, borderColor: tc.border }]}
            value={notes}
            onChangeText={setNotes}
            placeholder="Color, size, purchase info..."
            placeholderTextColor={tc.textMuted}
            multiline
          />
        </ScrollView>
      </View>
    </Modal>
  );
}

// ─── Log miles modal ──────────────────────────────────────────────────────────

function LogMilesModal({
  visible,
  gear,
  tc,
  distanceUnit,
  onLog,
  onCancel,
}: {
  visible: boolean;
  gear: GearItem | null;
  tc: ReturnType<typeof getTheme>['colors'];
  distanceUnit: DistanceUnit;
  onLog: (miles: number, sessions: number) => void;
  onCancel: () => void;
}) {
  const onPrimary = getContrastingTextColor(tc.primary);
  const sessionOnly = gear ? !isMileTracked(gear.gear_type) : false;
  const [miles, setMiles] = useState('');
  const [sessions, setSessions] = useState('1');

  useEffect(() => {
    if (visible) {
      setMiles('');
      setSessions('1');
    }
  }, [visible]);

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onCancel}>
      <View style={styles.logOverlay}>
        <View style={[styles.logBox, { backgroundColor: tc.surface }]}>
          <Text style={[styles.logTitle, { color: tc.textPrimary }]}>
            {sessionOnly ? 'Log Session' : `Log ${distanceUnit.toUpperCase()}`}
          </Text>
          <Text style={[styles.logSubtitle, { color: tc.textSecondary }]}>{gear?.name}</Text>
          {sessionOnly ? (
            <>
              <TextInput
                style={[styles.logInput, { backgroundColor: tc.background, color: tc.textPrimary, borderColor: tc.border }]}
                value={sessions}
                onChangeText={setSessions}
                keyboardType="number-pad"
                placeholder="1"
                placeholderTextColor={tc.textMuted}
                autoFocus
              />
              <Text style={[styles.hint, { color: tc.textMuted, textAlign: 'center', marginBottom: 16 }]}>sessions to add</Text>
            </>
          ) : (
            <>
              <TextInput
                style={[styles.logInput, { backgroundColor: tc.background, color: tc.textPrimary, borderColor: tc.border }]}
                value={miles}
                onChangeText={setMiles}
                keyboardType="decimal-pad"
                placeholder="0.0"
                placeholderTextColor={tc.textMuted}
                autoFocus
              />
              <Text style={[styles.hint, { color: tc.textMuted, textAlign: 'center', marginBottom: 16 }]}>{distanceUnit} to add</Text>
            </>
          )}
          <View style={styles.logButtons}>
            <TouchableOpacity onPress={onCancel} style={[styles.logBtn, { borderColor: tc.border }]}>
              <Text style={{ color: tc.textSecondary }}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => {
                if (sessionOnly) {
                  onLog(0, Math.max(1, parseInt(sessions, 10) || 1));
                } else {
                  onLog(unitToMi(parseFloat(miles) || 0, distanceUnit), 1);
                }
              }}
              style={[styles.logBtn, { backgroundColor: tc.primary, borderColor: tc.primary }]}
            >
              <Text style={{ color: onPrimary, fontWeight: '700' }}>Add</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

interface Props {
  authToken: string;
  themeName?: AppThemeName;
  distanceUnit?: DistanceUnit;
  onBack?: () => void;
}

export default function GearScreen({ authToken, themeName = DEFAULT_THEME_NAME, distanceUnit = 'mi', onBack }: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const onPrimary = getContrastingTextColor(tc.primary);
  const insets = useSafeAreaInsets();

  const [gear, setGear] = useState<GearItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editTarget, setEditTarget] = useState<GearItem | null>(null);
  const [logTarget, setLogTarget] = useState<GearItem | null>(null);

  const load = useCallback(() => {
    listGear(authToken)
      .then(setGear)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [authToken]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSave = async (body: GearItemCreate) => {
    try {
      if (editTarget) {
        const updated = await updateGear(authToken, editTarget.id, body);
        setGear(prev => prev.map(g => (g.id === updated.id ? updated : g)));
      } else {
        const created = await addGear(authToken, body);
        setGear(prev => [created, ...prev]);
      }
      setShowForm(false);
      setEditTarget(null);
    } catch {
      Alert.alert('Error', 'Could not save gear. Try again.');
    }
  };

  const handleLogMiles = async (miles: number, sessions: number) => {
    if (!logTarget) return;
    try {
      const updated = await logGearMiles(authToken, logTarget.id, miles, sessions);
      setGear(prev => prev.map(g => (g.id === updated.id ? updated : g)));
    } catch {
      Alert.alert('Error', 'Could not log miles. Try again.');
    }
    setLogTarget(null);
  };

  const handleDelete = (item: GearItem) => {
    Alert.alert('Delete Gear', `Remove "${item.name}"? This cannot be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await deleteGear(authToken, item.id).catch(() => {});
          setGear(prev => prev.filter(g => g.id !== item.id));
        },
      },
    ]);
  };

  const retiring = gear.filter(g => g.pct_used !== null && g.pct_used >= 0.85);

  return (
    <View testID="gear-tracker-screen" style={[styles.container, { backgroundColor: tc.background, paddingTop: insets.top }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: tc.border }]}>
        {onBack && (
          <TouchableOpacity
            onPress={onBack}
            style={styles.backBtn}
            testID="gear-back"
            accessibilityRole="button"
            accessibilityLabel="Back from gear tracker">
            <Ionicons name="chevron-back" size={24} color={tc.textPrimary} />
          </TouchableOpacity>
        )}
        <Text style={[styles.headerTitle, { color: tc.textPrimary }]}>Gear Tracker</Text>
        <TouchableOpacity
          onPress={() => { setEditTarget(null); setShowForm(true); }}
          style={[styles.addBtn, { backgroundColor: tc.primary }]}
          testID="gear-add-button"
          accessibilityRole="button"
          accessibilityLabel="Add gear"
        >
          <Ionicons name="add" size={20} color={onPrimary} />
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.loading}>
          <ActivityIndicator color={tc.primary} />
        </View>
      ) : (
        <ScrollView testID="gear-tracker-content" contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 32 }}>
          {retiring.length > 0 && (
            <View style={[styles.alertBanner, { backgroundColor: '#F97316' + '22', borderColor: '#F97316' }]}>
              <Ionicons name="warning-outline" size={16} color="#F97316" />
              <Text style={[styles.alertText, { color: '#F97316' }]}>
                {retiring.length === 1
                  ? `${retiring[0].name} is approaching retirement.`
                  : `${retiring.length} items are approaching retirement.`}
              </Text>
            </View>
          )}

          {gear.length > 0 && <GearHero />}

          <View testID="gear-info-banner" style={[styles.infoBanner, { backgroundColor: tc.surface, borderColor: tc.border }]}>
            <Ionicons name="information-circle-outline" size={16} color={tc.textSecondary} />
            <Text style={[styles.infoText, { color: tc.textSecondary }]}>
              Gear Tracker is for wear-based items like shoes, bikes, belts, wraps, and gloves. Workout equipment like adjustable dumbbells belongs in your workout equipment profile.
            </Text>
          </View>

          <GearInsightPanel gear={gear} tc={tc} distanceUnit={distanceUnit} />

          {gear.length === 0 ? (
            <View style={styles.empty}>
              <ImageBackground
                source={{ uri: STOCK_IMAGES.gear.hero }}
                style={styles.emptyImage}
                imageStyle={styles.emptyImagePhoto}
              >
                <LinearGradient
                  colors={['rgba(0,0,0,0.02)', 'rgba(0,0,0,0.34)']}
                  style={styles.emptyImageGradient}
                />
              </ImageBackground>
              <Text style={[styles.emptyTitle, { color: tc.textPrimary }]}>No gear yet</Text>
              <Text style={[styles.emptySubtitle, { color: tc.textSecondary }]}>
                Add your running shoes, bike, lifting belt, wraps, or other wear gear to track usage and get retirement alerts.
              </Text>
              <TouchableOpacity
                onPress={() => { setEditTarget(null); setShowForm(true); }}
                style={[styles.emptyBtn, { backgroundColor: tc.primary }]}
                testID="gear-empty-add-button"
                accessibilityRole="button"
                accessibilityLabel="Add gear"
              >
                <Text style={{ color: onPrimary, fontWeight: '700' }}>Add Gear</Text>
              </TouchableOpacity>
            </View>
          ) : (
            gear.map(item => (
              <GearCard
                key={item.id}
                item={item}
                tc={tc}
                distanceUnit={distanceUnit}
                onEdit={() => { setEditTarget(item); setShowForm(true); }}
                onLogMiles={() => setLogTarget(item)}
                onDelete={() => handleDelete(item)}
              />
            ))
          )}
        </ScrollView>
      )}

      <GearFormModal
        visible={showForm}
        initial={editTarget}
        tc={tc}
        authToken={authToken}
        distanceUnit={distanceUnit}
        onSave={handleSave}
        onCancel={() => { setShowForm(false); setEditTarget(null); }}
      />

      <LogMilesModal
        visible={!!logTarget}
        gear={logTarget}
        tc={tc}
        distanceUnit={distanceUnit}
        onLog={handleLogMiles}
        onCancel={() => setLogTarget(null)}
      />
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  backBtn: { marginRight: 8 },
  headerTitle: { flex: 1, fontSize: 20, fontWeight: '700' },
  addBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  gearHero: {
    height: 136,
    borderRadius: radius.md,
    overflow: 'hidden',
    marginBottom: 12,
    justifyContent: 'flex-end',
  },
  gearHeroImage: { borderRadius: radius.md },
  gearHeroGradient: { ...StyleSheet.absoluteFillObject },
  gearHeroCopy: { padding: 14 },
  gearHeroTitle: { color: '#fff', fontSize: 20, fontWeight: '900' },
  gearHeroMeta: { color: '#fff', fontSize: 12, fontWeight: '800', marginTop: 3, opacity: 0.88 },
  alertBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    marginBottom: 12,
  },
  alertText: { flex: 1, fontSize: 13, fontWeight: '600' },
  infoBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    padding: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    marginBottom: 12,
  },
  infoText: { flex: 1, fontSize: 12, lineHeight: 18 },
  insightPanel: {
    borderRadius: radius.md,
    borderWidth: 1,
    padding: 14,
    marginBottom: 12,
    gap: 10,
  },
  insightHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  insightTitle: { fontSize: 14, fontWeight: '800' },
  insightRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  insightIcon: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  insightRowTitle: { fontSize: 12, fontWeight: '800' },
  insightRowDetail: { fontSize: 11, lineHeight: 15, marginTop: 2 },
  card: {
    borderRadius: radius.md,
    borderWidth: 1,
    padding: 16,
    marginBottom: 12,
  },
  gearStockImage: {
    height: 82,
    borderRadius: radius.sm,
    overflow: 'hidden',
    marginBottom: 12,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  gearStockImagePhoto: { borderRadius: radius.sm },
  gearStockGradient: { ...StyleSheet.absoluteFillObject },
  cardHeader: { flexDirection: 'row', alignItems: 'center' },
  gearIcon: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  gearName: { fontSize: 16, fontWeight: '700' },
  gearType: { fontSize: 12, marginTop: 2 },
  cardActions: { flexDirection: 'row', gap: 4 },
  actionBtn: { padding: 4 },
  statsRow: { flexDirection: 'row', marginTop: 12, gap: 24 },
  stat: { alignItems: 'center' },
  statValue: { fontSize: 18, fontWeight: '800' },
  statLabel: { fontSize: 11, marginTop: 2 },
  recommendation: { fontSize: 12, marginTop: 8, lineHeight: 17 },
  modal: { flex: 1 },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    paddingTop: 24,
  },
  modalTitle: { fontSize: 17, fontWeight: '700' },
  modalCancel: { fontSize: 16 },
  modalSave: { fontSize: 16, fontWeight: '700' },
  fieldLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.8, marginBottom: 6, marginTop: 16 },
  input: {
    borderWidth: 1,
    borderRadius: radius.sm,
    padding: 12,
    fontSize: 15,
  },
  inputMultiline: { height: 80, textAlignVertical: 'top' },
  hint: { fontSize: 12, marginTop: 4, lineHeight: 17 },
  typeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 20,
    borderWidth: 1,
    marginRight: 8,
  },
  typeChipText: { fontSize: 12, fontWeight: '600' },
  logOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  logBox: {
    width: '100%',
    borderRadius: radius.lg,
    padding: 24,
    alignItems: 'center',
  },
  logTitle: { fontSize: 18, fontWeight: '800', marginBottom: 4 },
  logSubtitle: { fontSize: 14, marginBottom: 20 },
  logInput: {
    width: 120,
    borderWidth: 1,
    borderRadius: radius.sm,
    padding: 12,
    fontSize: 28,
    fontWeight: '700',
    textAlign: 'center',
  },
  logButtons: { flexDirection: 'row', gap: 12, width: '100%' },
  logBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
  },
  empty: { alignItems: 'center', paddingTop: 28, paddingHorizontal: 20 },
  emptyImage: {
    width: '100%',
    height: 150,
    borderRadius: radius.md,
    overflow: 'hidden',
    marginBottom: 18,
    justifyContent: 'flex-end',
  },
  emptyImagePhoto: { borderRadius: radius.md },
  emptyImageGradient: { ...StyleSheet.absoluteFillObject },
  emptyTitle: { fontSize: 20, fontWeight: '800', marginBottom: 8 },
  emptySubtitle: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  emptyBtn: { marginTop: 24, paddingHorizontal: 28, paddingVertical: 14, borderRadius: radius.md },
});
