import { useState, useEffect } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
  TextInput, Modal,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { UserProfile, SupplementItem, AppThemeName } from '../types';
import { getTheme, radius } from '../constants/theme';
import { SUPPLEMENT_LIBRARY, SUPPLEMENT_CATEGORIES, SupplementEntry } from '../constants/supplementLibrary';

interface SupplementsScreenProps {
  userProfile: UserProfile;
  themeName?: AppThemeName;
  onSave: (updated: UserProfile) => void;
  onBack: () => void;
}

export default function SupplementsScreen({ userProfile, themeName, onSave, onBack }: SupplementsScreenProps) {
  const insets = useSafeAreaInsets();
  const theme = getTheme(themeName);
  const c = theme.colors;
  const meal = theme.sections.meals;

  const [selected, setSelected] = useState<Set<string>>(new Set(userProfile.supplementsAvailable ?? []));
  const [activeCategory, setActiveCategory] = useState('all');
  const [search, setSearch] = useState('');
  const [detailSupp, setDetailSupp] = useState<SupplementEntry | null>(null);
  const [aiStack, setAiStack] = useState<SupplementItem[]>([]);

  useEffect(() => {
    AsyncStorage.getItem('supplementStack').then(raw => {
      if (raw) {
        try { setAiStack(JSON.parse(raw)); } catch {}
      }
    });
  }, []);

  const toggle = (name: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  };

  const handleSave = () => {
    onSave({ ...userProfile, supplementsAvailable: Array.from(selected) });
  };

  const filtered = SUPPLEMENT_LIBRARY.filter(s => {
    const catMatch = activeCategory === 'all' || s.category === activeCategory;
    const searchMatch = !search || s.name.toLowerCase().includes(search.toLowerCase()) || s.tagline.toLowerCase().includes(search.toLowerCase());
    return catMatch && searchMatch;
  });

  const aiRecommended = SUPPLEMENT_LIBRARY.filter(s => aiStack.some(a => a.name.toLowerCase() === s.name.toLowerCase()));
  const myStack = SUPPLEMENT_LIBRARY.filter(s => selected.has(s.name));

  const evidenceColor = (e: SupplementEntry['evidence']) =>
    e === 'strong' ? '#00C488' : e === 'moderate' ? '#FFB300' : '#FF6B6B';
  const evidenceLabel = (e: SupplementEntry['evidence']) =>
    e === 'strong' ? '✓ Well-studied' : e === 'moderate' ? '◑ Some evidence' : '⚠ Early research';

  const styles = createStyles(c, meal);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Text style={[styles.backBtn, { color: c.primary }]}><Ionicons name="arrow-back" size={18} /> Back</Text>
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: c.textPrimary }]}>Supplements</Text>
        <TouchableOpacity onPress={handleSave} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Text style={[styles.saveBtn, { color: meal.strong }]}>Save</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">

        {/* Search */}
        <View style={[styles.searchRow, { backgroundColor: c.surfaceRaised, borderColor: c.border }]}>
          <Text style={{ fontSize: 15, marginRight: 6 }}>🔍</Text>
          <TextInput
            style={[styles.searchInput, { color: c.textPrimary }]}
            placeholder="Search supplements…"
            placeholderTextColor={c.textMuted}
            value={search}
            onChangeText={setSearch}
          />
          {search.length > 0 && (
            <TouchableOpacity onPress={() => setSearch('')}>
              <Ionicons name="close" size={16} color={c.textMuted} />
            </TouchableOpacity>
          )}
        </View>

        {/* My Stack */}
        {myStack.length > 0 && !search && (
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: c.textPrimary }]}>💊 My Stack ({myStack.length})</Text>
            <View style={styles.chipRow}>
              {myStack.map(s => (
                <TouchableOpacity
                  key={s.name}
                  style={[styles.myStackChip, { backgroundColor: meal.soft, borderColor: meal.strong + '80' }]}
                  onPress={() => setDetailSupp(s)}
                  activeOpacity={0.75}>
                  <Text style={styles.myStackChipIcon}>{s.icon}</Text>
                  <Text style={[styles.myStackChipText, { color: meal.text }]}>{s.name}</Text>
                  <TouchableOpacity onPress={() => toggle(s.name)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <Text style={[styles.myStackChipRemove, { color: meal.strong }]}><Ionicons name="close" size={14} /></Text>
                  </TouchableOpacity>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}

        {/* AI Recommended */}
        {aiRecommended.length > 0 && !search && (
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: c.textPrimary }]}>🤖 AI Recommended for You</Text>
            <Text style={[styles.sectionSub, { color: c.textMuted }]}>Based on your current plan and goals</Text>
            <View style={styles.aiRow}>
              {aiRecommended.map(s => {
                const ai = aiStack.find(a => a.name.toLowerCase() === s.name.toLowerCase());
                const taking = selected.has(s.name);
                return (
                  <TouchableOpacity
                    key={s.name}
                    style={[styles.aiCard, { backgroundColor: c.surfaceRaised, borderColor: taking ? meal.strong + '80' : c.border }]}
                    onPress={() => setDetailSupp(s)}
                    activeOpacity={0.8}>
                    <Text style={styles.aiCardIcon}>{s.icon}</Text>
                    <Text style={[styles.aiCardName, { color: c.textPrimary }]}>{s.name}</Text>
                    {ai && <Text style={[styles.aiCardDose, { color: c.textMuted }]}>{ai.dose}</Text>}
                    {ai && <Text style={[styles.aiCardPurpose, { color: c.textSecondary }]} numberOfLines={2}>{ai.purpose}</Text>}
                    <TouchableOpacity
                      style={[styles.aiCardToggle, { backgroundColor: taking ? meal.strong : 'transparent', borderColor: meal.strong }]}
                      onPress={() => toggle(s.name)}>
                      <Text style={[styles.aiCardToggleText, { color: taking ? '#fff' : meal.strong }]}>
                        {taking ? '✓ Taking' : '+ Add'}
                      </Text>
                    </TouchableOpacity>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        )}

        {/* Category filter */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.catScroll}
          contentContainerStyle={styles.catScrollContent}>
          {SUPPLEMENT_CATEGORIES.map(cat => {
            const active = activeCategory === cat.key;
            return (
              <TouchableOpacity
                key={cat.key}
                style={[styles.catChip, active && { backgroundColor: meal.strong, borderColor: meal.strong }]}
                onPress={() => setActiveCategory(cat.key)}>
                <Text style={[styles.catChipText, { color: active ? '#fff' : c.textSecondary }]}>{cat.label}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        {/* Supplement list */}
        <View style={styles.list}>
          {filtered.map(s => {
            const taking = selected.has(s.name);
            const isAiRec = aiStack.some(a => a.name.toLowerCase() === s.name.toLowerCase());
            return (
              <TouchableOpacity
                key={s.name}
                style={[styles.suppCard, { backgroundColor: c.surfaceRaised, borderColor: taking ? meal.strong + '66' : c.border }]}
                onPress={() => setDetailSupp(s)}
                activeOpacity={0.8}>
                <View style={styles.suppCardLeft}>
                  <Text style={styles.suppCardIcon}>{s.icon}</Text>
                </View>
                <View style={styles.suppCardBody}>
                  <View style={styles.suppCardTitleRow}>
                    <Text style={[styles.suppCardName, { color: c.textPrimary }]}>{s.name}</Text>
                    {isAiRec && (
                      <View style={[styles.aiRecBadge, { backgroundColor: meal.strong + '22', borderColor: meal.strong + '44' }]}>
                        <Text style={[styles.aiRecBadgeText, { color: meal.strong }]}>AI Pick</Text>
                      </View>
                    )}
                  </View>
                  <Text style={[styles.suppCardTagline, { color: c.textSecondary }]} numberOfLines={1}>{s.tagline}</Text>
                  <View style={styles.suppCardMeta}>
                    <Text style={[styles.evidenceBadge, { color: evidenceColor(s.evidence) }]}>{evidenceLabel(s.evidence)}</Text>
                    <Text style={[styles.suppCardCategory, { color: c.textMuted }]}>{s.category}</Text>
                  </View>
                </View>
                <TouchableOpacity
                  style={[styles.takeToggle, { borderColor: taking ? meal.strong : c.border, backgroundColor: taking ? meal.strong : 'transparent' }]}
                  onPress={() => toggle(s.name)}
                  hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}>
                  <Text style={[styles.takeToggleText, { color: taking ? '#fff' : c.textMuted }]}>
                    {taking ? '✓' : '+'}
                  </Text>
                </TouchableOpacity>
              </TouchableOpacity>
            );
          })}
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>

      {/* Detail Modal */}
      <Modal
        visible={!!detailSupp}
        transparent
        animationType="slide"
        onRequestClose={() => setDetailSupp(null)}>
        <View style={styles.detailBackdrop}>
          <View style={[styles.detailSheet, { backgroundColor: c.surface, borderTopColor: meal.strong + '60' }]}>
            <View style={[styles.sheetHandle, { backgroundColor: c.border }]} />
            {detailSupp && (
              <>
                <View style={[styles.detailHeader, { borderBottomColor: c.border }]}>
                  <TouchableOpacity onPress={() => setDetailSupp(null)} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                    <Text style={[styles.detailClose, { color: c.primary }]}><Ionicons name="arrow-back" size={18} /> Back</Text>
                  </TouchableOpacity>
                  <Text style={[styles.detailTitle, { color: c.textPrimary }]} numberOfLines={1}>{detailSupp.name}</Text>
                  <TouchableOpacity
                    style={[styles.detailToggleBtn, {
                      backgroundColor: selected.has(detailSupp.name) ? meal.strong : 'transparent',
                      borderColor: meal.strong,
                    }]}
                    onPress={() => toggle(detailSupp.name)}>
                    <Text style={[styles.detailToggleBtnText, { color: selected.has(detailSupp.name) ? '#fff' : meal.strong }]}>
                      {selected.has(detailSupp.name) ? '✓ Taking' : '+ Add'}
                    </Text>
                  </TouchableOpacity>
                </View>

                <ScrollView contentContainerStyle={styles.detailContent}>
                  {/* Hero */}
                  <View style={[styles.detailHero, { backgroundColor: meal.soft, borderColor: meal.strong + '40' }]}>
                    <Text style={styles.detailHeroIcon}>{detailSupp.icon}</Text>
                    <Text style={[styles.detailHeroCategory, { color: meal.text }]}>{detailSupp.category.toUpperCase()}</Text>
                    <Text style={[styles.detailHeroTagline, { color: meal.text }]}>{detailSupp.tagline}</Text>
                    <View style={[styles.evidencePill, {
                      backgroundColor: evidenceColor(detailSupp.evidence) + '20',
                      borderColor: evidenceColor(detailSupp.evidence),
                    }]}>
                      <Text style={[styles.evidencePillText, { color: evidenceColor(detailSupp.evidence) }]}>
                        {evidenceLabel(detailSupp.evidence)}
                      </Text>
                    </View>
                  </View>

                  {/* What it does */}
                  <View style={styles.detailBlock}>
                    <Text style={[styles.detailBlockTitle, { color: c.textPrimary }]}>What It Does</Text>
                    <Text style={[styles.detailBlockText, { color: c.textSecondary }]}>{detailSupp.whatItDoes}</Text>
                  </View>

                  {/* Dosing */}
                  <View style={[styles.detailDoseBlock, { backgroundColor: c.surfaceRaised, borderColor: c.border }]}>
                    <View style={styles.detailDoseRow}>
                      <Text style={[styles.detailDoseLabel, { color: c.textMuted }]}>DOSE</Text>
                      <Text style={[styles.detailDoseValue, { color: c.textPrimary }]}>{detailSupp.dose}</Text>
                    </View>
                    <View style={[styles.detailDivider, { backgroundColor: c.border }]} />
                    <View style={styles.detailDoseRow}>
                      <Text style={[styles.detailDoseLabel, { color: c.textMuted }]}>TIMING</Text>
                      <Text style={[styles.detailDoseValue, { color: c.textPrimary }]}>{detailSupp.timing}</Text>
                    </View>
                  </View>

                  {/* Best for */}
                  <View style={styles.detailBlock}>
                    <Text style={[styles.detailBlockTitle, { color: c.textPrimary }]}>Best For</Text>
                    <View style={styles.goodForRow}>
                      {detailSupp.goodFor.map(g => (
                        <View key={g} style={[styles.goodForChip, { backgroundColor: meal.strong + '20', borderColor: meal.strong + '44' }]}>
                          <Text style={[styles.goodForText, { color: meal.strong }]}>{g}</Text>
                        </View>
                      ))}
                    </View>
                  </View>

                  {/* Cautions */}
                  <View style={[styles.detailBlock, { backgroundColor: '#FF6B6B12', borderRadius: radius.md, borderWidth: 1, borderColor: '#FF6B6B33', padding: 12 }]}>
                    <Text style={[styles.detailBlockTitle, { color: '#FF6B6B' }]}>Cautions</Text>
                    <Text style={[styles.detailBlockText, { color: c.textSecondary }]}>{detailSupp.cautions}</Text>
                  </View>

                  <View style={{ height: 32 }} />
                </ScrollView>
              </>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const createStyles = (
  c: ReturnType<typeof getTheme>['colors'],
  _meal: ReturnType<typeof getTheme>['sections']['meals'],
) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
    backgroundColor: c.surface,
  },
  backBtn:    { fontSize: 15, fontWeight: '600' },
  headerTitle:{ fontSize: 17, fontWeight: '700', flex: 1, textAlign: 'center' },
  saveBtn:    { fontSize: 15, fontWeight: '700' },

  scrollContent: { paddingHorizontal: 16, paddingTop: 14 },

  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 16,
  },
  searchInput: { flex: 1, fontSize: 15, padding: 0 },

  section: { marginBottom: 20 },
  sectionTitle: { fontSize: 15, fontWeight: '700', marginBottom: 6 },
  sectionSub:   { fontSize: 12, marginBottom: 10, marginTop: -4 },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  myStackChip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radius.full,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 6,
    gap: 6,
  },
  myStackChipIcon:   { fontSize: 14 },
  myStackChipText:   { fontSize: 13, fontWeight: '600' },
  myStackChipRemove: { fontSize: 13, fontWeight: '700' },

  aiRow: { gap: 10 },
  aiCard: {
    borderRadius: radius.md,
    borderWidth: 1,
    padding: 12,
    gap: 4,
  },
  aiCardIcon:    { fontSize: 24, marginBottom: 4 },
  aiCardName:    { fontSize: 15, fontWeight: '700' },
  aiCardDose:    { fontSize: 12 },
  aiCardPurpose: { fontSize: 13, lineHeight: 18 },
  aiCardToggle: {
    alignSelf: 'flex-start',
    marginTop: 8,
    borderRadius: radius.full,
    borderWidth: 1.5,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  aiCardToggleText: { fontSize: 13, fontWeight: '700' },

  catScroll:        { marginBottom: 12 },
  catScrollContent: { gap: 8, paddingRight: 8 },
  catChip: {
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: '#ffffff22',
    paddingHorizontal: 14,
    paddingVertical: 7,
    backgroundColor: 'transparent',
  },
  catChipText: { fontSize: 13, fontWeight: '600' },

  list: { gap: 10 },
  suppCard: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radius.md,
    borderWidth: 1,
    padding: 12,
    gap: 10,
  },
  suppCardLeft:     { width: 38, alignItems: 'center' },
  suppCardIcon:     { fontSize: 26 },
  suppCardBody:     { flex: 1, gap: 3 },
  suppCardTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  suppCardName:     { fontSize: 14, fontWeight: '700' },
  aiRecBadge: {
    borderRadius: radius.full,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  aiRecBadgeText: { fontSize: 10, fontWeight: '700' },
  suppCardTagline:  { fontSize: 12 },
  suppCardMeta:     { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 },
  evidenceBadge:    { fontSize: 11, fontWeight: '600' },
  suppCardCategory: { fontSize: 11 },

  takeToggle: {
    width: 36, height: 36, borderRadius: 18,
    borderWidth: 1.5,
    alignItems: 'center', justifyContent: 'center',
  },
  takeToggleText: { fontSize: 16, fontWeight: '700' },

  // Detail modal
  detailBackdrop: { flex: 1, backgroundColor: '#00000066', justifyContent: 'flex-end' },
  detailSheet: {
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    borderTopWidth: 2,
    maxHeight: '90%',
  },
  sheetHandle: { width: 36, height: 4, borderRadius: 2, alignSelf: 'center', marginTop: 10, marginBottom: 6 },

  detailHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    gap: 10,
  },
  detailClose:     { fontSize: 15, fontWeight: '600' },
  detailTitle:     { flex: 1, fontSize: 16, fontWeight: '700', textAlign: 'center' },
  detailToggleBtn: {
    borderRadius: radius.full,
    borderWidth: 1.5,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  detailToggleBtnText: { fontSize: 13, fontWeight: '700' },

  detailContent: { padding: 16, gap: 16 },
  detailHero: {
    alignItems: 'center',
    borderRadius: radius.md,
    borderWidth: 1,
    padding: 20,
    gap: 6,
  },
  detailHeroIcon:    { fontSize: 48, marginBottom: 8 },
  detailHeroCategory:{ fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  detailHeroTagline: { fontSize: 14, textAlign: 'center', lineHeight: 20 },

  evidencePill: {
    borderRadius: radius.full,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 5,
    marginTop: 6,
  },
  evidencePillText: { fontSize: 12, fontWeight: '700' },

  detailBlock:      { gap: 6 },
  detailBlockTitle: { fontSize: 14, fontWeight: '700' },
  detailBlockText:  { fontSize: 14, lineHeight: 22 },

  detailDoseBlock: {
    borderRadius: radius.md,
    borderWidth: 1,
    padding: 14,
  },
  detailDoseRow:   { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, gap: 12 },
  detailDoseLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.5, width: 60 },
  detailDoseValue: { flex: 1, fontSize: 14, fontWeight: '500' },
  detailDivider:   { height: 1, marginVertical: 2 },

  goodForRow:  { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  goodForChip: { borderRadius: radius.full, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 4 },
  goodForText: { fontSize: 12, fontWeight: '600' },
});
