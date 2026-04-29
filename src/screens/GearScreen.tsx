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
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { getTheme, radius } from '../constants/theme';
import { AppThemeName } from '../types';
import {
  listGear,
  addGear,
  updateGear,
  deleteGear,
  logGearMiles,
  GearItem,
  GearItemCreate,
} from '../services/api';

// ─── Constants ────────────────────────────────────────────────────────────────

const GEAR_TYPES: { value: string; label: string; icon: string; defaultKeywords: string[] }[] = [
  { value: 'running_shoe',   label: 'Running Shoes',   icon: 'walk-outline',     defaultKeywords: ['run', 'treadmill', 'jog', 'walk'] },
  { value: 'trail_shoe',     label: 'Trail Shoes',     icon: 'trail-sign-outline', defaultKeywords: ['trail run', 'hike', 'walk'] },
  { value: 'cycling_shoe',   label: 'Cycling Shoes',   icon: 'bicycle-outline',  defaultKeywords: ['cycling', 'spin', 'bike'] },
  { value: 'bike',           label: 'Bike',            icon: 'bicycle-outline',  defaultKeywords: ['cycling', 'spin', 'bike', 'road bike'] },
  { value: 'bike_tire',      label: 'Bike Tire',       icon: 'ellipse-outline',  defaultKeywords: ['cycling', 'spin', 'bike'] },
  { value: 'bike_chain',     label: 'Bike Chain',      icon: 'link-outline',     defaultKeywords: ['cycling', 'spin', 'bike'] },
  { value: 'treadmill_belt', label: 'Treadmill Belt',  icon: 'fitness-outline',  defaultKeywords: ['treadmill', 'run', 'walk'] },
  { value: 'jump_rope',      label: 'Jump Rope',       icon: 'infinite-outline', defaultKeywords: ['jump rope', 'cardio'] },
  { value: 'other',          label: 'Other',           icon: 'cube-outline',     defaultKeywords: [] },
];

const DEFAULT_THRESHOLDS: Record<string, number | null> = {
  running_shoe:   400,
  trail_shoe:     350,
  cycling_shoe:   null,
  bike:           null,
  bike_tire:      2000,
  bike_chain:     1500,
  treadmill_belt: 3000,
  jump_rope:      null,
  other:          null,
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

// ─── Gear card ─────────────────────────────────────────────────────────────────

function GearCard({
  item,
  tc,
  onEdit,
  onLogMiles,
  onDelete,
}: {
  item: GearItem;
  tc: ReturnType<typeof getTheme>['colors'];
  onEdit: () => void;
  onLogMiles: () => void;
  onDelete: () => void;
}) {
  const info = gearTypeInfo(item.gear_type);
  const color = getMileageColor(item.pct_used);
  const pctLabel = item.pct_used !== null ? `${Math.round(item.pct_used * 100)}%` : null;

  return (
    <View style={[styles.card, { backgroundColor: tc.surface, borderColor: tc.border }]}>
      <View style={styles.cardHeader}>
        <View style={[styles.gearIcon, { backgroundColor: color + '22' }]}>
          <Ionicons name={info.icon as any} size={22} color={color} />
        </View>
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text style={[styles.gearName, { color: tc.textPrimary }]}>{item.name}</Text>
          <Text style={[styles.gearType, { color: tc.textSecondary }]}>{info.label}</Text>
        </View>
        <View style={styles.cardActions}>
          <TouchableOpacity onPress={onLogMiles} style={styles.actionBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="add-circle-outline" size={22} color={tc.primary} />
          </TouchableOpacity>
          <TouchableOpacity onPress={onEdit} style={styles.actionBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="pencil-outline" size={20} color={tc.textSecondary} />
          </TouchableOpacity>
          <TouchableOpacity onPress={onDelete} style={styles.actionBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="trash-outline" size={18} color={tc.textMuted} />
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.statsRow}>
        <View style={styles.stat}>
          <Text style={[styles.statValue, { color: tc.textPrimary }]}>{item.total_miles.toFixed(1)}</Text>
          <Text style={[styles.statLabel, { color: tc.textSecondary }]}>total mi</Text>
        </View>
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
      </View>

      <MileageBar pct={item.pct_used} color={color} />

      {item.recommendation ? (
        <Text style={[styles.recommendation, { color: item.pct_used !== null && item.pct_used >= 0.85 ? color : tc.textSecondary }]}>
          {item.recommendation}
        </Text>
      ) : null}
    </View>
  );
}

// ─── Add/Edit modal ───────────────────────────────────────────────────────────

function GearFormModal({
  visible,
  initial,
  tc,
  onSave,
  onCancel,
}: {
  visible: boolean;
  initial: GearItem | null;
  tc: ReturnType<typeof getTheme>['colors'];
  onSave: (body: GearItemCreate) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [gearType, setGearType] = useState('running_shoe');
  const [startingMiles, setStartingMiles] = useState('0');
  const [threshold, setThreshold] = useState('');
  const [keywords, setKeywords] = useState('');
  const [notes, setNotes] = useState('');

  useEffect(() => {
    if (visible) {
      setName(initial?.name ?? '');
      setGearType(initial?.gear_type ?? 'running_shoe');
      setStartingMiles(String(initial?.starting_miles ?? 0));
      setThreshold(initial?.retirement_threshold_miles != null ? String(initial.retirement_threshold_miles) : '');
      setKeywords((initial?.auto_track_keywords ?? []).join(', '));
      setNotes(initial?.notes ?? '');
    }
  }, [visible, initial]);

  const handleGearTypeChange = (type: string) => {
    setGearType(type);
    if (!threshold) {
      const def = DEFAULT_THRESHOLDS[type];
      setThreshold(def != null ? String(def) : '');
    }
    if (!keywords) {
      const info = gearTypeInfo(type);
      setKeywords(info.defaultKeywords.join(', '));
    }
  };

  const handleSave = () => {
    if (!name.trim()) {
      Alert.alert('Name required', 'Give your gear a name.');
      return;
    }
    onSave({
      name: name.trim(),
      gear_type: gearType,
      starting_miles: parseFloat(startingMiles) || 0,
      retirement_threshold_miles: threshold ? parseFloat(threshold) : null,
      auto_track_keywords: keywords.split(',').map(k => k.trim()).filter(Boolean),
      notes: notes.trim() || null,
    });
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onCancel}>
      <View style={[styles.modal, { backgroundColor: tc.background }]}>
        <View style={styles.modalHeader}>
          <TouchableOpacity onPress={onCancel}>
            <Text style={[styles.modalCancel, { color: tc.textSecondary }]}>Cancel</Text>
          </TouchableOpacity>
          <Text style={[styles.modalTitle, { color: tc.textPrimary }]}>
            {initial ? 'Edit Gear' : 'Add Gear'}
          </Text>
          <TouchableOpacity onPress={handleSave}>
            <Text style={[styles.modalSave, { color: tc.primary }]}>Save</Text>
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 60 }}>
          <Text style={[styles.fieldLabel, { color: tc.textSecondary }]}>NAME</Text>
          <TextInput
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

          <Text style={[styles.fieldLabel, { color: tc.textSecondary }]}>MILES ALREADY ON IT</Text>
          <TextInput
            style={[styles.input, { backgroundColor: tc.surface, color: tc.textPrimary, borderColor: tc.border }]}
            value={startingMiles}
            onChangeText={setStartingMiles}
            keyboardType="decimal-pad"
            placeholder="0"
            placeholderTextColor={tc.textMuted}
          />

          <Text style={[styles.fieldLabel, { color: tc.textSecondary }]}>RETIREMENT THRESHOLD (miles)</Text>
          <TextInput
            style={[styles.input, { backgroundColor: tc.surface, color: tc.textPrimary, borderColor: tc.border }]}
            value={threshold}
            onChangeText={setThreshold}
            keyboardType="decimal-pad"
            placeholder="Leave blank to use default"
            placeholderTextColor={tc.textMuted}
          />

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
            Miles from workouts whose focus or exercises match these keywords are automatically counted.
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
  onLog,
  onCancel,
}: {
  visible: boolean;
  gear: GearItem | null;
  tc: ReturnType<typeof getTheme>['colors'];
  onLog: (miles: number) => void;
  onCancel: () => void;
}) {
  const [miles, setMiles] = useState('');

  useEffect(() => {
    if (visible) setMiles('');
  }, [visible]);

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onCancel}>
      <View style={styles.logOverlay}>
        <View style={[styles.logBox, { backgroundColor: tc.surface }]}>
          <Text style={[styles.logTitle, { color: tc.textPrimary }]}>Log Miles</Text>
          <Text style={[styles.logSubtitle, { color: tc.textSecondary }]}>{gear?.name}</Text>
          <TextInput
            style={[styles.logInput, { backgroundColor: tc.background, color: tc.textPrimary, borderColor: tc.border }]}
            value={miles}
            onChangeText={setMiles}
            keyboardType="decimal-pad"
            placeholder="0.0"
            placeholderTextColor={tc.textMuted}
            autoFocus
          />
          <Text style={[styles.hint, { color: tc.textMuted, textAlign: 'center', marginBottom: 16 }]}>miles to add</Text>
          <View style={styles.logButtons}>
            <TouchableOpacity onPress={onCancel} style={[styles.logBtn, { borderColor: tc.border }]}>
              <Text style={{ color: tc.textSecondary }}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => onLog(parseFloat(miles) || 0)}
              style={[styles.logBtn, { backgroundColor: tc.primary, borderColor: tc.primary }]}
            >
              <Text style={{ color: '#fff', fontWeight: '700' }}>Add</Text>
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
  onBack?: () => void;
}

export default function GearScreen({ authToken, themeName = 'midnight', onBack }: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
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

  const handleLogMiles = async (miles: number) => {
    if (!logTarget) return;
    try {
      const updated = await logGearMiles(authToken, logTarget.id, miles);
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
    <View style={[styles.container, { backgroundColor: tc.background, paddingTop: insets.top }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: tc.border }]}>
        {onBack && (
          <TouchableOpacity onPress={onBack} style={styles.backBtn}>
            <Ionicons name="chevron-back" size={24} color={tc.textPrimary} />
          </TouchableOpacity>
        )}
        <Text style={[styles.headerTitle, { color: tc.textPrimary }]}>Gear Tracker</Text>
        <TouchableOpacity
          onPress={() => { setEditTarget(null); setShowForm(true); }}
          style={[styles.addBtn, { backgroundColor: tc.primary }]}
        >
          <Ionicons name="add" size={20} color="#fff" />
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.loading}>
          <ActivityIndicator color={tc.primary} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 32 }}>
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

          {gear.length === 0 ? (
            <View style={styles.empty}>
              <Ionicons name="walk-outline" size={48} color={tc.textMuted} />
              <Text style={[styles.emptyTitle, { color: tc.textPrimary }]}>No gear yet</Text>
              <Text style={[styles.emptySubtitle, { color: tc.textSecondary }]}>
                Add your running shoes, bike, or other equipment to track mileage and get retirement alerts.
              </Text>
              <TouchableOpacity
                onPress={() => { setEditTarget(null); setShowForm(true); }}
                style={[styles.emptyBtn, { backgroundColor: tc.primary }]}
              >
                <Text style={{ color: '#fff', fontWeight: '700' }}>Add Gear</Text>
              </TouchableOpacity>
            </View>
          ) : (
            gear.map(item => (
              <GearCard
                key={item.id}
                item={item}
                tc={tc}
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
        onSave={handleSave}
        onCancel={() => { setShowForm(false); setEditTarget(null); }}
      />

      <LogMilesModal
        visible={!!logTarget}
        gear={logTarget}
        tc={tc}
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
  card: {
    borderRadius: radius.md,
    borderWidth: 1,
    padding: 16,
    marginBottom: 12,
  },
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
  empty: { alignItems: 'center', paddingTop: 60, paddingHorizontal: 32 },
  emptyTitle: { fontSize: 20, fontWeight: '800', marginTop: 16, marginBottom: 8 },
  emptySubtitle: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  emptyBtn: { marginTop: 24, paddingHorizontal: 28, paddingVertical: 14, borderRadius: radius.md },
});
