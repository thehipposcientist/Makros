// Supplement Stack V1 — Today / My Stack / Browse / Recs / History.
//
// Principles:
//   • Cautious language throughout ("may support", "consider"). Never
//     claims ("fixes", "boosts", "treats").
//   • Evidence + risk tiers visible on every stack card.
//   • Recommendations driven by food-side gaps from the 14-day rollup,
//     not generic marketing.
//   • Warnings (late caffeine, stimulant cycling, duplicates) surface
//     as insights, not as a separate medical panel.
//
// This screen replaces the old EditProfileScreen-based Supps tab.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, Alert, ActivityIndicator,
  Modal, TextInput, ImageBackground, useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getContrastingTextColor, getTheme } from '../constants/theme';
import PhotoScrim, { overPhotoTextShadow } from './PhotoScrim';
import type { AppThemeName, UserProfile } from '../types';
import { requirePro, tierOf } from '../utils/subscription';
import * as api from '../services/api';

interface Props {
  authToken: string;
  themeName?: AppThemeName;
  userProfile: UserProfile;
  embedded?: boolean;
  onSupplementsChanged?: () => void | Promise<void>;
}

type Section = 'today' | 'stack' | 'browse' | 'recommendations' | 'history';
type SupplementTiming = 'morning' | 'pre_workout' | 'post_workout' | 'with_meal' | 'evening' | 'bedtime';
type EffectivenessConfidence = 'high' | 'medium' | 'low';
type ThemeColors = ReturnType<typeof getTheme>['colors'];
type IoniconName = ComponentProps<typeof Ionicons>['name'];
type SupplementVisualSpec = { icon: IoniconName; color: string; imageId: string };
type SupplementVisualRule = {
  key: string;
  icon: IoniconName;
  color: string;
  imageIds: string[];
  aliases: string[];
};

const SUPPLEMENT_TIMINGS: SupplementTiming[] = ['morning', 'pre_workout', 'post_workout', 'with_meal', 'evening', 'bedtime'];
const INPUT_TEXT_RESET = { letterSpacing: 0, fontWeight: '400' as const };
const BROWSE_PAGE_SIZE = 18;
const BROWSE_FILTERS = [
  { key: 'all', label: 'All', terms: [] },
  { key: 'performance', label: 'Performance', terms: [
    'performance', 'strength', 'power', 'endurance', 'pre workout', 'pump',
    'blood flow', 'high intensity', 'interval', 'stimulant', 'energy',
    'creatine', 'caffeine', 'beta alanine', 'citrulline', 'beetroot',
    'nitrate', 'bicarbonate', 'taurine',
  ] },
  { key: 'sleep', label: 'Sleep', terms: [
    'sleep', 'bedtime', 'evening', 'relaxation', 'circadian', 'melatonin',
    'magnesium', 'glycine', 'zma', 'theanine', 'ashwagandha', 'tart cherry',
  ] },
  { key: 'recovery', label: 'Recovery', terms: [
    'recovery', 'soreness', 'joint', 'tendon', 'ligament', 'collagen',
    'inflammatory', 'inflammation', 'hydration', 'electrolyte', 'omega',
    'glutamine', 'hmb', 'curcumin', 'glucosamine',
  ] },
  { key: 'libido', label: 'Libido', terms: [
    'libido', 'hormone', 'testosterone', 'zinc', 'maca', 'ashwagandha',
    'vitamin d', 'ginseng', 'tongkat', 'maca root', 'black maca',
    'fenugreek', 'saffron', 'tribulus', 'epimedium', 'horny goat weed',
    'boron',
  ] },
  { key: 'protein', label: 'Protein', terms: [
    'protein', 'amino acid', 'whey', 'casein', 'plant protein', 'eaa',
    'bcaa', 'collagen',
  ] },
  { key: 'gut', label: 'Gut', terms: [
    'gut', 'digestive', 'digestion', 'probiotic', 'fiber', 'psyllium',
    'bowel', 'bloating', 'ginger',
  ] },
  { key: 'health', label: 'Health', terms: [
    'health', 'vitamin', 'mineral', 'fatty acid', 'antioxidant', 'immune',
    'bone', 'heart', 'cardiovascular', 'thyroid', 'micronutrient',
    'multivitamin', 'selenium', 'iodine', 'copper', 'coq10', 'garlic',
  ] },
  { key: 'weight', label: 'Weight', terms: [
    'weight', 'fat loss', 'fat oxidation', 'body composition', 'appetite',
    'glucose', 'metabolic', 'cla', 'berberine', 'apple cider vinegar',
    'green tea',
  ] },
] as const;

// Tier→color maps derive from theme so evidence/risk pills match the
// active palette. Built fresh per render inside components (tc is
// scoped). Blue "moderate evidence" maps to primaryLight — closest
// semantic on most themes; falls back to muted gray for "weak".
function tierColors(tc: ReturnType<typeof getTheme>['colors']) {
  return {
    evidence: {
      strong:   tc.success,
      moderate: tc.primaryLight ?? tc.primary,
      limited:  tc.warning,
      weak:     tc.textMuted,
    } as Record<string, string>,
    risk: {
      low:      tc.success,
      moderate: tc.warning,
      high:     tc.error,
    } as Record<string, string>,
  };
}

function confidenceColor(tc: ReturnType<typeof getTheme>['colors'], confidence?: string | null): string {
  if (confidence === 'high') return tc.success;
  if (confidence === 'medium') return tc.warning;
  return tc.textMuted;
}

function confidenceFromEvidence(evidence?: string | null): EffectivenessConfidence {
  if (evidence === 'strong') return 'high';
  if (evidence === 'moderate') return 'medium';
  return 'low';
}

function Pill({ label, color, onDark = false }: { label: string; color: string; onDark?: boolean }) {
  return (
    <View style={{
      backgroundColor: color + (onDark ? '33' : '1A'),
      paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999,
      alignSelf: 'flex-start',
    }}>
      <Text style={{ fontSize: 10, fontWeight: '700', color, letterSpacing: 0.3 }}>{label}</Text>
    </View>
  );
}

function e2eId(value: string | number | null | undefined): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function normalizeSupplementKey(value: string | null | undefined): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function supplementTextList(value: unknown): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value.flatMap(supplementTextList);
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return [];
    if (text.startsWith('[')) {
      try {
        return supplementTextList(JSON.parse(text));
      } catch {
        return [text];
      }
    }
    return [text];
  }
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap(supplementTextList);
  }
  return [String(value)];
}

function supplementBrowseText(ingredient: api.SupplementIngredient): string {
  return normalizeSupplementKey([
    ingredient.slug,
    ingredient.name,
    ingredient.category,
    ingredient.description,
    ingredient.timing_notes,
    ingredient.safety_notes,
    ...supplementTextList(ingredient.common_uses),
    ...supplementTextList(ingredient.deficiency_risks),
    ...supplementTextList(ingredient.excess_risks),
    ...supplementTextList(ingredient.food_sources),
  ].filter(Boolean).join(' '));
}

function ingredientMatchesBrowseFilter(ingredient: api.SupplementIngredient, filterKey: string): boolean {
  if (filterKey === 'all') return true;
  const filter = BROWSE_FILTERS.find(f => f.key === filterKey);
  if (!filter) return true;
  const searchable = supplementBrowseText(ingredient);
  return filter.terms.some(term => searchable.includes(normalizeSupplementKey(term)));
}

function supplementDoseLabel(amount?: number | null, unit?: string | null): string {
  const n = typeof amount === 'number' && Number.isFinite(amount) ? amount : null;
  const value = n == null ? '' : (Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, ''));
  return `${value}${unit ?? ''}`.trim();
}

function sortedTodaySupplementLogs(item: api.TodayStackItem): api.TodayStackItem['logs_today'] {
  return [...(item.logs_today || [])].sort((a, b) => new Date(a.taken_at).getTime() - new Date(b.taken_at).getTime());
}

function takenTodaySupplementLogs(item: api.TodayStackItem): api.TodayStackItem['logs_today'] {
  return sortedTodaySupplementLogs(item).filter(log => !log.skipped);
}

function skippedTodaySupplementLog(item: api.TodayStackItem): api.TodayStackItem['logs_today'][number] | undefined {
  return sortedTodaySupplementLogs(item).find(log => log.skipped);
}

function todayDoseSummary(item: api.TodayStackItem): string {
  const takenLogs = takenTodaySupplementLogs(item);
  if (takenLogs.length === 0) return '';
  if (takenLogs.length === 1) {
    const only = takenLogs[0];
    return supplementDoseLabel(only.dose_amount ?? item.dose_amount, only.dose_unit ?? item.dose_unit);
  }
  const units = new Set(takenLogs.map(log => log.dose_unit ?? item.dose_unit).filter(Boolean));
  if (units.size !== 1) return `${takenLogs.length} doses`;
  const unit = Array.from(units)[0];
  const total = takenLogs.reduce((sum, log) => {
    const amount = log.dose_amount ?? item.dose_amount;
    return Number.isFinite(amount) ? sum + Number(amount) : sum;
  }, 0);
  const totalLabel = total > 0 ? ` · ${supplementDoseLabel(total, unit)} total` : '';
  return `${takenLogs.length} doses${totalLabel}`;
}

type SupplementVisualInput = {
  custom_name?: string | null;
  ingredient_name?: string | null;
  ingredient_slug?: string | null;
  category?: string | null;
  source_terms?: string[] | null;
  food_sources?: string[] | null;
};

function supplementDisplayName(item: SupplementVisualInput): string {
  return item.custom_name || item.ingredient_name || 'Supplement';
}

function formatSupplementLabel(value?: string | null): string {
  const text = String(value || '').trim();
  if (!text) return '';
  return text
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function evidenceLabel(value?: string | null): string {
  if (value === 'strong') return 'Strong evidence';
  if (value === 'moderate') return 'Moderate evidence';
  if (value === 'limited') return 'Limited evidence';
  if (value === 'weak') return 'Weak evidence';
  return 'Evidence unknown';
}

function evidenceScore(value?: string | null): number {
  if (value === 'strong') return 3;
  if (value === 'moderate') return 2;
  if (value === 'limited') return 1;
  return 0;
}

function pexelsSupplementPhoto(id: string, width: number, height: number): string {
  return `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&w=${width}&h=${height}&fit=crop`;
}

const SUPPLEMENT_VISUAL_RULES: SupplementVisualRule[] = [
  {
    key: 'spirulina',
    icon: 'leaf-outline',
    color: '#15803D',
    imageIds: ['13787643', '5337681', '12049996'],
    aliases: ['spirulina', 'spirulina algae', 'blue green algae', 'blue-green algae', 'chlorella', 'chlorophyll'],
  },
  {
    key: 'fish',
    icon: 'fish-outline',
    color: '#0284C7',
    imageIds: ['14542171', '20062650', '19768979', '3296279', '128756'],
    aliases: ['omega 3', 'omega3', 'fish oil', 'epa', 'dha', 'cod liver', 'krill', 'fish', 'salmon', 'sardine', 'sardines', 'mackerel', 'anchovy', 'anchovies', 'trout', 'tuna', 'cod', 'seafood', 'shellfish', 'algae'],
  },
  {
    key: 'milk',
    icon: 'barbell-outline',
    color: '#EA580C',
    imageIds: ['17249985', '9432701', '16748187', '12984540', '2198626', '7907597', '11679219', '18333898', '13788116', '2347447'],
    aliases: ['whey', 'casein', 'milk protein', 'milk', 'dairy', 'lactose', 'cow', 'colostrum', 'calcium', 'cheese', 'cottage cheese'],
  },
  {
    key: 'yogurt',
    icon: 'leaf-outline',
    color: '#0D9488',
    imageIds: ['10421049', '17249985', '9432701'],
    aliases: ['probiotic', 'probiotics', 'lactobacillus', 'bifidobacterium', 'cfu', 'yogurt', 'greek yogurt', 'kefir', 'gut health'],
  },
  {
    key: 'egg',
    icon: 'egg-outline',
    color: '#CA8A04',
    imageIds: ['7333136', '6979973', '6294296', '566566'],
    aliases: ['egg', 'eggs', 'egg yolk', 'egg yolks', 'egg protein', 'albumin', 'ovalbumin', 'choline'],
  },
  {
    key: 'chicken',
    icon: 'restaurant-outline',
    color: '#D97706',
    imageIds: ['15532964', '6107722', '6107721'],
    aliases: ['chicken', 'poultry', 'turkey', 'chicken protein', 'beta alanine', 'beta-alanine', 'carnosine'],
  },
  {
    key: 'beef',
    icon: 'barbell-outline',
    color: '#B45309',
    imageIds: ['9541976', '18014999', '299347', '36829381'],
    aliases: ['beef', 'red meat', 'bovine', 'beef protein', 'desiccated liver', 'liver extract', 'creatine', 'coq10', 'coenzyme q10', 'iron', 'cla', 'carnitine'],
  },
  {
    key: 'pea',
    icon: 'leaf-outline',
    color: '#16A34A',
    imageIds: ['8878503', '4750266', '768098', '8801171', '6187593'],
    aliases: ['plant protein', 'pea protein', 'pea', 'peas', 'soy protein', 'soy foods', 'rice protein', 'hemp protein', 'vegan protein', 'plant based protein', 'legume', 'legumes', 'lentil', 'lentils', 'bean', 'beans'],
  },
  {
    key: 'seed',
    icon: 'nutrition-outline',
    color: '#A16207',
    imageIds: ['8653041', '9974504', '6187593', '2290078', '18275947'],
    aliases: ['almond', 'almonds', 'nut', 'nuts', 'seed', 'seeds', 'pumpkin seed', 'pumpkin seeds', 'flax', 'flaxseed', 'chia', 'hemp seed', 'sunflower seed', 'sesame', 'cashew', 'cashews', 'pistachio', 'pistachios', 'walnut', 'walnuts', 'magnesium', 'zinc', 'selenium', 'copper'],
  },
  {
    key: 'fiber',
    icon: 'leaf-outline',
    color: '#0D9488',
    imageIds: ['4725735', '10421049'],
    aliases: ['psyllium', 'fiber', 'fibre', 'soluble fiber', 'inulin', 'oat', 'oats', 'regularity', 'whole grain', 'whole grains'],
  },
  {
    key: 'vinegar',
    icon: 'flask-outline',
    color: '#B45309',
    imageIds: ['5471920', '35438467', '14630305', '5223214'],
    aliases: ['apple cider vinegar', 'apple vinegar', 'vinegar', 'acv'],
  },
  {
    key: 'coffee',
    icon: 'cafe-outline',
    color: '#7C2D12',
    imageIds: ['669161', '669164', '942801', '1695052', '894695'],
    aliases: ['caffeine', 'coffee', 'espresso', 'yerba mate', 'stimulant'],
  },
  {
    key: 'tea',
    icon: 'leaf-outline',
    color: '#15803D',
    imageIds: ['4390014', '463445', '4391986'],
    aliases: ['green tea', 'black tea', 'matcha', 'egcg', 'theanine', 'l theanine', 'l-theanine', 'tea extract'],
  },
  {
    key: 'cherry',
    icon: 'moon-outline',
    color: '#BE185D',
    imageIds: ['8973375', '1092730'],
    aliases: ['tart cherry', 'tart cherries', 'cherry', 'cherries', 'cherry juice', 'anthocyanin', 'anthocyanins', 'melatonin'],
  },
  {
    key: 'cranberry',
    icon: 'water-outline',
    color: '#BE123C',
    imageIds: ['7420867', '10421049'],
    aliases: ['cranberry', 'cranberries', 'cranberry juice', 'urinary tract', 'urinary'],
  },
  {
    key: 'watermelon',
    icon: 'flash-outline',
    color: '#2563EB',
    imageIds: ['16682100', '1337825', '1313267', '260426', '2288692'],
    aliases: ['citrulline', 'l citrulline', 'l-citrulline', 'citrulline malate', 'watermelon', 'cucumber', 'pumpkin', 'squash'],
  },
  {
    key: 'sunlight',
    icon: 'sunny-outline',
    color: '#CA8A04',
    imageIds: ['11199366', '2014775', '912110', '1261728', '301599'],
    aliases: ['vitamin d', 'vitamin d3', 'd3', 'cholecalciferol', 'sunlight', 'sunshine', 'sun exposure'],
  },
  {
    key: 'leafy',
    icon: 'leaf-outline',
    color: '#16A34A',
    imageIds: ['5945967', '3682192'],
    aliases: ['folate', 'folic acid', 'methylfolate', 'vitamin k', 'vitamin k2', 'k2', 'spinach', 'kale', 'leafy green', 'leafy greens', 'asparagus', 'arugula', 'celery', 'broccoli', 'spirulina'],
  },
  {
    key: 'banana',
    icon: 'speedometer-outline',
    color: '#CA8A04',
    imageIds: ['20233144', '27580157'],
    aliases: ['potassium', 'banana', 'bananas', 'potato', 'potatoes', 'coconut water', 'electrolyte', 'electrolytes'],
  },
  {
    key: 'avocado',
    icon: 'nutrition-outline',
    color: '#65A30D',
    imageIds: ['27580157', '5945967'],
    aliases: ['vitamin e', 'tocopherol', 'avocado', 'healthy fat', 'olive oil', 'boron', 'prune', 'prunes', 'raisin', 'raisins'],
  },
  {
    key: 'mushroom',
    icon: 'leaf-outline',
    color: '#78716C',
    imageIds: ['5601517', '340874', '1716001', '10123049'],
    aliases: ['mushroom', 'mushrooms', 'fungi', 'ergocalciferol', 'vitamin d2', 'd2', 'lion mane', "lion's mane", 'reishi', 'cordyceps'],
  },
  {
    key: 'beet',
    icon: 'flash-outline',
    color: '#BE123C',
    imageIds: ['29436276', '4963554', '5502849', '29355934', '29546374', '8618970', '20517382', '25397899', '33893317'],
    aliases: ['beet', 'beets', 'beetroot', 'beet root', 'beet juice', 'nitrate', 'nitrates'],
  },
  {
    key: 'citrus',
    icon: 'shield-checkmark-outline',
    color: '#EA580C',
    imageIds: ['28255125', '10866144', '28255124', '2288683', '10727027'],
    aliases: ['vitamin c', 'ascorbic acid', 'citrus', 'orange', 'oranges', 'lemon', 'lemons', 'kiwi', 'strawberries', 'strawberry', 'bell pepper', 'bell peppers', 'cantaloupe'],
  },
  {
    key: 'cocoa',
    icon: 'cafe-outline',
    color: '#7C2D12',
    imageIds: ['11178470', '4113306', '11178478'],
    aliases: ['cocoa', 'cacao', 'dark chocolate', 'chocolate', 'flavanol', 'flavanols'],
  },
  {
    key: 'fenugreek',
    icon: 'leaf-outline',
    color: '#A16207',
    imageIds: ['27867128', '5987968'],
    aliases: ['fenugreek', 'trigonella', 'fenugreek seed', 'fenugreek seeds', 'fenugreek leaves'],
  },
  {
    key: 'maca',
    icon: 'flame-outline',
    color: '#DB2777',
    imageIds: ['16122309'],
    aliases: ['maca', 'maca root', 'black maca', 'black maca root', 'lepidium meyenii'],
  },
  {
    key: 'ashwagandha',
    icon: 'leaf-outline',
    color: '#16A34A',
    imageIds: ['16122309', '4871365'],
    aliases: ['ashwagandha', 'ashwagandha root', 'withania somnifera'],
  },
  {
    key: 'ginseng',
    icon: 'leaf-outline',
    color: '#B45309',
    imageIds: ['16122309', '4871365'],
    aliases: ['panax ginseng', 'asian ginseng', 'red ginseng', 'korean ginseng', 'ginseng root'],
  },
  {
    key: 'saffron',
    icon: 'flower-outline',
    color: '#DB2777',
    imageIds: ['33654800', '10487658'],
    aliases: ['saffron', 'saffron stigma', 'saffron stigmas', 'crocus sativus', 'crocus', 'crocin', 'crocins', 'safranal'],
  },
  {
    key: 'tribulus',
    icon: 'flower-outline',
    color: '#CA8A04',
    imageIds: ['36638498'],
    aliases: ['tribulus', 'tribulus terrestris', 'puncture vine', 'protodioscin'],
  },
  {
    key: 'barberry',
    icon: 'leaf-outline',
    color: '#BE123C',
    imageIds: ['5668188', '19167320', '15204915', '5876243'],
    aliases: ['berberine', 'barberry', 'barberries', 'goldenseal', 'oregon grape', 'berberis'],
  },
  {
    key: 'root',
    icon: 'flame-outline',
    color: '#DB2777',
    imageIds: ['16122309', '4871365'],
    aliases: ['tongkat', 'tongkat ali', 'eurycoma', 'eurycoma longifolia', 'long jack', 'malaysian ginseng'],
  },
  {
    key: 'herb',
    icon: 'leaf-outline',
    color: '#16A34A',
    imageIds: ['7988019', '20234970', '20234958', '31346461', '6220710', '17380332'],
    aliases: ['rhodiola', 'turmeric', 'curcumin', 'ginger', 'adaptogen', 'herb', 'herbal', 'root', 'epimedium', 'horny goat weed', 'icariin', 'yin yang huo'],
  },
  {
    key: 'garlic',
    icon: 'leaf-outline',
    color: '#78716C',
    imageIds: ['18275947'],
    aliases: ['garlic', 'garlic cloves', 'allicin'],
  },
  {
    key: 'collagen',
    icon: 'heart-circle-outline',
    color: '#059669',
    imageIds: ['19141522', '6475116', '6475115', '17592733', '16768137', '16381140', '6189293'],
    aliases: ['collagen', 'gelatin', 'peptide', 'peptides', 'bone broth', 'broth', 'marine collagen', 'glycine', 'shellfish shell', 'shellfish shells', 'cartilage', 'glucosamine'],
  },
  {
    key: 'whole-food',
    icon: 'restaurant-outline',
    color: '#64748B',
    imageIds: ['5945967', '28255125', '8653041', '14542171', '17249985'],
    aliases: ['multivitamin', 'micronutrient', 'vitamin', 'mineral', 'vegetables', 'vegetable', 'fruit', 'fruits', 'whole foods', 'balanced diet'],
  },
  {
    key: 'powder',
    icon: 'flash-outline',
    color: '#2563EB',
    imageIds: ['13013778', '17820731', '17820707', '6475116', '6475115'],
    aliases: ['bicarbonate', 'sodium bicarbonate', 'baking soda', 'pre workout', 'pre-workout', 'performance', 'powder', 'protein powder', 'supplement'],
  },
];

function findSupplementVisualRule(text: string): SupplementVisualRule | null {
  if (!text) return null;
  return SUPPLEMENT_VISUAL_RULES.find(rule =>
    rule.aliases.some(alias => normalizedSupplementTextIncludes(text, alias))
  ) ?? null;
}

function normalizedSupplementTextIncludes(text: string, alias: string): boolean {
  const normalizedText = ` ${normalizeSupplementKey(text)} `;
  const normalizedAlias = normalizeSupplementKey(alias);
  return Boolean(normalizedAlias) && normalizedText.includes(` ${normalizedAlias} `);
}

function findSupplementVisualRuleForSources(sources?: string[] | null): SupplementVisualRule | null {
  for (const source of supplementTextList(sources)) {
    const match = findSupplementVisualRule(normalizeSupplementKey(source));
    if (match) return match;
  }
  return null;
}

function supplementVisualSpec(item: SupplementVisualInput): SupplementVisualSpec {
  const identityText = normalizeSupplementKey([
    item.ingredient_slug,
    item.custom_name,
    item.ingredient_name,
  ].filter(Boolean).join(' '));
  const foodSources = supplementTextList(item.food_sources);
  const sourceText = normalizeSupplementKey(supplementTextList(item.source_terms).join(' '));
  const categoryText = normalizeSupplementKey(item.category ?? '');

  const rule =
    findSupplementVisualRule(identityText) ??
    findSupplementVisualRuleForSources(foodSources) ??
    findSupplementVisualRule(sourceText) ??
    findSupplementVisualRule(categoryText) ??
    SUPPLEMENT_VISUAL_RULES.find(r => r.key === 'whole-food')!;
  const imageSeed = [
    identityText,
    ...foodSources.map(source => normalizeSupplementKey(source)),
    sourceText,
    categoryText,
    rule.key,
  ].filter(Boolean).join(':');
  const imageId = rule.imageIds[supplementImageIndex(imageSeed, rule.imageIds.length)] ?? rule.imageIds[0];
  return { icon: rule.icon, color: rule.color, imageId };
}

function supplementImageIndex(seed: string, count: number): number {
  if (count <= 1) return 0;
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % count;
}

function SupplementImageFallback({
  visual,
  tc,
  height,
  width,
}: {
  visual: SupplementVisualSpec;
  tc: ThemeColors;
  height: number;
  width: number;
}) {
  return (
    <View
      style={{
        width,
        height,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: visual.color + '33',
        backgroundColor: visual.color + '14',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
      }}
    >
      <View
        style={{
          width: Math.min(width - 18, 38),
          height: Math.min(width - 18, 38),
          borderRadius: 999,
          backgroundColor: tc.background,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Ionicons name={visual.icon} size={Math.max(20, Math.min(width, height) * 0.34)} color={visual.color} />
      </View>
    </View>
  );
}

function SupplementSourceImage({
  item,
  tc,
  height = 74,
  width = 72,
}: {
  item: SupplementVisualInput;
  tc: ThemeColors;
  height?: number;
  width?: number;
}) {
  const visual = supplementVisualSpec(item);
  const imageUri = pexelsSupplementPhoto(visual.imageId, 260, 220);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setImageFailed(false);
  }, [imageUri]);

  if (imageFailed) {
    return <SupplementImageFallback visual={visual} tc={tc} height={height} width={width} />;
  }

  return (
    <ImageBackground
      source={{ uri: imageUri }}
      resizeMode="cover"
      onError={() => setImageFailed(true)}
      style={{
        width,
        height,
        borderRadius: 10,
        overflow: 'hidden',
        justifyContent: 'flex-end',
        backgroundColor: visual.color + '14',
      }}
      imageStyle={{ borderRadius: 10 }}
    >
      <View style={{
        position: 'absolute',
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        backgroundColor: 'rgba(0,0,0,0.18)',
      }} />
    </ImageBackground>
  );
}

function SupplementCardImageHeader({
  item,
  tc,
  height = 138,
  children,
}: {
  item: SupplementVisualInput;
  tc: ThemeColors;
  height?: number;
  children?: ReactNode;
}) {
  const visual = supplementVisualSpec(item);
  const imageUri = pexelsSupplementPhoto(visual.imageId, 720, 360);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setImageFailed(false);
  }, [imageUri]);

  const overlay = (
    <>
      <View style={{
        position: 'absolute',
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        backgroundColor: imageFailed ? 'transparent' : 'rgba(0,0,0,0.18)',
      }} />
      <View style={{
        position: 'absolute',
        left: 12,
        top: 12,
        width: 38,
        height: 38,
        borderRadius: 19,
        backgroundColor: imageFailed ? tc.background : 'rgba(0,0,0,0.42)',
        borderWidth: imageFailed ? 1 : 0,
        borderColor: visual.color + '40',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        <Ionicons name={visual.icon} size={19} color={imageFailed ? visual.color : '#fff'} />
      </View>
      {children}
    </>
  );

  if (imageFailed) {
    return (
      <View style={{
        height,
        backgroundColor: visual.color + '18',
        overflow: 'hidden',
      }}>
        <View style={{
          position: 'absolute',
          right: -34,
          top: -44,
          width: 138,
          height: 138,
          borderRadius: 69,
          backgroundColor: visual.color + '20',
        }} />
        {overlay}
      </View>
    );
  }

  return (
    <ImageBackground
      source={{ uri: imageUri }}
      resizeMode="cover"
      onError={() => setImageFailed(true)}
      style={{ height, justifyContent: 'flex-end', backgroundColor: visual.color + '18' }}
    >
      {overlay}
    </ImageBackground>
  );
}

function SupplementHeroHeader({
  item,
  title,
  subtitle,
  tc,
  onClose,
  height = 168,
}: {
  item: SupplementVisualInput;
  title: string;
  subtitle?: string | null;
  tc: ThemeColors;
  onClose: () => void;
  height?: number;
}) {
  const visual = supplementVisualSpec(item);
  const imageUri = pexelsSupplementPhoto(visual.imageId, 900, 420);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setImageFailed(false);
  }, [imageUri]);

  const closeButton = (onDark: boolean) => (
    <TouchableOpacity
      onPress={onClose}
      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      style={{
        position: 'absolute',
        top: 12,
        right: 12,
        width: 34,
        height: 34,
        borderRadius: 17,
        backgroundColor: onDark ? 'rgba(0,0,0,0.42)' : tc.surface,
        borderWidth: onDark ? 0 : 1,
        borderColor: tc.border,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Ionicons name="close" size={19} color={onDark ? '#fff' : tc.textSecondary} />
    </TouchableOpacity>
  );

  const titleBlock = (onDark: boolean) => (
    <View style={{ padding: 16, gap: 6 }}>
      <Text style={[{ color: onDark ? '#fff' : tc.textPrimary, fontSize: 22, fontWeight: '900' }, onDark && overPhotoTextShadow]} numberOfLines={2}>
        {title}
      </Text>
      {subtitle ? (
        <Text style={[{ color: onDark ? '#fff' : tc.textSecondary, fontSize: 11, fontWeight: '800', opacity: onDark ? 0.88 : 1 }, onDark && overPhotoTextShadow]} numberOfLines={1}>
          {subtitle}
        </Text>
      ) : null}
    </View>
  );

  if (!imageFailed) {
    return (
      <ImageBackground
        source={{ uri: imageUri }}
        resizeMode="cover"
        onError={() => setImageFailed(true)}
        style={{ height, justifyContent: 'flex-end', backgroundColor: visual.color + '18' }}
      >
        <View style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 0,
          bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.36)',
        }} />
        <PhotoScrim strength="soft" />
        {closeButton(true)}
        {titleBlock(true)}
      </ImageBackground>
    );
  }

  return (
    <View style={{
      height,
      justifyContent: 'flex-end',
      backgroundColor: visual.color + '18',
      overflow: 'hidden',
    }}>
      <View style={{
        position: 'absolute',
        top: -38,
        right: -26,
        width: 142,
        height: 142,
        borderRadius: 71,
        backgroundColor: visual.color + '22',
      }} />
      <View style={{
        position: 'absolute',
        left: 16,
        top: 18,
        width: 56,
        height: 56,
        borderRadius: 18,
        backgroundColor: tc.background,
        borderWidth: 1,
        borderColor: visual.color + '3D',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        <Ionicons name={visual.icon} size={27} color={visual.color} />
      </View>
      {closeButton(false)}
      {titleBlock(false)}
    </View>
  );
}

function EvidenceGauge({
  tier,
  tc,
  tiers,
}: {
  tier?: string | null;
  tc: ReturnType<typeof getTheme>['colors'];
  tiers: ReturnType<typeof tierColors>;
}) {
  const score = evidenceScore(tier);
  const color = tiers.evidence[tier || ''] || tc.textMuted;
  return (
    <View style={{ minWidth: 92 }}>
      <View style={{ flexDirection: 'row', gap: 3, marginBottom: 4 }}>
        {[1, 2, 3].map(level => (
          <View
            key={level}
            style={{
              flex: 1,
              height: 5,
              borderRadius: 3,
              backgroundColor: score >= level ? color : tc.border,
            }}
          />
        ))}
      </View>
      <Text style={{ fontSize: 10, fontWeight: '800', color }} numberOfLines={1}>
        {evidenceLabel(tier)}
      </Text>
    </View>
  );
}

function RiskBadge({
  tier,
  tc,
  tiers,
}: {
  tier?: string | null;
  tc: ReturnType<typeof getTheme>['colors'];
  tiers: ReturnType<typeof tierColors>;
}) {
  const color = tiers.risk[tier || ''] || tc.textMuted;
  const label = tier ? `${String(tier).toUpperCase()} RISK` : 'RISK UNKNOWN';
  return (
    <View style={{
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      borderRadius: 999,
      paddingHorizontal: 8,
      paddingVertical: 4,
      backgroundColor: color + '18',
      borderWidth: 1,
      borderColor: color + '55',
    }}>
      <Ionicons
        name={tier === 'high' ? 'warning-outline' : tier === 'moderate' ? 'alert-circle-outline' : 'shield-checkmark-outline'}
        size={11}
        color={color}
      />
      <Text style={{ fontSize: 10, fontWeight: '800', color }}>{label}</Text>
    </View>
  );
}

function DetailListBlock({
  title,
  items,
  tc,
  icon = 'ellipse',
  tone = 'surface',
}: {
  title: string;
  items?: string[] | null;
  tc: ReturnType<typeof getTheme>['colors'];
  icon?: ComponentProps<typeof Ionicons>['name'];
  tone?: 'surface' | 'warning' | 'error';
}) {
  const clean = supplementTextList(items).map(x => String(x || '').trim()).filter(Boolean);
  if (!clean.length) return null;
  const borderColor = tone === 'error' ? tc.error + '44' : tone === 'warning' ? tc.warning + '55' : tc.border;
  const backgroundColor = tone === 'error' ? tc.error + '10' : tone === 'warning' ? tc.warning + '14' : tc.surface;
  const iconColor = tone === 'error' ? tc.error : tone === 'warning' ? tc.warning : tc.primary;
  return (
    <View style={{
      backgroundColor,
      borderRadius: 10,
      borderWidth: 1,
      borderColor,
      padding: 12,
      gap: 8,
    }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Ionicons name={icon} size={14} color={iconColor} />
        <Text style={{ fontSize: 12, fontWeight: '900', color: tone === 'surface' ? tc.textPrimary : iconColor }}>
          {title}
        </Text>
      </View>
      <View style={{ gap: 6 }}>
        {clean.map((entry, idx) => (
          <View key={`${title}-${idx}-${entry}`} style={{ flexDirection: 'row', gap: 7, alignItems: 'flex-start' }}>
            <View style={{
              width: 4,
              height: 4,
              borderRadius: 2,
              backgroundColor: iconColor,
              marginTop: 7,
            }} />
            <Text style={{ flex: 1, fontSize: 12, color: tc.textSecondary, lineHeight: 18 }}>
              {entry}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function UsageGuidanceBlock({
  guidance,
  tc,
}: {
  guidance?: api.SupplementUsageGuidance | null;
  tc: ReturnType<typeof getTheme>['colors'];
}) {
  if (!guidance) return null;
  const color = guidance.severity === 'warning' ? tc.warning : tc.primary;
  return (
    <View style={{
      backgroundColor: color + '14',
      borderRadius: 10,
      borderWidth: 1,
      borderColor: color + '55',
      padding: 12,
      gap: 8,
    }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Ionicons name="repeat-outline" size={14} color={color} />
        <Text style={{ fontSize: 12, fontWeight: '900', color }}>{guidance.title}</Text>
      </View>
      <Text style={{ fontSize: 12, color: tc.textSecondary, lineHeight: 18 }}>
        {guidance.body}
      </Text>
      {guidance.cadence ? (
        <Text style={{ fontSize: 11, color: tc.textMuted, lineHeight: 16 }}>
          {guidance.cadence}
        </Text>
      ) : null}
    </View>
  );
}

function isCaffeineItem(item: api.TodayStackItem): boolean {
  const text = [
    item.ingredient_slug,
    item.ingredient_name,
    item.custom_name,
  ].filter(Boolean).join(' ').toLowerCase();
  return text.includes('caffeine') || text.includes('pre workout') || text.includes('pre-workout');
}

function supplementHistoryDateLabel(value: string): string {
  const d = new Date(value);
  const today = new Date();
  const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const startDate = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startToday - startDate) / 86400000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

function supplementHistoryTimeLabel(value: string): string {
  return new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function localDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function supplementLogDateKey(value: string): string {
  return localDateKey(new Date(value));
}

function localDateFromKey(key: string): Date {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
}

function addLocalDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function buildCalendarWeeks(year: number, month: number): Array<Array<Date | null>> {
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const cursor = new Date(year, month, 1 - first.getDay());
  const weeks: Array<Array<Date | null>> = [];
  while (cursor <= last || cursor.getDay() !== 0) {
    const week: Array<Date | null> = [];
    for (let i = 0; i < 7; i += 1) {
      week.push(cursor.getMonth() === month ? new Date(cursor) : null);
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(week);
    if (weeks.length >= 6) break;
  }
  return weeks;
}

function recentCalendarMonths(count: number): Date[] {
  const now = new Date();
  return Array.from({ length: count }, (_, index) => new Date(now.getFullYear(), now.getMonth() - index, 1));
}

function shortDateLabel(key: string): string {
  const date = localDateFromKey(key);
  const todayKey = localDateKey(new Date());
  const yesterdayKey = localDateKey(addLocalDays(new Date(), -1));
  if (key === todayKey) return 'Today';
  if (key === yesterdayKey) return 'Yesterday';
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function calendarMonthLabel(month: Date): string {
  return month.toLocaleDateString([], { month: 'long', year: 'numeric' });
}

function defaultDoseTime(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

function parseTodayDoseTime(value: string): string | null {
  const raw = value.trim().toLowerCase();
  if (!raw) return null;
  const meridiem = raw.match(/\b(am|pm)\b/)?.[1] ?? null;
  const cleaned = raw.replace(/\b(am|pm)\b/g, '').replace(/[^\d:]/g, '');
  const [hourRaw, minuteRaw = '0'] = cleaned.split(':');
  let hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  const date = new Date();
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
}

function loadErrorMessage(label: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error || '');
  if (!detail || detail === 'session_expired') return `Could not load ${label}.`;
  return `Could not load ${label}: ${detail}`;
}

export default function SupplementStackScreen({ authToken, themeName, userProfile, embedded = false, onSupplementsChanged }: Props) {
  const { height: windowHeight } = useWindowDimensions();
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const tiers = useMemo(() => tierColors(tc), [tc]);
  const isProTier = tierOf(userProfile) === 'pro';

  const [section, setSection] = useState<Section>('today');
  const [loading, setLoading] = useState(false);
  const [coreLoadError, setCoreLoadError] = useState<string | null>(null);
  const [today, setToday] = useState<api.TodayStackItem[]>([]);
  const [stack, setStack] = useState<api.StackItem[]>([]);
  const [ingredients, setIngredients] = useState<api.SupplementIngredient[]>([]);
  const [ingredientsLoading, setIngredientsLoading] = useState(false);
  const [ingredientsLoadError, setIngredientsLoadError] = useState<string | null>(null);
  const [recs, setRecs] = useState<api.SupplementRecommendation[]>([]);
  const [recsLoading, setRecsLoading] = useState(false);
  const [recsLoadError, setRecsLoadError] = useState<string | null>(null);
  const [insights, setInsights] = useState<Array<{ key: string; severity: string; title: string; body: string }>>([]);
  const [history, setHistory] = useState<api.SupplementHistoryResponse | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoadError, setHistoryLoadError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [addInitialIngredient, setAddInitialIngredient] = useState<api.SupplementIngredient | null>(null);
  const [browseSearch, setBrowseSearch] = useState('');
  const [browseCategory, setBrowseCategory] = useState('all');
  const [caffeineLogTarget, setCaffeineLogTarget] = useState<api.TodayStackItem | null>(null);
  const [groupEditTarget, setGroupEditTarget] = useState<api.StackItem | null>(null);
  const [editTarget, setEditTarget] = useState<(api.StackItem | api.TodayStackItem) | null>(null);
  const [detailTarget, setDetailTarget] = useState<(api.StackItem | api.TodayStackItem) | null>(null);
  const [historyCalendarTarget, setHistoryCalendarTarget] = useState<(api.StackItem | api.TodayStackItem) | null>(null);
  const [recDetailTarget, setRecDetailTarget] = useState<api.SupplementRecommendation | null>(null);
  const [ingredientDetailTarget, setIngredientDetailTarget] = useState<api.SupplementIngredient | null>(null);
  const [browseVisibleCount, setBrowseVisibleCount] = useState(BROWSE_PAGE_SIZE);
  const reloadSeqRef = useRef(0);
  const historySeqRef = useRef(0);
  const reloadRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selectSection = useCallback((next: Section) => {
    setSection(next);
  }, []);

  const openAddSupplement = useCallback((ingredient?: api.SupplementIngredient | null) => {
    setAddInitialIngredient(ingredient ?? null);
    setShowAdd(true);
  }, []);

  const closeAddSupplement = useCallback(() => {
    setShowAdd(false);
    setAddInitialIngredient(null);
  }, []);

  const reload = useCallback(async () => {
    const token = authToken?.trim();
    if (!token) {
      setLoading(false);
      setCoreLoadError(null);
      setIngredientsLoading(false);
      setIngredientsLoadError(null);
      setRecsLoading(false);
      setRecsLoadError(null);
      setHistory(null);
      setHistoryLoading(false);
      setHistoryLoadError(null);
      return;
    }
    if (reloadRetryTimerRef.current) {
      clearTimeout(reloadRetryTimerRef.current);
      reloadRetryTimerRef.current = null;
    }
    const seq = ++reloadSeqRef.current;
    setLoading(true);
    setCoreLoadError(null);
    setIngredientsLoading(true);
    setIngredientsLoadError(null);
    setRecsLoading(true);
    setRecsLoadError(null);

    const ingredientsPromise = api.listSupplementIngredients()
      .then((items) => ({ items, error: null as string | null }))
      .catch((error) => ({
        items: [] as api.SupplementIngredient[],
        error: loadErrorMessage('the supplement library', error),
      }));
    const loadExtras = async (attempt = 0): Promise<void> => {
      let hadFailure = false;
      const safeExtra = async <T,>(promise: Promise<T>, fallback: T): Promise<T> => {
        try {
          return await promise;
        } catch {
          hadFailure = true;
          return fallback;
        }
      };

      const [r, ins] = await Promise.all([
        safeExtra(api.getSupplementRecommendations(token), { recommendations: [], warnings: { duplicate_ingredient_ids: [] } }),
        isProTier
          ? safeExtra(api.getSupplementInsights(token), { insights: [] })
          : Promise.resolve({ insights: [] }),
      ]);
      if (seq !== reloadSeqRef.current) return;
      setRecs(r.recommendations || []);
      setInsights(ins.insights || []);
      if (hadFailure && attempt < 1) {
        reloadRetryTimerRef.current = setTimeout(() => {
          void loadExtras(attempt + 1);
        }, 650);
        return;
      }
      setRecsLoadError(hadFailure ? 'Could not load supplement recommendations right now.' : null);
      setRecsLoading(false);
    };

    void ingredientsPromise.then(({ items, error }) => {
      if (seq !== reloadSeqRef.current) return;
      setIngredients(items);
      setIngredientsLoadError(error);
      setIngredientsLoading(false);
    });
    void loadExtras().catch(() => {
      if (seq === reloadSeqRef.current) {
        setRecsLoadError('Could not load supplement recommendations right now.');
        setRecsLoading(false);
      }
    });

    const coreFailures: string[] = [];
    const safeCore = async <T,>(label: string, promise: Promise<T>, fallback: T): Promise<T> => {
      try {
        return await promise;
      } catch (error) {
        coreFailures.push(loadErrorMessage(label, error));
        return fallback;
      }
    };

    try {
      const [t, s] = await Promise.all([
        safeCore('today’s supplement schedule', api.getTodaySupplements(token), [] as api.TodayStackItem[]),
        safeCore('your supplement stack', api.listStack(token), [] as api.StackItem[]),
      ]);
      if (seq !== reloadSeqRef.current) return;
      setToday(t); setStack(s);
      void onSupplementsChanged?.();
      setCoreLoadError(coreFailures[0] ?? null);
    } finally {
      if (seq === reloadSeqRef.current) {
        setLoading(false);
      }
    }
  }, [authToken, isProTier, onSupplementsChanged]);

  useEffect(() => { reload(); }, [reload]);

  const loadHistory = useCallback(async () => {
    const token = authToken?.trim();
    if (!token) {
      setHistory(null);
      setHistoryLoading(false);
      setHistoryLoadError(null);
      return;
    }
    const seq = ++historySeqRef.current;
    setHistoryLoading(true);
    setHistoryLoadError(null);
    try {
      const result = await api.getSupplementHistory(token, 30, 200);
      if (seq !== historySeqRef.current) return;
      setHistory(result);
    } catch (error) {
      if (seq !== historySeqRef.current) return;
      setHistoryLoadError(loadErrorMessage('supplement history', error));
    } finally {
      if (seq === historySeqRef.current) setHistoryLoading(false);
    }
  }, [authToken]);

  useEffect(() => {
    if (section === 'history') {
      void loadHistory();
    }
  }, [section, loadHistory]);

  useEffect(() => () => {
    if (reloadRetryTimerRef.current) clearTimeout(reloadRetryTimerRef.current);
    reloadSeqRef.current += 1;
    historySeqRef.current += 1;
  }, []);

  useEffect(() => {
    setBrowseVisibleCount(BROWSE_PAGE_SIZE);
  }, [browseCategory, browseSearch]);

  const handleMarkTaken = async (item: api.TodayStackItem, skipped = false) => {
    if (!skipped && isCaffeineItem(item)) {
      setCaffeineLogTarget(item);
      return;
    }
    try {
      await api.logDose(authToken, item.id, { skipped });
      reload();
    } catch (e: any) {
      Alert.alert('Could not log', String(e?.message ?? e));
    }
  };

  // Undo a supplement accidentally marked taken (or skipped) today.
  const handleUntake = async (item: api.TodayStackItem) => {
    try {
      await api.unlogDose(authToken, item.id);
      reload();
    } catch (e: any) {
      Alert.alert('Could not undo', String(e?.message ?? e));
    }
  };

  const [takingAll, setTakingAll] = useState(false);
  const [skippingAll, setSkippingAll] = useState(false);
  const handleTakeAll = async () => {
    // Pending = scheduled today but not yet logged (taken or skipped).
    // We only flip those so a previously-skipped item isn't silently
    // converted into a "taken" by the bulk button.
    const pending = today.filter(item => {
      const logs = item.logs_today || [];
      return !logs.find(l => !l.skipped) && !logs.find(l => l.skipped);
    });
    if (pending.length === 0) return;
    setTakingAll(true);
    try {
      // Serial so the backend's timestamps don't collide and the
      // logs_today echo back in a predictable order.
      for (const item of pending) {
        await api.logDose(authToken, item.id, { skipped: false }).catch(() => null);
      }
      import('../utils/feedback').then(f => f.hapticSuccess()).catch(() => {});
      reload();
    } catch (e: any) {
      Alert.alert('Could not log', String(e?.message ?? e));
    } finally {
      setTakingAll(false);
    }
  };
  const handleSkipAll = async () => {
    const pending = today.filter(item => {
      const logs = item.logs_today || [];
      return !logs.find(l => !l.skipped) && !logs.find(l => l.skipped);
    });
    if (pending.length === 0) return;
    setSkippingAll(true);
    try {
      for (const item of pending) {
        await api.logDose(authToken, item.id, { skipped: true }).catch(() => null);
      }
      import('../utils/feedback').then(f => f.hapticLight()).catch(() => {});
      reload();
    } catch (e: any) {
      Alert.alert('Could not skip', String(e?.message ?? e));
    } finally {
      setSkippingAll(false);
    }
  };

  // ── Group helpers ────────────────────────────────────────────────
  // A "group" is either the user's custom group_label OR the built-in
  // timing bucket. Items with neither fall under "Other" so the screen
  // still renders cleanly. Groups display in a stable order so morning
  // shows before evening, etc.
  const TIMING_ORDER: Record<string, number> = {
    morning: 0, pre_workout: 1, post_workout: 2, with_meal: 3, evening: 4, bedtime: 5,
  };
  const titleCase = (s: string): string =>
    s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  type SupplementGroup<T> = { kind: 'custom' | 'timing' | 'other'; key: string; label: string; items: T[] };
  const buildGroups = <T extends { group_label?: string | null; timing?: string | null }>(items: T[]): SupplementGroup<T>[] => {
    const groups = new Map<string, SupplementGroup<T>>();
    for (const it of items) {
      const customGroup = (it.group_label ?? '').toString().trim();
      const timingBucket = (it.timing ?? '').toString().trim();
      let kind: SupplementGroup<T>['kind'];
      let key: string;
      let label: string;
      if (customGroup) {
        kind = 'custom'; key = `c:${customGroup.toLowerCase()}`; label = customGroup;
      } else if (timingBucket) {
        kind = 'timing'; key = `t:${timingBucket}`; label = titleCase(timingBucket);
      } else {
        kind = 'other'; key = 'other'; label = 'Other';
      }
      const existing = groups.get(key);
      if (existing) existing.items.push(it);
      else groups.set(key, { kind, key, label, items: [it] });
    }
    return Array.from(groups.values()).sort((a, b) => {
      // Custom groups float to top (they're more intentional).
      if (a.kind !== b.kind) {
        const order = { custom: 0, timing: 1, other: 2 };
        return order[a.kind] - order[b.kind];
      }
      if (a.kind === 'timing' && b.kind === 'timing') {
        const ka = a.key.replace('t:', '');
        const kb = b.key.replace('t:', '');
        return (TIMING_ORDER[ka] ?? 99) - (TIMING_ORDER[kb] ?? 99);
      }
      return a.label.localeCompare(b.label);
    });
  };

  const [takingGroupKey, setTakingGroupKey] = useState<string | null>(null);
  const handleTakeGroup = async (group: SupplementGroup<api.TodayStackItem>) => {
    const pending = group.items.filter(i => {
      const logs = i.logs_today || [];
      return !logs.find(l => !l.skipped) && !logs.find(l => l.skipped);
    });
    if (pending.length === 0) return;
    setTakingGroupKey(group.key);
    try {
      // Use the dedicated bulk endpoint when possible — single roundtrip
      // and the backend dedupes against today's existing logs. Falls
      // through to per-item logs only if the bulk call fails.
      try {
        if (group.kind === 'custom') {
          await api.logSupplementGroup(authToken, { group_label: group.label });
        } else if (group.kind === 'timing') {
          await api.logSupplementGroup(authToken, { timing: group.key.replace('t:', '') });
        } else {
          throw new Error('use per-item fallback');
        }
      } catch {
        for (const item of pending) {
          await api.logDose(authToken, item.id, { skipped: false }).catch(() => null);
        }
      }
      import('../utils/feedback').then(f => f.hapticSuccess()).catch(() => {});
      reload();
    } catch (e: any) {
      Alert.alert('Could not log group', String(e?.message ?? e));
    } finally {
      setTakingGroupKey(null);
    }
  };

  const handleRemove = (item: api.StackItem) => {
    Alert.alert(
      'Remove from stack?',
      `"${item.custom_name || 'Supplement'}" will no longer appear in Today.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove', style: 'destructive', onPress: async () => {
            try { await api.deleteStackItem(authToken, item.id); setDetailTarget(null); reload(); }
            catch (e: any) { Alert.alert('Could not remove', String(e?.message ?? e)); }
          },
        },
      ],
    );
  };

  const handleSaveGroup = async (item: api.StackItem, patch: { timing?: string | null; group_label?: string | null }) => {
    try {
      await api.updateStackItem(authToken, item.id, patch);
      setGroupEditTarget(null);
      reload();
    } catch (e: any) {
      Alert.alert('Could not update group', String(e?.message ?? e));
    }
  };

  const handleSaveSupplementEdit = async (item: api.StackItem | api.TodayStackItem, patch: Partial<api.StackItem>) => {
    try {
      await api.updateStackItem(authToken, item.id, patch);
      setEditTarget(null);
      setDetailTarget(null);
      reload();
    } catch (e: any) {
      Alert.alert('Could not update supplement', String(e?.message ?? e));
    }
  };

  const browsableIngredients = useMemo(() => {
    const activeIngredientIds = new Set(
      stack
        .map(item => item.supplement_ingredient_id)
        .filter((id): id is number => typeof id === 'number'),
    );
    const activeNameKeys = stack
      .map(item => normalizeSupplementKey(item.custom_name))
      .filter(Boolean);

    return ingredients.filter(ing => {
      if (activeIngredientIds.has(ing.id)) return false;
      const nameKey = normalizeSupplementKey(ing.name);
      const slugKey = normalizeSupplementKey(ing.slug);
      return !activeNameKeys.some(key =>
        key === nameKey ||
        key === slugKey ||
        (key.length >= 5 && nameKey.length >= 5 && (key.includes(nameKey) || nameKey.includes(key))) ||
        (key.length >= 5 && slugKey.length >= 5 && (key.includes(slugKey) || slugKey.includes(key)))
      );
    });
  }, [ingredients, stack]);

  const browseCategories = useMemo(() => {
    return BROWSE_FILTERS.filter(filter =>
      filter.key === 'all' || browsableIngredients.some(ing => ingredientMatchesBrowseFilter(ing, filter.key))
    );
  }, [browsableIngredients]);

  const filteredBrowseIngredients = useMemo(() => {
    const query = normalizeSupplementKey(browseSearch);
    return browsableIngredients.filter(ing => {
      if (!ingredientMatchesBrowseFilter(ing, browseCategory)) return false;
      if (!query) return true;
      return supplementBrowseText(ing).includes(query);
    });
  }, [browseCategory, browseSearch, browsableIngredients]);

  // ─── Section renderers ──────────────────────────────────────────────

  const renderCoreLoadError = () => (
    <View style={{ padding: 20, alignItems: 'center' }}>
      <Ionicons name="cloud-offline-outline" size={32} color={tc.textMuted} style={{ marginBottom: 8 }} />
      <Text style={{ fontSize: 13, color: tc.textSecondary, textAlign: 'center' }}>
        {coreLoadError || 'Could not load supplements.'}
      </Text>
      <TouchableOpacity
        onPress={() => reload()}
        style={{
          marginTop: 12,
          backgroundColor: tc.surface,
          borderWidth: 1,
          borderColor: tc.border,
          borderRadius: 10,
          paddingVertical: 9,
          paddingHorizontal: 14,
        }}
      >
        <Text style={{ fontSize: 12, fontWeight: '800', color: tc.textSecondary }}>Retry</Text>
      </TouchableOpacity>
    </View>
  );

  const renderToday = () => {
    if (today.length === 0) {
      const hasStackItems = stack.length > 0;
      return (
        <View style={{ padding: 20, alignItems: 'center' }}>
          <Ionicons name="medical-outline" size={32} color={tc.textMuted} style={{ marginBottom: 8 }} />
          <Text style={{ fontSize: 13, color: tc.textSecondary, textAlign: 'center' }}>
            Nothing scheduled for today.
          </Text>
          <Text style={{ fontSize: 11, color: tc.textMuted, textAlign: 'center', marginTop: 4 }}>
            {hasStackItems
              ? 'Daily / weekday scheduled items will show up here.'
              : 'Build your stack and daily / weekday scheduled items will show up here.'}
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center', marginTop: 14 }}>
            {hasStackItems ? (
              <TouchableOpacity
                onPress={() => selectSection('stack')}
                style={{
                  flexDirection: 'row', alignItems: 'center', gap: 6,
                  backgroundColor: tc.surface,
                  borderWidth: 1,
                  borderColor: tc.border,
                  borderRadius: 10,
                  paddingVertical: 9,
                  paddingHorizontal: 14,
                }}
              >
                <Ionicons name="layers-outline" size={15} color={tc.textSecondary} />
                <Text style={{ fontSize: 12, fontWeight: '800', color: tc.textSecondary }}>View stack</Text>
              </TouchableOpacity>
            ) : (
              <>
                <TouchableOpacity
                  onPress={() => selectSection('browse')}
                  style={{
                    flexDirection: 'row', alignItems: 'center', gap: 6,
                    backgroundColor: tc.primary,
                    borderRadius: 10,
                    paddingVertical: 10,
                    paddingHorizontal: 14,
                  }}
                >
                  <Ionicons name="library-outline" size={15} color={getContrastingTextColor(tc.primary)} />
                  <Text style={{ fontSize: 12, fontWeight: '800', color: getContrastingTextColor(tc.primary) }}>Browse library</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => openAddSupplement()}
                  style={{
                    flexDirection: 'row', alignItems: 'center', gap: 6,
                    backgroundColor: tc.surface,
                    borderWidth: 1,
                    borderColor: tc.border,
                    borderRadius: 10,
                    paddingVertical: 10,
                    paddingHorizontal: 14,
                  }}
                >
                  <Ionicons name="add" size={15} color={tc.textSecondary} />
                  <Text style={{ fontSize: 12, fontWeight: '800', color: tc.textSecondary }}>Add custom</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>
      );
    }
    const pendingCount = today.filter(item => {
      const logs = item.logs_today || [];
      return !logs.find(l => !l.skipped) && !logs.find(l => l.skipped);
    }).length;
    return (
      <View style={{ gap: 8 }}>
        {pendingCount > 1 && (
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TouchableOpacity
              testID="supplement-take-all"
              accessibilityLabel="supplement-take-all"
              onPress={handleTakeAll}
              disabled={takingAll || skippingAll}
              style={{
                flex: 2,
                flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
                paddingVertical: 12, borderRadius: 12,
                backgroundColor: tc.primary,
                opacity: takingAll || skippingAll ? 0.6 : 1,
              }}>
              {takingAll ? (
                <ActivityIndicator size="small" color={getContrastingTextColor(tc.primary)} />
              ) : (
                <Ionicons name="checkmark-done" size={18} color={getContrastingTextColor(tc.primary)} />
              )}
              <Text style={{ fontSize: 14, fontWeight: '800', color: getContrastingTextColor(tc.primary) }}>
                {takingAll ? 'Logging…' : `Take all (${pendingCount})`}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="supplement-skip-all"
              accessibilityLabel="supplement-skip-all"
              onPress={handleSkipAll}
              disabled={takingAll || skippingAll}
              style={{
                flex: 1,
                flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
                paddingVertical: 12, borderRadius: 12,
                backgroundColor: tc.surfaceRaised,
                borderWidth: 1, borderColor: tc.border,
                opacity: takingAll || skippingAll ? 0.6 : 1,
              }}>
              {skippingAll ? (
                <ActivityIndicator size="small" color={tc.textSecondary} />
              ) : (
                <Ionicons name="close" size={18} color={tc.textSecondary} />
              )}
              <Text style={{ fontSize: 13, fontWeight: '800', color: tc.textSecondary }}>
                {skippingAll ? 'Skipping…' : 'Skip all'}
              </Text>
            </TouchableOpacity>
          </View>
        )}
        {buildGroups(today).map((group) => {
          const groupPending = group.items.filter(i => {
            const logs = i.logs_today || [];
            return !logs.find(l => !l.skipped) && !logs.find(l => l.skipped);
          }).length;
          const isLogging = takingGroupKey === group.key;
          return (
            <View key={group.key} style={{ gap: 6, marginTop: 4 }}>
              {/* Group header — label + (when group has 2+ items) a
                  one-tap "Take group" button so users can log a whole
                  pack at once instead of marking each. */}
              <View style={{
                flexDirection: 'row', alignItems: 'center',
                justifyContent: 'space-between',
                paddingHorizontal: 4, paddingTop: 4,
              }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Text style={{
                    fontSize: 11, fontWeight: '800', color: tc.textMuted,
                    letterSpacing: 0.6, textTransform: 'uppercase',
                  }}>
                    {group.label}
                  </Text>
                  <Text style={{ fontSize: 10, color: tc.textMuted }}>
                    · {group.items.length}
                  </Text>
                </View>
                {group.items.length >= 2 && groupPending > 0 && (
                  <TouchableOpacity
                    testID={`supplement-take-group-${e2eId(group.label)}`}
                    accessibilityLabel={`supplement-take-group-${e2eId(group.label)}`}
                    onPress={() => handleTakeGroup(group)}
                    disabled={isLogging}
                    style={{
                      flexDirection: 'row', alignItems: 'center', gap: 4,
                      paddingHorizontal: 10, paddingVertical: 5, borderRadius: 12,
                      backgroundColor: tc.primary + '1F',
                      borderWidth: 1, borderColor: tc.primary + '88',
                      opacity: isLogging ? 0.6 : 1,
                    }}
                  >
                    {isLogging
                      ? <ActivityIndicator size="small" color={tc.primary} />
                      : <Ionicons name="checkmark-done" size={12} color={tc.primary} />}
                    <Text style={{ fontSize: 10, fontWeight: '800', color: tc.primary }}>
                      {isLogging ? 'Logging…' : `Take ${groupPending}`}
                    </Text>
                  </TouchableOpacity>
                )}
              </View>
              {group.items.map(item => {
                const takenLogs = takenTodaySupplementLogs(item);
                const taken = takenLogs.length > 0 ? takenLogs[takenLogs.length - 1] : undefined;
                const skipped = !taken ? skippedTodaySupplementLog(item) : undefined;
                const doseLabel = taken ? todayDoseSummary(item) : supplementDoseLabel(item.dose_amount, item.dose_unit);
                const takenTime = taken ? new Date(taken.taken_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
                return (
                  <TouchableOpacity key={item.id} testID={`supplement-today-row-${e2eId(item.custom_name || 'supplement')}`} onPress={() => setDetailTarget(item)} activeOpacity={0.82} style={{
                    backgroundColor: tc.surface, borderWidth: 1, borderColor: tc.border,
                    borderRadius: 12, padding: 12,
                  }}>
                    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
                      <SupplementSourceImage item={item} tc={tc} height={78} width={68} />
                      <View style={{ flex: 1, gap: 5 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                          <Text style={{ flex: 1, fontSize: 14, fontWeight: '800', color: tc.textPrimary }} numberOfLines={1}>
                            {supplementDisplayName(item)}
                          </Text>
                          <Ionicons name="chevron-forward" size={14} color={tc.textMuted} />
                        </View>
                        <Text style={{ fontSize: 11, color: tc.textMuted }} numberOfLines={1}>
                          {doseLabel || 'Dose not set'}
                          {item.timing ? ` · ${item.timing.replace(/_/g, ' ')}` : ''}
                          {taken ? ` · Taken ${takenLogs.length > 1 ? `${takenLogs.length}x` : takenTime}` : skipped ? ' · Skipped' : ''}
                        </Text>
                        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                          <EvidenceGauge tier={item.evidence_tier} tc={tc} tiers={tiers} />
                          <RiskBadge tier={item.risk_tier} tc={tc} tiers={tiers} />
                          {item.usage_guidance && (
                            <Pill
                              label="USAGE"
                              color={item.usage_guidance.severity === 'warning' ? tc.warning : tc.primary}
                            />
                          )}
                        </View>
                      </View>
                      <View style={{ alignItems: 'flex-end', gap: 6 }}>
                        <View style={{
                          width: 30, height: 30, borderRadius: 15,
                          backgroundColor: taken ? tc.success + '22' : skipped ? tc.border : tc.surfaceRaised,
                          alignItems: 'center', justifyContent: 'center',
                        }}>
                          <Ionicons
                            name={taken ? 'checkmark' : skipped ? 'close' : 'time-outline'}
                            size={15}
                            color={taken ? tc.success : skipped ? tc.textMuted : tc.textSecondary}
                          />
                        </View>
                        {!taken && (
                          <>
                          <TouchableOpacity
                            testID={`supplement-mark-taken-${e2eId(item.custom_name || 'supplement')}`}
                            accessibilityLabel={`supplement-mark-taken-${e2eId(item.custom_name || 'supplement')}`}
                            onPress={(event) => { event.stopPropagation(); handleMarkTaken(item, false); }}
                            style={{
                              paddingVertical: 6, paddingHorizontal: 9, borderRadius: 8,
                              backgroundColor: tc.primary,
                            }}
                          >
                            <Text style={{ fontSize: 10, fontWeight: '800', color: getContrastingTextColor(tc.primary) }}>Taken</Text>
                          </TouchableOpacity>
                          {!skipped && (
                            <TouchableOpacity
                              testID={`supplement-skip-${e2eId(item.custom_name || 'supplement')}`}
                              accessibilityLabel={`supplement-skip-${e2eId(item.custom_name || 'supplement')}`}
                              onPress={(event) => { event.stopPropagation(); handleMarkTaken(item, true); }}
                              style={{
                                paddingVertical: 3, paddingHorizontal: 8,
                              }}
                            >
                              <Text style={{ fontSize: 10, fontWeight: '700', color: tc.textMuted }}>Skip</Text>
                            </TouchableOpacity>
                          )}
                          </>
                        )}
                        {taken && (
                          <TouchableOpacity
                            testID={`supplement-add-dose-${e2eId(item.custom_name || 'supplement')}`}
                            accessibilityLabel={`supplement-add-dose-${e2eId(item.custom_name || 'supplement')}`}
                            onPress={(event) => { event.stopPropagation(); handleMarkTaken(item, false); }}
                            style={{
                              flexDirection: 'row',
                              alignItems: 'center',
                              gap: 3,
                              paddingVertical: 5,
                              paddingHorizontal: 8,
                              borderRadius: 8,
                              backgroundColor: tc.primary + '16',
                              borderWidth: 1,
                              borderColor: tc.primary + '55',
                            }}
                          >
                            <Ionicons name="add" size={11} color={tc.primary} />
                            <Text style={{ fontSize: 10, fontWeight: '800', color: tc.primary }}>Dose</Text>
                          </TouchableOpacity>
                        )}
                        {(taken || skipped) && (
                          <TouchableOpacity
                            testID={`supplement-undo-${e2eId(item.custom_name || 'supplement')}`}
                            accessibilityLabel={`supplement-undo-${e2eId(item.custom_name || 'supplement')}`}
                            onPress={(event) => { event.stopPropagation(); handleUntake(item); }}
                            style={{ paddingVertical: 3, paddingHorizontal: 8 }}
                          >
                            <Text style={{ fontSize: 10, fontWeight: '700', color: tc.textMuted }}>Undo</Text>
                          </TouchableOpacity>
                        )}
                      </View>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
          );
        })}
        {insights.length > 0 && (
          <View style={{ marginTop: 12, gap: 8 }}>
            {insights.map(ins => (
              <View key={ins.key} style={{
                backgroundColor: ins.severity === 'warning' ? tc.warning + '1A' : tc.surface,
                borderWidth: 1,
                borderColor: ins.severity === 'warning' ? tc.warning + '55' : tc.border,
                borderRadius: 10, padding: 12, flexDirection: 'row', gap: 10,
              }}>
                <Ionicons
                  name={ins.severity === 'warning' ? 'warning-outline' : 'information-circle-outline'}
                  size={18}
                  color={ins.severity === 'warning' ? tc.warning : tc.primary}
                />
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 13, fontWeight: '700', color: tc.textPrimary, marginBottom: 2 }}>{ins.title}</Text>
                  <Text style={{ fontSize: 11, color: tc.textSecondary, lineHeight: 16 }}>{ins.body}</Text>
                </View>
              </View>
            ))}
          </View>
        )}
      </View>
    );
  };

  const renderStack = () => {
    if (stack.length === 0) {
      return (
        <View style={{ padding: 20, alignItems: 'center' }}>
          <Ionicons name="medical-outline" size={32} color={tc.textMuted} style={{ marginBottom: 8 }} />
          <Text style={{ fontSize: 13, color: tc.textSecondary, textAlign: 'center' }}>Your stack is empty.</Text>
          <Text style={{ fontSize: 11, color: tc.textMuted, textAlign: 'center', marginTop: 4, marginBottom: 12 }}>
            Tap "Add supplement" to get started.
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}>
            <TouchableOpacity
              onPress={() => selectSection('browse')}
              style={{
                flexDirection: 'row', alignItems: 'center', gap: 6,
                backgroundColor: tc.primary,
                borderRadius: 10,
                paddingVertical: 10,
                paddingHorizontal: 14,
              }}
            >
              <Ionicons name="library-outline" size={15} color={getContrastingTextColor(tc.primary)} />
              <Text style={{ color: getContrastingTextColor(tc.primary), fontWeight: '800', fontSize: 13 }}>Browse library</Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="supplement-add-open"
              accessibilityLabel="supplement-add-open"
              onPress={() => openAddSupplement()}
              style={{
                flexDirection: 'row', alignItems: 'center', gap: 6,
                backgroundColor: tc.surface,
                borderWidth: 1,
                borderColor: tc.border,
                borderRadius: 10,
                paddingVertical: 10,
                paddingHorizontal: 14,
              }}
            >
              <Ionicons name="add" size={15} color={tc.textSecondary} />
              <Text style={{ color: tc.textSecondary, fontWeight: '800', fontSize: 13 }}>Add custom</Text>
            </TouchableOpacity>
          </View>
        </View>
      );
    }
    return (
      <View style={{ gap: 10 }}>
        <TouchableOpacity
          testID="supplement-add-open"
          accessibilityLabel="supplement-add-open"
          onPress={() => openAddSupplement()}
          style={{
            flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
            backgroundColor: tc.primary,
            borderRadius: 10, paddingVertical: 10,
          }}
        >
          <Ionicons name="add" size={16} color={getContrastingTextColor(tc.primary)} />
          <Text style={{ color: getContrastingTextColor(tc.primary), fontWeight: '800', fontSize: 12 }}>Add supplement</Text>
        </TouchableOpacity>
        {buildGroups(stack).map(group => (
          <View key={group.key} style={{ gap: 6 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 4, paddingTop: 2 }}>
              <Text style={{
                fontSize: 11, fontWeight: '800', color: tc.textMuted,
                letterSpacing: 0.6, textTransform: 'uppercase',
              }}>
                {group.label}
              </Text>
              <Text style={{ fontSize: 10, color: tc.textMuted }}>· {group.items.length}</Text>
            </View>
            {group.items.map(item => {
              const doseLabel = supplementDoseLabel(item.dose_amount, item.dose_unit);
              return (
                <TouchableOpacity key={item.id} testID={`supplement-stack-row-${e2eId(item.custom_name || 'supplement')}`} onPress={() => setDetailTarget(item)} activeOpacity={0.82} style={{
                  backgroundColor: tc.surface, borderWidth: 1, borderColor: tc.border,
                  borderRadius: 12, padding: 12,
                }}>
                  <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
                    <SupplementSourceImage item={item} tc={tc} height={82} width={74} />
                    <View style={{ flex: 1, gap: 6 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <Text style={{ flex: 1, fontSize: 15, fontWeight: '900', color: tc.textPrimary }} numberOfLines={1}>
                          {supplementDisplayName(item)}
                        </Text>
                        <Ionicons name="chevron-forward" size={15} color={tc.textMuted} />
                      </View>
                      <Text style={{ fontSize: 11, color: tc.textMuted }} numberOfLines={1}>
                        {[doseLabel, item.frequency?.replace(/_/g, ' '), item.timing?.replace(/_/g, ' '), item.group_label]
                          .filter(Boolean)
                          .join(' · ') || 'Dose not set'}
                      </Text>
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                        <EvidenceGauge tier={item.evidence_tier} tc={tc} tiers={tiers} />
                        <RiskBadge tier={item.risk_tier} tc={tc} tiers={tiers} />
                        {item.effectiveness_confidence && (
                          <Pill
                            label={`${item.effectiveness_confidence.toUpperCase()} CONF`}
                            color={confidenceColor(tc, item.effectiveness_confidence)}
                          />
                        )}
                        {item.usage_guidance && (
                          <Pill
                            label="USAGE"
                            color={item.usage_guidance.severity === 'warning' ? tc.warning : tc.primary}
                          />
                        )}
                      </View>
                    </View>
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
        ))}
        <TouchableOpacity
          testID="supplement-add-open"
          accessibilityLabel="supplement-add-open"
          onPress={() => openAddSupplement()}
          style={{
            borderWidth: 1.5, borderStyle: 'dashed', borderColor: tc.primary + '66',
            borderRadius: 12, padding: 14, alignItems: 'center',
            marginTop: 4,
          }}
        >
          <Text style={{ color: tc.primary, fontWeight: '700', fontSize: 13 }}>+ Add supplement</Text>
        </TouchableOpacity>
      </View>
    );
  };

  const renderBrowse = () => {
    if (ingredientsLoading) {
      return (
        <View style={{ padding: 20, alignItems: 'center' }}>
          <ActivityIndicator color={tc.primary} style={{ marginBottom: 10 }} />
          <Text style={{ fontSize: 13, color: tc.textSecondary, textAlign: 'center' }}>
            Loading library…
          </Text>
        </View>
      );
    }
    if (ingredients.length === 0) {
      return (
        <View style={{ padding: 20, alignItems: 'center' }}>
          <Ionicons name="library-outline" size={32} color={tc.textMuted} style={{ marginBottom: 8 }} />
          <Text style={{ fontSize: 13, color: tc.textSecondary, textAlign: 'center' }}>
            {ingredientsLoadError || 'Supplement library unavailable.'}
          </Text>
          <TouchableOpacity
            onPress={() => reload()}
            style={{
              marginTop: 12,
              backgroundColor: tc.surface,
              borderWidth: 1,
              borderColor: tc.border,
              borderRadius: 10,
              paddingVertical: 9,
              paddingHorizontal: 14,
            }}
          >
            <Text style={{ fontSize: 12, fontWeight: '800', color: tc.textSecondary }}>Retry</Text>
          </TouchableOpacity>
        </View>
      );
    }
    if (browsableIngredients.length === 0) {
      return (
        <View style={{ padding: 20, alignItems: 'center' }}>
          <Ionicons name="checkmark-done-circle-outline" size={32} color={tc.textMuted} style={{ marginBottom: 8 }} />
          <Text style={{ fontSize: 13, color: tc.textSecondary, textAlign: 'center' }}>
            Every catalog supplement is already in your stack.
          </Text>
        </View>
      );
    }
    const visibleBrowseIngredients = filteredBrowseIngredients.slice(0, browseVisibleCount);
    const hasMoreBrowseIngredients = visibleBrowseIngredients.length < filteredBrowseIngredients.length;
    return (
      <View style={{ gap: 10 }}>
        <View style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          backgroundColor: tc.surface,
          borderWidth: 1,
          borderColor: tc.border,
          borderRadius: 11,
          paddingHorizontal: 11,
          paddingVertical: 9,
        }}>
          <Ionicons name="search-outline" size={16} color={tc.textMuted} />
          <TextInput
            testID="supplement-browse-search"
            value={browseSearch}
            onChangeText={setBrowseSearch}
            placeholder="Search library"
            placeholderTextColor={tc.textMuted}
            returnKeyType="search"
            style={{
              flex: 1,
              color: tc.textPrimary,
              fontSize: 13,
              paddingVertical: 0,
              ...INPUT_TEXT_RESET,
            }}
          />
          {browseSearch.length > 0 && (
            <TouchableOpacity onPress={() => setBrowseSearch('')} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close-circle" size={16} color={tc.textMuted} />
            </TouchableOpacity>
          )}
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 6, paddingBottom: 1 }}
        >
          {browseCategories.map(cat => {
            const active = browseCategory === cat.key;
            return (
              <TouchableOpacity
                key={cat.key}
                testID={`supplement-browse-category-${e2eId(cat.key)}`}
                accessibilityLabel={`supplement-browse-category-${e2eId(cat.key)}`}
                onPress={() => setBrowseCategory(cat.key)}
                style={{
                  backgroundColor: active ? tc.primary : tc.surface,
                  borderWidth: 1,
                  borderColor: active ? tc.primary : tc.border,
                  borderRadius: 999,
                  paddingVertical: 7,
                  paddingHorizontal: 11,
                }}
              >
                <Text style={{
                  fontSize: 11,
                  fontWeight: '800',
                  color: active ? getContrastingTextColor(tc.primary) : tc.textSecondary,
                }}>
                  {cat.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        {filteredBrowseIngredients.length === 0 ? (
          <View style={{ padding: 20, alignItems: 'center' }}>
            <Ionicons name="search-outline" size={28} color={tc.textMuted} style={{ marginBottom: 8 }} />
            <Text style={{ fontSize: 13, color: tc.textSecondary, textAlign: 'center' }}>
              No library matches.
            </Text>
          </View>
        ) : (
          <>
            {visibleBrowseIngredients.map((ing) => (
              <TouchableOpacity
                key={ing.id}
                testID={`supplement-browse-row-${e2eId(ing.name)}`}
                accessibilityLabel={`supplement-browse-row-${e2eId(ing.name)}`}
                onPress={() => setIngredientDetailTarget(ing)}
                activeOpacity={0.82}
                style={{
                  backgroundColor: tc.surface,
                  borderWidth: 1,
                  borderColor: tc.border,
                  borderRadius: 12,
                  overflow: 'hidden',
                }}
              >
                <SupplementCardImageHeader
                  item={{ custom_name: ing.name, ingredient_slug: ing.slug, category: ing.category, food_sources: ing.food_sources }}
                  tc={tc}
                >
                  <TouchableOpacity
                    testID={`supplement-browse-add-${e2eId(ing.name)}`}
                    accessibilityLabel={`supplement-browse-add-${e2eId(ing.name)}`}
                    onPress={(event) => {
                      event.stopPropagation();
                      openAddSupplement(ing);
                    }}
                    style={{
                      position: 'absolute',
                      right: 12,
                      bottom: 12,
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 5,
                      borderRadius: 999,
                      backgroundColor: tc.primary,
                      paddingVertical: 8,
                      paddingHorizontal: 11,
                    }}
                  >
                    <Ionicons name="add" size={15} color={getContrastingTextColor(tc.primary)} />
                    <Text style={{ color: getContrastingTextColor(tc.primary), fontSize: 12, fontWeight: '900' }}>
                      Add
                    </Text>
                  </TouchableOpacity>
                </SupplementCardImageHeader>
                <View style={{ padding: 12, gap: 8 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
                    <View style={{ flex: 1, gap: 4 }}>
                      <Text style={{ fontSize: 16, fontWeight: '900', color: tc.textPrimary }} numberOfLines={2}>
                        {ing.name}
                      </Text>
                      <Text style={{ fontSize: 11, color: tc.textMuted }} numberOfLines={1}>
                        {formatSupplementLabel(ing.category)} · tracks in {ing.default_unit}
                      </Text>
                    </View>
                    <Ionicons name="chevron-forward" size={17} color={tc.textMuted} style={{ marginTop: 2 }} />
                  </View>
                  {ing.description && (
                    <Text style={{ fontSize: 12, color: tc.textSecondary, lineHeight: 17 }} numberOfLines={2}>
                      {ing.description}
                    </Text>
                  )}
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                    <EvidenceGauge tier={ing.evidence_tier} tc={tc} tiers={tiers} />
                    <RiskBadge tier={ing.risk_tier} tc={tc} tiers={tiers} />
                    {ing.usage_guidance && (
                      <Pill
                        label="USAGE"
                        color={ing.usage_guidance.severity === 'warning' ? tc.warning : tc.primary}
                      />
                    )}
                  </View>
                </View>
              </TouchableOpacity>
            ))}
            {hasMoreBrowseIngredients && (
              <TouchableOpacity
                testID="supplement-browse-show-more"
                accessibilityLabel="Show more supplements"
                onPress={() => setBrowseVisibleCount(count => count + BROWSE_PAGE_SIZE)}
                style={{
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor: tc.border,
                  backgroundColor: tc.surface,
                  paddingVertical: 12,
                }}
              >
                <Text style={{ color: tc.textSecondary, fontSize: 12, fontWeight: '800' }}>
                  Show more ({filteredBrowseIngredients.length - visibleBrowseIngredients.length})
                </Text>
              </TouchableOpacity>
            )}
          </>
        )}
      </View>
    );
  };

  const renderRecommendations = () => {
    if (recsLoading && recs.length === 0) {
      return (
        <View style={{ padding: 20, alignItems: 'center' }}>
          <ActivityIndicator color={tc.primary} style={{ marginBottom: 10 }} />
          <Text style={{ fontSize: 13, color: tc.textSecondary, textAlign: 'center' }}>
            Loading recommendations…
          </Text>
        </View>
      );
    }
    if (recs.length === 0) {
      if (recsLoadError) {
        return (
          <View style={{ padding: 20, alignItems: 'center' }}>
            <Ionicons name="cloud-offline-outline" size={32} color={tc.textMuted} style={{ marginBottom: 8 }} />
            <Text style={{ fontSize: 13, color: tc.textSecondary, textAlign: 'center' }}>
              {recsLoadError}
            </Text>
            <TouchableOpacity
              onPress={() => reload()}
              style={{
                marginTop: 12,
                backgroundColor: tc.surface,
                borderWidth: 1,
                borderColor: tc.border,
                borderRadius: 10,
                paddingVertical: 9,
                paddingHorizontal: 14,
              }}
            >
              <Text style={{ fontSize: 12, fontWeight: '800', color: tc.textSecondary }}>Retry</Text>
            </TouchableOpacity>
          </View>
        );
      }
      return (
        <View style={{ padding: 20, alignItems: 'center' }}>
          <Ionicons name="sparkles-outline" size={32} color={tc.textMuted} style={{ marginBottom: 8 }} />
          <Text style={{ fontSize: 13, color: tc.textSecondary, textAlign: 'center' }}>
            No recommendations right now.
          </Text>
          <Text style={{ fontSize: 11, color: tc.textMuted, textAlign: 'center', marginTop: 4 }}>
            Log a few days of meals and we'll suggest supplements tied to your actual dietary gaps.
          </Text>
        </View>
      );
    }
    return (
      <View style={{ gap: 10 }}>
        <Text style={{ fontSize: 11, color: tc.textMuted, lineHeight: 15, marginBottom: 4 }}>
          Suggestions based on your logged meals. These are educational —
          discuss supplements with a clinician, especially if you take
          medication or have a medical condition.
        </Text>
        {recs.map((r, i) => (
          <TouchableOpacity key={`${r.slug}-${i}`} onPress={() => setRecDetailTarget(r)} activeOpacity={0.82} style={{
            backgroundColor: tc.surface, borderWidth: 1, borderColor: tc.border,
            borderRadius: 12, padding: 12,
          }}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
              <SupplementSourceImage item={{ custom_name: r.title, ingredient_slug: r.slug, category: r.priority }} tc={tc} height={82} width={74} />
              <View style={{ flex: 1, gap: 6 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Text style={{ flex: 1, fontSize: 15, fontWeight: '900', color: tc.textPrimary }} numberOfLines={2}>
                    {r.title}
                  </Text>
                  <Ionicons name="chevron-forward" size={15} color={tc.textMuted} />
                </View>
                <Text style={{ fontSize: 11, color: tc.textMuted }} numberOfLines={1}>
                  {r.priority.toUpperCase()} PRIORITY
                </Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                  <EvidenceGauge tier={r.evidence_tier} tc={tc} tiers={tiers} />
                  <RiskBadge tier={r.risk_tier} tc={tc} tiers={tiers} />
                </View>
              </View>
            </View>
          </TouchableOpacity>
        ))}
      </View>
    );
  };

  const renderHistory = () => {
    if (historyLoading && !history) {
      return (
        <View style={{ padding: 20, alignItems: 'center' }}>
          <ActivityIndicator color={tc.primary} style={{ marginBottom: 10 }} />
          <Text style={{ fontSize: 13, color: tc.textSecondary, textAlign: 'center' }}>
            Loading history…
          </Text>
        </View>
      );
    }
    if (historyLoadError && !history) {
      return (
        <View style={{ padding: 20, alignItems: 'center' }}>
          <Ionicons name="cloud-offline-outline" size={32} color={tc.textMuted} style={{ marginBottom: 8 }} />
          <Text style={{ fontSize: 13, color: tc.textSecondary, textAlign: 'center' }}>
            {historyLoadError}
          </Text>
          <TouchableOpacity
            onPress={() => loadHistory()}
            style={{
              marginTop: 12,
              backgroundColor: tc.surface,
              borderWidth: 1,
              borderColor: tc.border,
              borderRadius: 10,
              paddingVertical: 9,
              paddingHorizontal: 14,
            }}
          >
            <Text style={{ fontSize: 12, fontWeight: '800', color: tc.textSecondary }}>Retry</Text>
          </TouchableOpacity>
        </View>
      );
    }
    const items = history?.items ?? [];
    if (items.length === 0) {
      return (
        <View style={{ padding: 20, alignItems: 'center' }}>
          <Ionicons name="time-outline" size={32} color={tc.textMuted} style={{ marginBottom: 8 }} />
          <Text style={{ fontSize: 13, color: tc.textSecondary, textAlign: 'center' }}>
            No supplement history yet.
          </Text>
          <Text style={{ fontSize: 11, color: tc.textMuted, textAlign: 'center', marginTop: 4 }}>
            Taken and skipped doses will show up here.
          </Text>
        </View>
      );
    }

    const groups = items.reduce<Array<{ label: string; items: api.SupplementHistoryItem[] }>>((acc, item) => {
      const label = supplementHistoryDateLabel(item.taken_at);
      const existing = acc.find(group => group.label === label);
      if (existing) existing.items.push(item);
      else acc.push({ label, items: [item] });
      return acc;
    }, []);

    return (
      <View style={{ gap: 10 }}>
        {history && (
          <View style={{
            backgroundColor: tc.surface,
            borderWidth: 1,
            borderColor: tc.border,
            borderRadius: 12,
            padding: 12,
            flexDirection: 'row',
            justifyContent: 'space-between',
            gap: 8,
          }}>
            {[
              [`${history.summary.taken}`, 'Taken'],
              [`${history.summary.skipped}`, 'Skipped'],
              [`${history.summary.taken_days}`, 'Days'],
            ].map(([value, label]) => (
              <View key={label} style={{ flex: 1, alignItems: 'center', gap: 2 }}>
                <Text style={{ fontSize: 18, fontWeight: '900', color: tc.textPrimary }}>{value}</Text>
                <Text style={{ fontSize: 10, fontWeight: '800', color: tc.textMuted, textTransform: 'uppercase' }}>{label}</Text>
              </View>
            ))}
          </View>
        )}

        {historyLoadError ? (
          <Text style={{ fontSize: 11, color: tc.warning, textAlign: 'center' }}>{historyLoadError}</Text>
        ) : null}

        {groups.map(group => (
          <View key={group.label} style={{ gap: 6 }}>
            <Text style={{
              fontSize: 11,
              fontWeight: '800',
              color: tc.textMuted,
              letterSpacing: 0.6,
              textTransform: 'uppercase',
              paddingHorizontal: 4,
            }}>
              {group.label}
            </Text>
            {group.items.map(item => {
              const color = item.skipped ? tc.textMuted : tc.success;
              const doseLabel = supplementDoseLabel(item.dose_amount, item.dose_unit);
              return (
                <View key={item.id} style={{
                  backgroundColor: tc.surface,
                  borderWidth: 1,
                  borderColor: tc.border,
                  borderRadius: 12,
                  padding: 12,
                  flexDirection: 'row',
                  gap: 10,
                  alignItems: 'center',
                }}>
                  <View style={{
                    width: 34,
                    height: 34,
                    borderRadius: 17,
                    backgroundColor: color + '18',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}>
                    <Ionicons name={item.skipped ? 'close' : 'checkmark'} size={17} color={color} />
                  </View>
                  <View style={{ flex: 1, gap: 4 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Text style={{ flex: 1, fontSize: 14, fontWeight: '800', color: tc.textPrimary }} numberOfLines={1}>
                        {item.display_name || item.name || 'Supplement'}
                      </Text>
                      {item.usage_guidance ? (
                        <Ionicons
                          name="repeat-outline"
                          size={14}
                          color={item.usage_guidance.severity === 'warning' ? tc.warning : tc.primary}
                        />
                      ) : null}
                    </View>
                    <Text style={{ fontSize: 11, color: tc.textMuted }} numberOfLines={1}>
                      {[
                        item.skipped ? 'Skipped' : 'Taken',
                        supplementHistoryTimeLabel(item.taken_at),
                        doseLabel,
                        formatSupplementLabel(item.source),
                      ].filter(Boolean).join(' · ')}
                    </Text>
                    {(item.group_label || item.timing_context) ? (
                      <Text style={{ fontSize: 10, color: tc.textMuted }} numberOfLines={1}>
                        {[item.group_label, formatSupplementLabel(item.timing_context)].filter(Boolean).join(' · ')}
                      </Text>
                    ) : null}
                  </View>
                </View>
              );
            })}
          </View>
        ))}
      </View>
    );
  };

  // ─── Render ─────────────────────────────────────────────────────────

  const sectionContent = (
    <>
      {/* `loading` tracks only the core today/stack fetch, so its spinner is
          scoped to those tabs. Browse / Recommendations / History own their
          loading + empty states (ingredientsLoading / recsLoading /
          historyLoading) and render independently — a slow or failed core
          fetch must never blank out the whole screen. */}
      {loading && (section === 'today' || section === 'stack') && <ActivityIndicator color={tc.primary} style={{ marginVertical: 20 }} />}
      {!loading && coreLoadError && (section === 'today' || section === 'stack') && renderCoreLoadError()}
      {!loading && !coreLoadError && section === 'today' && renderToday()}
      {!loading && !coreLoadError && section === 'stack' && renderStack()}
      {section === 'browse' && renderBrowse()}
      {section === 'recommendations' && renderRecommendations()}
      {section === 'history' && renderHistory()}

      {/* Legal / educational footer */}
      <View style={{ marginTop: 20, paddingTop: 16, borderTopWidth: 1, borderTopColor: tc.border }}>
        <Text style={{ fontSize: 10, color: tc.textMuted, lineHeight: 15, textAlign: 'center' }}>
          Thallo does not provide medical advice. Supplements aren't a
          substitute for a balanced diet or medical care. Discuss
          dosing, interactions, and medical conditions with a
          clinician before starting anything new.
        </Text>
      </View>
    </>
  );

  return (
    <View
      testID="supplement-stack-screen"
      style={{
        ...(embedded ? { minHeight: Math.max(420, windowHeight - 220) } : { flex: 1 }),
        backgroundColor: tc.background,
        paddingHorizontal: 16,
        paddingTop: 8,
      }}>
      {/* Section picker */}
      <View style={{
        flexDirection: 'row', backgroundColor: tc.surface,
        borderRadius: 10, padding: 3, marginBottom: 12,
        borderWidth: 1, borderColor: tc.border,
      }}>
        {(['today', 'stack', 'browse', 'recommendations', 'history'] as Section[]).map(s => {
          const active = section === s;
          const label = s === 'today' ? 'Today' : s === 'stack' ? 'Stack' : s === 'browse' ? 'Browse' : s === 'recommendations' ? 'Recs' : 'History';
          return (
            <TouchableOpacity
              key={s}
              testID={`supplement-section-${s}`}
              accessibilityLabel={`supplement-section-${s}`}
              onPress={() => selectSection(s)}
              style={{
                flex: 1, paddingVertical: 8,
                backgroundColor: active ? tc.primary : 'transparent',
                borderRadius: 8,
                alignItems: 'center',
              }}
            >
              <Text style={{
                fontSize: 11, fontWeight: '800',
                color: active ? getContrastingTextColor(tc.primary) : tc.textSecondary,
              }}>{label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {embedded ? (
        <View style={{ paddingBottom: 90 }}>
          {sectionContent}
        </View>
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 90 }} nestedScrollEnabled>
          {sectionContent}
        </ScrollView>
      )}

      <AddSupplementModal
        visible={showAdd}
        ingredients={ingredients}
        ingredientsLoading={ingredientsLoading}
        initialIngredient={addInitialIngredient}
        authToken={authToken}
        onClose={closeAddSupplement}
        onAdd={async (body) => {
          try {
            await api.addStackItem(authToken, body as any);
            closeAddSupplement();
            reload();
          } catch (e: any) {
            Alert.alert('Could not add', String(e?.message ?? e));
          }
        }}
        onAddMany={async (bodies) => {
          // Batch: sequentially add so a mid-failure still saves the
          // good ones. Show a consolidated result at the end.
          let added = 0;
          for (const body of bodies) {
            try {
              await api.addStackItem(authToken, body as any);
              added++;
            } catch { /* skip failed rows silently — user can retry */ }
          }
          closeAddSupplement();
          reload();
          Alert.alert(
            added === bodies.length ? 'Added' : 'Partial add',
            `${added} of ${bodies.length} supplement${bodies.length === 1 ? '' : 's'} added to your stack.`,
          );
        }}
        themeName={themeName}
        userProfile={userProfile}
      />
      <SupplementDetailModal
        visible={!!detailTarget}
        item={detailTarget}
        themeName={themeName}
        onClose={() => setDetailTarget(null)}
        onEdit={(item) => {
          setDetailTarget(null);
          setEditTarget(item);
        }}
        onShowHistory={(item) => {
          setDetailTarget(null);
          setHistoryCalendarTarget(item);
        }}
        onRemove={handleRemove}
      />
      <SupplementHistoryCalendarModal
        visible={!!historyCalendarTarget}
        item={historyCalendarTarget}
        authToken={authToken}
        themeName={themeName}
        onClose={() => setHistoryCalendarTarget(null)}
      />
      <SupplementRecommendationDetailModal
        visible={!!recDetailTarget}
        recommendation={recDetailTarget}
        themeName={themeName}
        onClose={() => setRecDetailTarget(null)}
      />
      <SupplementIngredientDetailModal
        visible={!!ingredientDetailTarget}
        ingredient={ingredientDetailTarget}
        themeName={themeName}
        onClose={() => setIngredientDetailTarget(null)}
        onAdd={(ingredient) => {
          setIngredientDetailTarget(null);
          openAddSupplement(ingredient);
        }}
      />
      <GroupSupplementModal
        visible={!!groupEditTarget}
        item={groupEditTarget}
        themeName={themeName}
        onClose={() => setGroupEditTarget(null)}
        onSave={handleSaveGroup}
      />
      <EditSupplementModal
        visible={!!editTarget}
        item={editTarget}
        themeName={themeName}
        onClose={() => setEditTarget(null)}
        onSave={handleSaveSupplementEdit}
      />
      <CaffeineLogModal
        visible={!!caffeineLogTarget}
        item={caffeineLogTarget}
        themeName={themeName}
        onClose={() => setCaffeineLogTarget(null)}
        onSave={async (item, amount, unit, takenAt) => {
          try {
            await api.logDose(authToken, item.id, {
              skipped: false,
              dose_amount: amount,
              dose_unit: unit,
              taken_at: takenAt,
            });
            setCaffeineLogTarget(null);
            reload();
          } catch (e: any) {
            Alert.alert('Could not log caffeine', String(e?.message ?? e));
          }
        }}
      />
    </View>
  );
}


function SupplementDetailModal({
  visible, item, themeName, onClose, onEdit, onShowHistory, onRemove,
}: {
  visible: boolean;
  item: (api.StackItem | api.TodayStackItem) | null;
  themeName?: AppThemeName;
  onClose: () => void;
  onEdit: (item: api.StackItem | api.TodayStackItem) => void;
  onShowHistory: (item: api.StackItem) => void;
  onRemove: (item: api.StackItem) => void;
}) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const tiers = tierColors(tc);

  if (!item) return null;

  const name = supplementDisplayName(item);
  const doseLabel = supplementDoseLabel(item.dose_amount, item.dose_unit);
  const todayItem = 'logs_today' in item && Array.isArray(item.logs_today) ? item : null;
  const takenLogs = todayItem ? takenTodaySupplementLogs(todayItem) : [];
  const taken = takenLogs.length > 0 ? takenLogs[takenLogs.length - 1] : undefined;
  const skipped = !taken && todayItem ? skippedTodaySupplementLog(todayItem) : undefined;
  const statusLabel = todayItem && taken
    ? `${todayDoseSummary(todayItem)} · last ${new Date(taken.taken_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
    : skipped ? 'Skipped today' : '';

  const facts = [
    ['Dose', doseLabel],
    ['Frequency', formatSupplementLabel(item.frequency)],
    ['Timing', formatSupplementLabel(item.timing)],
    ['Group', item.group_label],
    ['Category', formatSupplementLabel(item.category)],
    ['Status', statusLabel],
  ].filter(([, value]) => !!value);

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.58)', justifyContent: 'flex-end' }}>
        <View style={{
          backgroundColor: tc.background,
          borderTopLeftRadius: 20,
          borderTopRightRadius: 20,
          maxHeight: '90%',
          overflow: 'hidden',
        }}>
          <ScrollView contentContainerStyle={{ paddingBottom: 28 }}>
            <SupplementHeroHeader
              item={{
                custom_name: name,
                category: item.category,
                ingredient_slug: 'ingredient_slug' in item ? item.ingredient_slug : null,
                source_terms: (item as any).source_terms ?? null,
                food_sources: (item as any).food_sources ?? null,
              }}
              title={name}
              tc={tc}
              onClose={onClose}
            />

            <View style={{ padding: 16, gap: 16 }}>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 9 }}>
                <EvidenceGauge tier={item.evidence_tier} tc={tc} tiers={tiers} />
                <RiskBadge tier={item.risk_tier} tc={tc} tiers={tiers} />
                {item.effectiveness_confidence && (
                  <Pill
                    label={`${item.effectiveness_confidence.toUpperCase()} CONFIDENCE`}
                    color={confidenceColor(tc, item.effectiveness_confidence)}
                  />
                )}
              </View>

              {facts.length > 0 && (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  {facts.map(([label, value]) => (
                    <View key={label} style={{
                      minWidth: '45%',
                      flexGrow: 1,
                      backgroundColor: tc.surface,
                      borderWidth: 1,
                      borderColor: tc.border,
                      borderRadius: 10,
                      padding: 10,
                      gap: 3,
                    }}>
                      <Text style={{ fontSize: 10, fontWeight: '900', color: tc.textMuted, textTransform: 'uppercase' }}>
                        {label}
                      </Text>
                      <Text style={{ fontSize: 13, fontWeight: '700', color: tc.textPrimary }} numberOfLines={2}>
                        {value}
                      </Text>
                    </View>
                  ))}
                </View>
              )}

              {item.description && (
                <View style={{ gap: 5 }}>
                  <Text style={{ fontSize: 13, fontWeight: '900', color: tc.textPrimary }}>Purpose</Text>
                  <Text style={{ fontSize: 13, color: tc.textSecondary, lineHeight: 19 }}>
                    {item.description}
                  </Text>
                </View>
              )}

              <DetailListBlock
                title="Commonly Used For"
                items={item.common_uses}
                tc={tc}
                icon="sparkles-outline"
              />

              <DetailListBlock
                title="Low Intake Risks"
                items={item.deficiency_risks}
                tc={tc}
                icon="alert-circle-outline"
                tone="warning"
              />

              <DetailListBlock
                title="Excess Intake Risks"
                items={item.excess_risks}
                tc={tc}
                icon="warning-outline"
                tone="error"
              />

              <DetailListBlock
                title="Common Foods"
                items={item.food_sources}
                tc={tc}
                icon="restaurant-outline"
              />

              {item.goal && (
                <View style={{ gap: 5 }}>
                  <Text style={{ fontSize: 13, fontWeight: '900', color: tc.textPrimary }}>Goal</Text>
                  <Text style={{ fontSize: 13, color: tc.textSecondary, lineHeight: 19 }}>
                    {item.goal}
                  </Text>
                </View>
              )}

              {item.timing_notes && (
                <View style={{
                  backgroundColor: tc.surface,
                  borderRadius: 10,
                  borderWidth: 1,
                  borderColor: tc.border,
                  padding: 12,
                  gap: 5,
                }}>
                  <Text style={{ fontSize: 12, fontWeight: '900', color: tc.textPrimary }}>Timing notes</Text>
                  <Text style={{ fontSize: 12, color: tc.textSecondary, lineHeight: 18 }}>{item.timing_notes}</Text>
                </View>
              )}

              {item.safety_notes && (
                <View style={{
                  backgroundColor: tc.warning + '14',
                  borderRadius: 10,
                  borderWidth: 1,
                  borderColor: tc.warning + '55',
                  padding: 12,
                  gap: 5,
                }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Ionicons name="warning-outline" size={14} color={tc.warning} />
                    <Text style={{ fontSize: 12, fontWeight: '900', color: tc.warning }}>Safety notes</Text>
                  </View>
                  <Text style={{ fontSize: 12, color: tc.textSecondary, lineHeight: 18 }}>{item.safety_notes}</Text>
                </View>
              )}

              <UsageGuidanceBlock guidance={item.usage_guidance} tc={tc} />

              <View style={{ flexDirection: 'row', gap: 8 }}>
                <TouchableOpacity
                  testID={`supplement-detail-history-${e2eId(name)}`}
                  accessibilityLabel={`supplement-detail-history-${e2eId(name)}`}
                  onPress={() => onShowHistory(item)}
                  style={{
                    flex: 1,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                    backgroundColor: tc.primary + '12',
                    borderWidth: 1,
                    borderColor: tc.primary + '55',
                    borderRadius: 11,
                    paddingVertical: 11,
                  }}
                >
                  <Ionicons name="calendar-outline" size={15} color={tc.primary} />
                  <Text style={{ color: tc.primary, fontWeight: '800', fontSize: 12 }}>History</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => onEdit(item)}
                  style={{
                    flex: 1,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                    backgroundColor: tc.surface,
                    borderWidth: 1,
                    borderColor: tc.border,
                    borderRadius: 11,
                    paddingVertical: 11,
                  }}
                >
                  <Ionicons name="create-outline" size={15} color={tc.textSecondary} />
                  <Text style={{ color: tc.textSecondary, fontWeight: '800', fontSize: 12 }}>Edit</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => onRemove(item)}
                  style={{
                    flex: 1,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                    backgroundColor: tc.error + '12',
                    borderWidth: 1,
                    borderColor: tc.error + '44',
                    borderRadius: 11,
                    paddingVertical: 11,
                  }}
                >
                  <Ionicons name="trash-outline" size={15} color={tc.error} />
                  <Text style={{ color: tc.error, fontWeight: '800', fontSize: 12 }}>Remove</Text>
                </TouchableOpacity>
              </View>
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function SupplementHistoryCalendarModal({
  visible, item, authToken, themeName, onClose,
}: {
  visible: boolean;
  item: (api.StackItem | api.TodayStackItem) | null;
  authToken: string;
  themeName?: AppThemeName;
  onClose: () => void;
}) {
  const { height: windowHeight } = useWindowDimensions();
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const [history, setHistory] = useState<api.SupplementHistoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string>(localDateKey(new Date()));
  const seqRef = useRef(0);

  useEffect(() => {
    if (!visible || !item) return;
    const token = authToken?.trim();
    if (!token) {
      setHistory(null);
      setLoading(false);
      setLoadError(null);
      return;
    }
    const seq = ++seqRef.current;
    setLoading(true);
    setLoadError(null);
    api.getSupplementHistory(token, 180, 500, { stackItemId: item.id })
      .then((result) => {
        if (seq !== seqRef.current) return;
        setHistory(result);
        const firstLog = result.items.find(row => !row.skipped) ?? result.items[0];
        setSelectedKey(firstLog ? supplementLogDateKey(firstLog.taken_at) : localDateKey(new Date()));
      })
      .catch((error) => {
        if (seq !== seqRef.current) return;
        setHistory(null);
        setLoadError(loadErrorMessage('supplement history', error));
      })
      .finally(() => {
        if (seq === seqRef.current) setLoading(false);
      });
    return () => {
      seqRef.current += 1;
    };
  }, [visible, item?.id, authToken]);

  const dayBuckets = useMemo(() => {
    const buckets = new Map<string, {
      items: api.SupplementHistoryItem[];
      taken: api.SupplementHistoryItem[];
      skipped: api.SupplementHistoryItem[];
    }>();
    for (const row of history?.items ?? []) {
      const key = supplementLogDateKey(row.taken_at);
      const bucket = buckets.get(key) ?? { items: [], taken: [], skipped: [] };
      bucket.items.push(row);
      if (row.skipped) bucket.skipped.push(row);
      else bucket.taken.push(row);
      buckets.set(key, bucket);
    }
    return buckets;
  }, [history]);

  const calendarStats = useMemo(() => {
    const today = localDateFromKey(localDateKey(new Date()));
    const start30 = addLocalDays(today, -29);
    const takenKeys = new Set(
      Array.from(dayBuckets.entries())
        .filter(([, bucket]) => bucket.taken.length > 0)
        .map(([key]) => key),
    );
    const skippedKeys = new Set(
      Array.from(dayBuckets.entries())
        .filter(([, bucket]) => bucket.skipped.length > 0 && bucket.taken.length === 0)
        .map(([key]) => key),
    );

    let takenLast30 = 0;
    let skippedLast30 = 0;
    for (const key of takenKeys) {
      const date = localDateFromKey(key);
      if (date >= start30 && date <= today) takenLast30 += 1;
    }
    for (const key of skippedKeys) {
      const date = localDateFromKey(key);
      if (date >= start30 && date <= today) skippedLast30 += 1;
    }

    let currentStreak = 0;
    for (let cursor = today; takenKeys.has(localDateKey(cursor)); cursor = addLocalDays(cursor, -1)) {
      currentStreak += 1;
    }

    let lastBreak = 'None in range';
    for (let i = 0; i < 180; i += 1) {
      const key = localDateKey(addLocalDays(today, -i));
      if (!takenKeys.has(key)) {
        lastBreak = shortDateLabel(key);
        break;
      }
    }

    return { takenLast30, skippedLast30, currentStreak, lastBreak };
  }, [dayBuckets]);

  const selectedItems = useMemo(() => {
    return (dayBuckets.get(selectedKey)?.items ?? [])
      .slice()
      .sort((a, b) => new Date(a.taken_at).getTime() - new Date(b.taken_at).getTime());
  }, [dayBuckets, selectedKey]);

  if (!item) return null;

  const name = supplementDisplayName(item);
  const months = recentCalendarMonths(6);
  const todayKey = localDateKey(new Date());
  const selectedLabel = shortDateLabel(selectedKey);
  const hasAnyHistory = (history?.items.length ?? 0) > 0;

  const renderDay = (date: Date | null, index: number) => {
    if (!date) {
      return <View key={`empty-${index}`} style={{ flex: 1, aspectRatio: 1, padding: 2 }} />;
    }
    const key = localDateKey(date);
    const bucket = dayBuckets.get(key);
    const hasTaken = (bucket?.taken.length ?? 0) > 0;
    const hasSkippedOnly = !hasTaken && (bucket?.skipped.length ?? 0) > 0;
    const isSelected = selectedKey === key;
    const isToday = todayKey === key;
    const isFuture = date > localDateFromKey(todayKey);
    const color = hasTaken ? tc.success : hasSkippedOnly ? tc.textMuted : tc.textSecondary;
    const fill = isSelected
      ? tc.primary + '1F'
      : hasTaken
        ? tc.success + '18'
        : hasSkippedOnly
          ? tc.border
          : 'transparent';

    return (
      <TouchableOpacity
        key={key}
        disabled={isFuture}
        onPress={() => setSelectedKey(key)}
        style={{ flex: 1, aspectRatio: 1, padding: 2, opacity: isFuture ? 0.35 : 1 }}
      >
        <View style={{
          flex: 1,
          borderRadius: 8,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: fill,
          borderWidth: isSelected || isToday ? 1 : 0,
          borderColor: isSelected ? tc.primary : isToday ? tc.primary + '66' : 'transparent',
        }}>
          <Text style={{
            fontSize: 11,
            fontWeight: hasTaken || isSelected || isToday ? '900' : '700',
            color,
          }}>
            {date.getDate()}
          </Text>
          {bucket ? (
            <View style={{
              width: 5,
              height: 5,
              borderRadius: 3,
              marginTop: 2,
              backgroundColor: hasTaken ? tc.success : tc.textMuted,
            }} />
          ) : null}
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.58)', justifyContent: 'flex-end' }}>
        <View style={{
          backgroundColor: tc.background,
          borderTopLeftRadius: 20,
          borderTopRightRadius: 20,
          maxHeight: Math.min(windowHeight * 0.92, 780),
          overflow: 'hidden',
        }}>
          <View style={{
            paddingHorizontal: 16,
            paddingTop: 16,
            paddingBottom: 12,
            borderBottomWidth: 1,
            borderBottomColor: tc.border,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
          }}>
            <View style={{
              width: 40,
              height: 40,
              borderRadius: 14,
              backgroundColor: tc.primary + '18',
              alignItems: 'center',
              justifyContent: 'center',
            }}>
              <Ionicons name="calendar-outline" size={20} color={tc.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 16, fontWeight: '900', color: tc.textPrimary }} numberOfLines={1}>
                {name}
              </Text>
              <Text style={{ marginTop: 2, fontSize: 11, fontWeight: '800', color: tc.textMuted, textTransform: 'uppercase' }}>
                Dose history
              </Text>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={22} color={tc.textSecondary} />
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 30, gap: 14 }}>
            {item.usage_guidance ? <UsageGuidanceBlock guidance={item.usage_guidance} tc={tc} /> : null}

            <View style={{ flexDirection: 'row', gap: 8 }}>
              {[
                [`${calendarStats.takenLast30}/30`, 'Taken'],
                [`${calendarStats.currentStreak}`, 'Streak'],
                [calendarStats.lastBreak, 'Last break'],
              ].map(([value, label]) => (
                <View key={label} style={{
                  flex: 1,
                  backgroundColor: tc.surface,
                  borderWidth: 1,
                  borderColor: tc.border,
                  borderRadius: 10,
                  paddingVertical: 10,
                  paddingHorizontal: 8,
                  alignItems: 'center',
                  gap: 2,
                }}>
                  <Text style={{ fontSize: label === 'Last break' ? 13 : 18, fontWeight: '900', color: tc.textPrimary }} numberOfLines={1}>
                    {value}
                  </Text>
                  <Text style={{ fontSize: 9, fontWeight: '900', color: tc.textMuted, textTransform: 'uppercase' }}>
                    {label}
                  </Text>
                </View>
              ))}
            </View>

            {calendarStats.skippedLast30 > 0 ? (
              <View style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 7,
                backgroundColor: tc.surface,
                borderWidth: 1,
                borderColor: tc.border,
                borderRadius: 10,
                padding: 10,
              }}>
                <Ionicons name="close-circle-outline" size={16} color={tc.textMuted} />
                <Text style={{ flex: 1, fontSize: 11, color: tc.textSecondary, lineHeight: 16 }}>
                  {calendarStats.skippedLast30} skipped day{calendarStats.skippedLast30 === 1 ? '' : 's'} in the last 30.
                </Text>
              </View>
            ) : null}

            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: tc.success }} />
                <Text style={{ fontSize: 10, fontWeight: '800', color: tc.textMuted }}>Taken</Text>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: tc.textMuted }} />
                <Text style={{ fontSize: 10, fontWeight: '800', color: tc.textMuted }}>Skipped</Text>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <View style={{ width: 12, height: 12, borderRadius: 6, borderWidth: 1, borderColor: tc.primary }} />
                <Text style={{ fontSize: 10, fontWeight: '800', color: tc.textMuted }}>Today</Text>
              </View>
            </View>

            {loading ? (
              <View style={{ paddingVertical: 24, alignItems: 'center', gap: 8 }}>
                <ActivityIndicator color={tc.primary} />
                <Text style={{ fontSize: 12, color: tc.textMuted }}>Loading calendar…</Text>
              </View>
            ) : loadError ? (
              <View style={{ paddingVertical: 20, alignItems: 'center', gap: 10 }}>
                <Ionicons name="cloud-offline-outline" size={28} color={tc.textMuted} />
                <Text style={{ fontSize: 12, color: tc.textSecondary, textAlign: 'center' }}>{loadError}</Text>
              </View>
            ) : (
              <>
                {!hasAnyHistory ? (
                  <View style={{
                    padding: 16,
                    alignItems: 'center',
                    borderRadius: 12,
                    borderWidth: 1,
                    borderColor: tc.border,
                    backgroundColor: tc.surface,
                    gap: 6,
                  }}>
                    <Ionicons name="time-outline" size={28} color={tc.textMuted} />
                    <Text style={{ fontSize: 13, fontWeight: '800', color: tc.textSecondary }}>
                      No logged days yet.
                    </Text>
                    <Text style={{ fontSize: 11, color: tc.textMuted, textAlign: 'center' }}>
                      Taken and skipped doses will appear on this calendar.
                    </Text>
                  </View>
                ) : null}

                {months.map(month => (
                  <View key={month.toISOString()} style={{
                    backgroundColor: tc.surface,
                    borderWidth: 1,
                    borderColor: tc.border,
                    borderRadius: 12,
                    padding: 12,
                    gap: 8,
                  }}>
                    <Text style={{ fontSize: 13, fontWeight: '900', color: tc.textPrimary }}>
                      {calendarMonthLabel(month)}
                    </Text>
                    <View style={{ flexDirection: 'row' }}>
                      {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((day, idx) => (
                        <Text key={`${day}-${idx}`} style={{
                          flex: 1,
                          textAlign: 'center',
                          fontSize: 9,
                          fontWeight: '900',
                          color: tc.textMuted,
                        }}>
                          {day}
                        </Text>
                      ))}
                    </View>
                    {buildCalendarWeeks(month.getFullYear(), month.getMonth()).map((week, idx) => (
                      <View key={`${month.toISOString()}-${idx}`} style={{ flexDirection: 'row' }}>
                        {week.map(renderDay)}
                      </View>
                    ))}
                  </View>
                ))}

                <View style={{
                  backgroundColor: tc.surface,
                  borderWidth: 1,
                  borderColor: tc.border,
                  borderRadius: 12,
                  padding: 12,
                  gap: 10,
                }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                    <Text style={{ flex: 1, fontSize: 13, fontWeight: '900', color: tc.textPrimary }} numberOfLines={1}>
                      {selectedLabel}
                    </Text>
                    <Text style={{ fontSize: 10, fontWeight: '800', color: tc.textMuted }}>
                      {selectedItems.length ? `${selectedItems.length} log${selectedItems.length === 1 ? '' : 's'}` : 'No log'}
                    </Text>
                  </View>
                  {selectedItems.length === 0 ? (
                    <Text style={{ fontSize: 12, color: tc.textMuted }}>
                      No dose logged for this day.
                    </Text>
                  ) : (
                    <View style={{ gap: 8 }}>
                      {selectedItems.map(row => (
                        <View key={row.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}>
                          <View style={{
                            width: 28,
                            height: 28,
                            borderRadius: 14,
                            backgroundColor: row.skipped ? tc.border : tc.success + '18',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}>
                            <Ionicons name={row.skipped ? 'close' : 'checkmark'} size={15} color={row.skipped ? tc.textMuted : tc.success} />
                          </View>
                          <View style={{ flex: 1 }}>
                            <Text style={{ fontSize: 12, fontWeight: '800', color: tc.textPrimary }}>
                              {row.skipped ? 'Skipped' : 'Taken'} · {supplementHistoryTimeLabel(row.taken_at)}
                            </Text>
                            <Text style={{ marginTop: 1, fontSize: 10, color: tc.textMuted }} numberOfLines={1}>
                              {[supplementDoseLabel(row.dose_amount, row.dose_unit), formatSupplementLabel(row.timing_context), formatSupplementLabel(row.source)]
                                .filter(Boolean)
                                .join(' · ')}
                            </Text>
                          </View>
                        </View>
                      ))}
                    </View>
                  )}
                </View>
              </>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}


function SupplementRecommendationDetailModal({
  visible, recommendation, themeName, onClose,
}: {
  visible: boolean;
  recommendation: api.SupplementRecommendation | null;
  themeName?: AppThemeName;
  onClose: () => void;
}) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const tiers = tierColors(tc);

  if (!recommendation) return null;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.58)', justifyContent: 'flex-end' }}>
        <View style={{
          backgroundColor: tc.background,
          borderTopLeftRadius: 20,
          borderTopRightRadius: 20,
          maxHeight: '86%',
          overflow: 'hidden',
        }}>
          <ScrollView contentContainerStyle={{ paddingBottom: 28 }}>
            <SupplementHeroHeader
              item={{ custom_name: recommendation.title, ingredient_slug: recommendation.slug, category: recommendation.priority }}
              title={recommendation.title}
              subtitle={`${recommendation.priority.toUpperCase()} PRIORITY`}
              tc={tc}
              onClose={onClose}
              height={158}
            />

            <View style={{ padding: 16, gap: 16 }}>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 9 }}>
                <EvidenceGauge tier={recommendation.evidence_tier} tc={tc} tiers={tiers} />
                <RiskBadge tier={recommendation.risk_tier} tc={tc} tiers={tiers} />
              </View>

              <View style={{ gap: 5 }}>
                <Text style={{ fontSize: 13, fontWeight: '900', color: tc.textPrimary }}>Why it showed up</Text>
                <Text style={{ fontSize: 13, color: tc.textSecondary, lineHeight: 19 }}>
                  {recommendation.reason}
                </Text>
              </View>

              <View style={{
                backgroundColor: tc.surface,
                borderRadius: 10,
                borderWidth: 1,
                borderColor: tc.border,
                padding: 12,
                gap: 5,
              }}>
                <Text style={{ fontSize: 12, fontWeight: '900', color: tc.textPrimary }}>Guidance</Text>
                <Text style={{ fontSize: 12, color: tc.textSecondary, lineHeight: 18 }}>
                  {recommendation.cautious_guidance}
                </Text>
              </View>
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}


function SupplementIngredientDetailModal({
  visible, ingredient, themeName, onClose, onAdd,
}: {
  visible: boolean;
  ingredient: api.SupplementIngredient | null;
  themeName?: AppThemeName;
  onClose: () => void;
  onAdd: (ingredient: api.SupplementIngredient) => void;
}) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const tiers = tierColors(tc);

  if (!ingredient) return null;

  const facts = [
    ['Category', formatSupplementLabel(ingredient.category)],
    ['Tracking Unit', ingredient.default_unit],
  ].filter(([, value]) => !!value);

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.58)', justifyContent: 'flex-end' }}>
        <View style={{
          backgroundColor: tc.background,
          borderTopLeftRadius: 20,
          borderTopRightRadius: 20,
          maxHeight: '90%',
          overflow: 'hidden',
        }}>
          <ScrollView contentContainerStyle={{ paddingBottom: 28 }}>
            <SupplementHeroHeader
              item={{ custom_name: ingredient.name, ingredient_slug: ingredient.slug, category: ingredient.category, food_sources: ingredient.food_sources }}
              title={ingredient.name}
              subtitle={formatSupplementLabel(ingredient.category)}
              tc={tc}
              onClose={onClose}
            />

            <View style={{ padding: 16, gap: 16 }}>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 9 }}>
                <EvidenceGauge tier={ingredient.evidence_tier} tc={tc} tiers={tiers} />
                <RiskBadge tier={ingredient.risk_tier} tc={tc} tiers={tiers} />
              </View>

              {facts.length > 0 && (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  {facts.map(([label, value]) => (
                    <View key={label} style={{
                      minWidth: '45%',
                      flexGrow: 1,
                      backgroundColor: tc.surface,
                      borderWidth: 1,
                      borderColor: tc.border,
                      borderRadius: 10,
                      padding: 10,
                      gap: 3,
                    }}>
                      <Text style={{ fontSize: 10, fontWeight: '900', color: tc.textMuted, textTransform: 'uppercase' }}>
                        {label}
                      </Text>
                      <Text style={{ fontSize: 13, fontWeight: '700', color: tc.textPrimary }} numberOfLines={2}>
                        {value}
                      </Text>
                    </View>
                  ))}
                </View>
              )}

              {ingredient.description && (
                <View style={{ gap: 5 }}>
                  <Text style={{ fontSize: 13, fontWeight: '900', color: tc.textPrimary }}>Purpose</Text>
                  <Text style={{ fontSize: 13, color: tc.textSecondary, lineHeight: 19 }}>
                    {ingredient.description}
                  </Text>
                </View>
              )}

              <DetailListBlock
                title="Commonly Used For"
                items={ingredient.common_uses}
                tc={tc}
                icon="sparkles-outline"
              />

              <DetailListBlock
                title="Low Intake Risks"
                items={ingredient.deficiency_risks}
                tc={tc}
                icon="alert-circle-outline"
                tone="warning"
              />

              <DetailListBlock
                title="Excess Intake Risks"
                items={ingredient.excess_risks}
                tc={tc}
                icon="warning-outline"
                tone="error"
              />

              <DetailListBlock
                title="Common Foods"
                items={ingredient.food_sources}
                tc={tc}
                icon="restaurant-outline"
              />

              {ingredient.timing_notes && (
                <View style={{
                  backgroundColor: tc.surface,
                  borderRadius: 10,
                  borderWidth: 1,
                  borderColor: tc.border,
                  padding: 12,
                  gap: 5,
                }}>
                  <Text style={{ fontSize: 12, fontWeight: '900', color: tc.textPrimary }}>Timing notes</Text>
                  <Text style={{ fontSize: 12, color: tc.textSecondary, lineHeight: 18 }}>{ingredient.timing_notes}</Text>
                </View>
              )}

              {ingredient.safety_notes && (
                <View style={{
                  backgroundColor: tc.warning + '14',
                  borderRadius: 10,
                  borderWidth: 1,
                  borderColor: tc.warning + '55',
                  padding: 12,
                  gap: 5,
                }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Ionicons name="warning-outline" size={14} color={tc.warning} />
                    <Text style={{ fontSize: 12, fontWeight: '900', color: tc.warning }}>Safety notes</Text>
                  </View>
                  <Text style={{ fontSize: 12, color: tc.textSecondary, lineHeight: 18 }}>{ingredient.safety_notes}</Text>
                </View>
              )}

              <UsageGuidanceBlock guidance={ingredient.usage_guidance} tc={tc} />

              <TouchableOpacity
                testID={`supplement-browse-detail-add-${e2eId(ingredient.name)}`}
                accessibilityLabel={`supplement-browse-detail-add-${e2eId(ingredient.name)}`}
                onPress={() => onAdd(ingredient)}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 7,
                  backgroundColor: tc.primary,
                  borderRadius: 12,
                  paddingVertical: 13,
                }}
              >
                <Ionicons name="add" size={17} color={getContrastingTextColor(tc.primary)} />
                <Text style={{ color: getContrastingTextColor(tc.primary), fontWeight: '900', fontSize: 14 }}>
                  Add to stack
                </Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}


function EditSupplementModal({
  visible, item, themeName, onClose, onSave,
}: {
  visible: boolean;
  item: (api.StackItem | api.TodayStackItem) | null;
  themeName?: AppThemeName;
  onClose: () => void;
  onSave: (item: api.StackItem | api.TodayStackItem, patch: Partial<api.StackItem>) => void | Promise<void>;
}) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const [name, setName] = useState('');
  const [dose, setDose] = useState('');
  const [unit, setUnit] = useState('');
  const [freq, setFreq] = useState<'daily' | 'weekdays' | 'as_needed' | 'pre_workout'>('daily');
  const [timing, setTiming] = useState<SupplementTiming | ''>('');
  const [groupLabel, setGroupLabel] = useState('');
  const [notes, setNotes] = useState('');
  const [takenWithFood, setTakenWithFood] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!visible || !item) return;
    setName(supplementDisplayName(item));
    setDose(String(item.dose_amount ?? ''));
    setUnit(item.dose_unit || 'mg');
    const nextFreq = (item.frequency || 'daily') as 'daily' | 'weekdays' | 'as_needed' | 'pre_workout';
    setFreq(['daily', 'weekdays', 'as_needed', 'pre_workout'].includes(nextFreq) ? nextFreq : 'daily');
    const t = (item.timing || '') as SupplementTiming | '';
    setTiming(SUPPLEMENT_TIMINGS.includes(t as SupplementTiming) ? t : '');
    setGroupLabel(item.group_label || '');
    setNotes(item.notes || '');
    setTakenWithFood(!!item.taken_with_food);
    setSaving(false);
  }, [visible, item]);

  if (!item) return null;

  const handleSave = async () => {
    const parsedDose = Number(dose.trim());
    if (!Number.isFinite(parsedDose) || parsedDose <= 0) {
      Alert.alert('Dose required', 'Enter a dose amount greater than 0.');
      return;
    }
    const cleanUnit = unit.trim();
    if (!cleanUnit) {
      Alert.alert('Unit required', 'Enter a dose unit like mg, g, IU, capsules, or scoops.');
      return;
    }
    setSaving(true);
    try {
      await onSave(item, {
        custom_name: name.trim() || 'Supplement',
        dose_amount: parsedDose,
        dose_unit: cleanUnit,
        frequency: freq,
        timing: timing || null,
        group_label: groupLabel.trim() || null,
        notes: notes.trim() || null,
        taken_with_food: takenWithFood,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}>
        <View style={{
          backgroundColor: tc.background,
          borderTopLeftRadius: 20,
          borderTopRightRadius: 20,
          padding: 16,
          paddingBottom: 30,
          maxHeight: '88%',
        }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 16, fontWeight: '800', color: tc.textPrimary }}>Edit supplement</Text>
              <Text style={{ marginTop: 2, fontSize: 12, color: tc.textMuted }} numberOfLines={1}>
                {supplementDisplayName(item)}
              </Text>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={22} color={tc.textSecondary} />
            </TouchableOpacity>
          </View>

          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 4 }}>
            <Text style={{ fontSize: 11, fontWeight: '800', color: tc.textMuted, marginBottom: 6, textTransform: 'uppercase' }}>
              Name
            </Text>
            <TextInput
              testID="supplement-edit-name-input"
              value={name}
              onChangeText={setName}
              placeholder="Supplement name"
              placeholderTextColor={tc.textMuted}
              style={{
                backgroundColor: tc.surface,
                borderWidth: 1,
                borderColor: tc.border,
                borderRadius: 10,
                paddingHorizontal: 12,
                paddingVertical: 10,
                color: tc.textPrimary,
                fontSize: 14,
                marginBottom: 12,
                ...INPUT_TEXT_RESET,
              }}
            />

            <Text style={{ fontSize: 11, fontWeight: '800', color: tc.textMuted, marginBottom: 6, textTransform: 'uppercase' }}>
              Dose
            </Text>
            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
              <TextInput
                testID="supplement-edit-dose-input"
                value={dose}
                onChangeText={setDose}
                placeholder="Amount"
                placeholderTextColor={tc.textMuted}
                keyboardType="decimal-pad"
                style={{
                  flex: 2,
                  backgroundColor: tc.surface,
                  borderWidth: 1,
                  borderColor: tc.border,
                  borderRadius: 10,
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                  color: tc.textPrimary,
                  fontSize: 14,
                  ...INPUT_TEXT_RESET,
                }}
              />
              <TextInput
                testID="supplement-edit-unit-input"
                value={unit}
                onChangeText={setUnit}
                placeholder="unit"
                placeholderTextColor={tc.textMuted}
                autoCapitalize="none"
                style={{
                  flex: 1,
                  backgroundColor: tc.surface,
                  borderWidth: 1,
                  borderColor: tc.border,
                  borderRadius: 10,
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                  color: tc.textPrimary,
                  fontSize: 14,
                  ...INPUT_TEXT_RESET,
                }}
              />
            </View>

            <Text style={{ fontSize: 11, fontWeight: '800', color: tc.textMuted, marginBottom: 6, textTransform: 'uppercase' }}>
              Frequency
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
              {(['daily', 'weekdays', 'pre_workout', 'as_needed'] as const).map(f => {
                const active = freq === f;
                return (
                  <TouchableOpacity
                    key={f}
                    testID={`supplement-edit-frequency-${f}`}
                    accessibilityLabel={`supplement-edit-frequency-${f}`}
                    onPress={() => setFreq(f)}
                    style={{
                      backgroundColor: active ? tc.primary : tc.surface,
                      borderWidth: 1,
                      borderColor: active ? tc.primary : tc.border,
                      borderRadius: 14,
                      paddingVertical: 6,
                      paddingHorizontal: 10,
                    }}
                  >
                    <Text style={{
                      fontSize: 11,
                      fontWeight: '700',
                      color: active ? getContrastingTextColor(tc.primary) : tc.textSecondary,
                    }}>
                      {f.replace(/_/g, ' ')}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <Text style={{ fontSize: 11, fontWeight: '800', color: tc.textMuted, marginBottom: 6, textTransform: 'uppercase' }}>
              Timing
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
              {SUPPLEMENT_TIMINGS.map(t => {
                const active = timing === t;
                return (
                  <TouchableOpacity
                    key={t}
                    testID={`supplement-edit-timing-${t}`}
                    accessibilityLabel={`supplement-edit-timing-${t}`}
                    onPress={() => setTiming(active ? '' : t)}
                    style={{
                      backgroundColor: active ? tc.primary : tc.surface,
                      borderWidth: 1,
                      borderColor: active ? tc.primary : tc.border,
                      borderRadius: 14,
                      paddingVertical: 6,
                      paddingHorizontal: 10,
                    }}
                  >
                    <Text style={{
                      fontSize: 11,
                      fontWeight: '700',
                      color: active ? getContrastingTextColor(tc.primary) : tc.textSecondary,
                    }}>
                      {t.replace(/_/g, ' ')}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <Text style={{ fontSize: 11, fontWeight: '800', color: tc.textMuted, marginBottom: 6, textTransform: 'uppercase' }}>
              Batch name
            </Text>
            <TextInput
              testID="supplement-edit-group-label-input"
              value={groupLabel}
              onChangeText={setGroupLabel}
              placeholder="e.g. Stack 1, Travel pack"
              placeholderTextColor={tc.textMuted}
              maxLength={40}
              style={{
                backgroundColor: tc.surface,
                borderWidth: 1,
                borderColor: tc.border,
                borderRadius: 10,
                paddingHorizontal: 12,
                paddingVertical: 10,
                color: tc.textPrimary,
                fontSize: 14,
                marginBottom: 12,
                ...INPUT_TEXT_RESET,
              }}
            />

            <TouchableOpacity
              testID="supplement-edit-with-food-toggle"
              accessibilityLabel="supplement-edit-with-food-toggle"
              onPress={() => setTakenWithFood(value => !value)}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 9,
                backgroundColor: tc.surface,
                borderWidth: 1,
                borderColor: tc.border,
                borderRadius: 10,
                padding: 12,
                marginBottom: 12,
              }}
            >
              <View style={{
                width: 22,
                height: 22,
                borderRadius: 11,
                backgroundColor: takenWithFood ? tc.primary : tc.surfaceRaised,
                borderWidth: 1,
                borderColor: takenWithFood ? tc.primary : tc.border,
                alignItems: 'center',
                justifyContent: 'center',
              }}>
                {takenWithFood && <Ionicons name="checkmark" size={14} color={getContrastingTextColor(tc.primary)} />}
              </View>
              <Text style={{ flex: 1, fontSize: 13, fontWeight: '800', color: tc.textPrimary }}>
                Take with food
              </Text>
            </TouchableOpacity>

            <Text style={{ fontSize: 11, fontWeight: '800', color: tc.textMuted, marginBottom: 6, textTransform: 'uppercase' }}>
              Notes
            </Text>
            <TextInput
              testID="supplement-edit-notes-input"
              value={notes}
              onChangeText={setNotes}
              placeholder="Optional"
              placeholderTextColor={tc.textMuted}
              multiline
              style={{
                minHeight: 78,
                textAlignVertical: 'top',
                backgroundColor: tc.surface,
                borderWidth: 1,
                borderColor: tc.border,
                borderRadius: 10,
                paddingHorizontal: 12,
                paddingVertical: 10,
                color: tc.textPrimary,
                fontSize: 14,
                marginBottom: 16,
                ...INPUT_TEXT_RESET,
              }}
            />

            <TouchableOpacity
              testID="supplement-edit-save"
              accessibilityLabel="supplement-edit-save"
              onPress={handleSave}
              disabled={saving}
              style={{
                backgroundColor: tc.primary,
                borderRadius: 12,
                paddingVertical: 13,
                alignItems: 'center',
                opacity: saving ? 0.65 : 1,
              }}
            >
              {saving ? (
                <ActivityIndicator size="small" color={getContrastingTextColor(tc.primary)} />
              ) : (
                <Text style={{ fontSize: 14, fontWeight: '900', color: getContrastingTextColor(tc.primary) }}>
                  Save changes
                </Text>
              )}
            </TouchableOpacity>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}


function GroupSupplementModal({
  visible, item, themeName, onClose, onSave,
}: {
  visible: boolean;
  item: api.StackItem | null;
  themeName?: AppThemeName;
  onClose: () => void;
  onSave: (item: api.StackItem, patch: { timing?: string | null; group_label?: string | null }) => void | Promise<void>;
}) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const [timing, setTiming] = useState<SupplementTiming | ''>('');
  const [groupLabel, setGroupLabel] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!visible || !item) return;
    const t = (item.timing || '') as SupplementTiming | '';
    setTiming(SUPPLEMENT_TIMINGS.includes(t as SupplementTiming) ? t : '');
    setGroupLabel(item.group_label || '');
    setSaving(false);
  }, [visible, item]);

  if (!item) return null;

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(item, {
        timing: timing || null,
        group_label: groupLabel.trim() || null,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}>
        <View style={{
          backgroundColor: tc.background,
          borderTopLeftRadius: 20,
          borderTopRightRadius: 20,
          padding: 16,
          paddingBottom: 30,
        }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 16, fontWeight: '800', color: tc.textPrimary }}>Group supplement</Text>
              <Text style={{ marginTop: 2, fontSize: 12, color: tc.textMuted }} numberOfLines={1}>
                {item.custom_name || 'Supplement'}
              </Text>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={22} color={tc.textSecondary} />
            </TouchableOpacity>
          </View>

          <Text style={{ fontSize: 11, fontWeight: '800', color: tc.textMuted, marginBottom: 6, textTransform: 'uppercase' }}>
            Timing bucket
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
            {SUPPLEMENT_TIMINGS.map(t => {
              const active = timing === t;
              return (
                <TouchableOpacity
                  key={t}
                  testID={`supplement-edit-timing-${t}`}
                  accessibilityLabel={`supplement-edit-timing-${t}`}
                  onPress={() => setTiming(active ? '' : t)}
                  style={{
                    backgroundColor: active ? tc.primary : tc.surface,
                    borderWidth: 1,
                    borderColor: active ? tc.primary : tc.border,
                    borderRadius: 14,
                    paddingVertical: 7,
                    paddingHorizontal: 10,
                  }}
                >
                  <Text style={{
                    fontSize: 11,
                    fontWeight: '800',
                    color: active ? getContrastingTextColor(tc.primary) : tc.textSecondary,
                  }}>
                    {t.replace(/_/g, ' ')}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <Text style={{ fontSize: 11, fontWeight: '800', color: tc.textMuted, marginBottom: 6, textTransform: 'uppercase' }}>
            Custom group
          </Text>
          <TextInput
            testID="supplement-edit-group-label"
            value={groupLabel}
            onChangeText={setGroupLabel}
            placeholder="Pre-workout, Bedtime, Travel pack"
            placeholderTextColor={tc.textMuted}
            maxLength={40}
            style={{
              backgroundColor: tc.surface,
              borderWidth: 1,
              borderColor: tc.border,
              borderRadius: 10,
              paddingHorizontal: 12,
              paddingVertical: 11,
              color: tc.textPrimary,
              fontSize: 14,
              ...INPUT_TEXT_RESET,
            }}
          />

          <TouchableOpacity
            testID="supplement-edit-group-save"
            accessibilityLabel="supplement-edit-group-save"
            onPress={handleSave}
            disabled={saving}
            style={{
              marginTop: 16,
              backgroundColor: tc.primary,
              borderRadius: 12,
              paddingVertical: 13,
              alignItems: 'center',
              opacity: saving ? 0.65 : 1,
            }}
          >
            {saving ? (
              <ActivityIndicator size="small" color={getContrastingTextColor(tc.primary)} />
            ) : (
              <Text style={{ fontSize: 14, fontWeight: '900', color: getContrastingTextColor(tc.primary) }}>
                Save group
              </Text>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}


function CaffeineLogModal({
  visible, item, themeName, onClose, onSave,
}: {
  visible: boolean;
  item: api.TodayStackItem | null;
  themeName?: AppThemeName;
  onClose: () => void;
  onSave: (item: api.TodayStackItem, amount: number, unit: string, takenAt: string) => void | Promise<void>;
}) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const [amount, setAmount] = useState('');
  const [time, setTime] = useState(defaultDoseTime());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!visible || !item) return;
    setAmount(String(item.dose_amount ?? ''));
    setTime(defaultDoseTime());
    setSaving(false);
  }, [visible, item]);

  if (!item) return null;

  const unit = item.dose_unit || 'mg';
  const handleSave = async () => {
    const parsedAmount = Number(amount.trim());
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      Alert.alert('Amount required', `Enter the caffeine amount in ${unit}.`);
      return;
    }
    const takenAt = parseTodayDoseTime(time);
    if (!takenAt) {
      Alert.alert('Time required', 'Enter a time like 08:30 or 2:15 pm.');
      return;
    }
    setSaving(true);
    try {
      await onSave(item, parsedAmount, unit, takenAt);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}>
        <View style={{
          backgroundColor: tc.background,
          borderTopLeftRadius: 20,
          borderTopRightRadius: 20,
          padding: 16,
          paddingBottom: 30,
        }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 16, fontWeight: '800', color: tc.textPrimary }}>Log caffeine</Text>
              <Text style={{ marginTop: 2, fontSize: 12, color: tc.textMuted }} numberOfLines={1}>
                {item.custom_name || item.ingredient_name || 'Caffeine'}
              </Text>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={22} color={tc.textSecondary} />
            </TouchableOpacity>
          </View>

          <View style={{ flexDirection: 'row', gap: 10 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 11, fontWeight: '800', color: tc.textMuted, marginBottom: 6, textTransform: 'uppercase' }}>
                Amount
              </Text>
              <View style={{
                flexDirection: 'row',
                alignItems: 'center',
                borderWidth: 1,
                borderColor: tc.border,
                borderRadius: 10,
                backgroundColor: tc.surface,
                paddingHorizontal: 12,
              }}>
                <TextInput
                  value={amount}
                  onChangeText={setAmount}
                  keyboardType="numeric"
                  placeholder="200"
                  placeholderTextColor={tc.textMuted}
                  style={{ flex: 1, color: tc.textPrimary, fontSize: 16, paddingVertical: 12, ...INPUT_TEXT_RESET }}
                />
                <Text style={{ color: tc.textMuted, fontSize: 13, fontWeight: '700' }}>{unit}</Text>
              </View>
            </View>

            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 11, fontWeight: '800', color: tc.textMuted, marginBottom: 6, textTransform: 'uppercase' }}>
                Time
              </Text>
              <TextInput
                value={time}
                onChangeText={setTime}
                placeholder="08:30"
                placeholderTextColor={tc.textMuted}
                autoCapitalize="none"
                style={{
                  borderWidth: 1,
                  borderColor: tc.border,
                  borderRadius: 10,
                  backgroundColor: tc.surface,
                  color: tc.textPrimary,
                  fontSize: 16,
                  paddingHorizontal: 12,
                  paddingVertical: 12,
                  ...INPUT_TEXT_RESET,
                }}
              />
            </View>
          </View>

          <TouchableOpacity
            testID="caffeine-log-save"
            accessibilityLabel="caffeine-log-save"
            onPress={handleSave}
            disabled={saving}
            style={{
              marginTop: 16,
              backgroundColor: tc.primary,
              borderRadius: 12,
              paddingVertical: 13,
              alignItems: 'center',
              opacity: saving ? 0.65 : 1,
            }}
          >
            {saving ? (
              <ActivityIndicator size="small" color={getContrastingTextColor(tc.primary)} />
            ) : (
              <Text style={{ fontSize: 14, fontWeight: '900', color: getContrastingTextColor(tc.primary) }}>
                Save caffeine
              </Text>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}


// ─── Add supplement modal ──────────────────────────────────────────────────

function AddSupplementModal({
  visible, ingredients, ingredientsLoading, initialIngredient, authToken, onClose, onAdd, onAddMany, themeName, userProfile,
}: {
  visible: boolean;
  ingredients: api.SupplementIngredient[];
  ingredientsLoading: boolean;
  initialIngredient?: api.SupplementIngredient | null;
  authToken: string;
  onClose: () => void;
  onAdd: (body: any) => void | Promise<void>;
  onAddMany?: (bodies: any[]) => void | Promise<void>;
  themeName?: AppThemeName;
  userProfile: UserProfile;
}) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const isProTier = tierOf(userProfile) === 'pro';
  const [selected, setSelected] = useState<api.SupplementIngredient | null>(null);
  const [customName, setCustomName] = useState('');
  const [dose, setDose] = useState('');
  const [unit, setUnit] = useState('mg');
  const [freq, setFreq] = useState<'daily' | 'weekdays' | 'as_needed' | 'pre_workout'>('daily');
  const [timing, setTiming] = useState<SupplementTiming | ''>('');
  // Free-text user-defined group. When set, overrides `timing` for the
  // grouped Today view + the "take group" action. e.g. "Stack 1",
  // "Travel pack", "Race day".
  const [groupLabel, setGroupLabel] = useState<string>('');
  const [scanHint, setScanHint] = useState<string | null>(null);
  // Multi-scan review list. Populated by handleScanMultiple; cleared
  // when user taps "Add all" or cancels. Each item is editable inline.
  const [multiReview, setMultiReview] = useState<api.ScannedSupplement[] | null>(null);
  const [multiLoading, setMultiLoading] = useState(false);
  // AI text search — keyword → lookupSupplement. Lightweight wrapper
  // around the existing `/ai/supplement-lookup` endpoint so users can
  // type "ashwagandha" and get dose + evidence without a photo.
  const [aiSearch, setAiSearch] = useState('');
  const [aiSearching, setAiSearching] = useState(false);
  const [aiMeta, setAiMeta] = useState<{
    description?: string | null;
    evidence_tier?: 'strong' | 'moderate' | 'limited' | 'weak' | null;
    effectiveness_confidence?: EffectivenessConfidence | null;
    timing_notes?: string | null;
    safety_notes?: string | null;
    category?: string | null;
    common_uses?: string[] | null;
    deficiency_risks?: string[] | null;
    excess_risks?: string[] | null;
    food_sources?: string[] | null;
  } | null>(null);

  useEffect(() => {
    if (!visible) {
      setSelected(null); setCustomName(''); setDose(''); setUnit('mg');
      setFreq('daily'); setTiming(''); setGroupLabel('');
      setScanHint(null);
      setMultiReview(null); setMultiLoading(false);
      setAiSearch(''); setAiSearching(false);
      setAiMeta(null);
    }
  }, [visible]);

  useEffect(() => {
    if (!visible || !initialIngredient) return;
    setSelected(initialIngredient);
    setCustomName('');
    setUnit(initialIngredient.default_unit || 'mg');
    setAiMeta(null);
    setScanHint(null);
  }, [visible, initialIngredient]);

  /** Tries to match a scanned supplement name back to a seeded
   *  ingredient (e.g. "Vitamin D3 1000 IU" → vitamin_d3). */
  const _fuzzyMatchIngredient = (name: string): api.SupplementIngredient | null => {
    const n = name.toLowerCase();
    for (const ing of ingredients) {
      const ingN = ing.name.toLowerCase();
      if (n.includes(ingN) || ingN.includes(n)) return ing;
      // Also match token-level (e.g. "D3" in "Vitamin D3").
      const tokens = ingN.split(/\s+/);
      if (tokens.some(t => t.length >= 3 && n.includes(t))) return ing;
    }
    return null;
  };

  /** Parses a dose string like "1000 IU" or "5 g" into amount + unit. */
  const _parseDose = (doseStr?: string): { amount?: number; unit?: string } => {
    if (!doseStr) return {};
    const m = doseStr.match(/(\d+(?:\.\d+)?)\s*([a-zA-Z]+)/);
    if (!m) return {};
    return { amount: parseFloat(m[1]), unit: m[2].toLowerCase() };
  };

  /** Multi-scan — user snaps a photo of several bottles at once.
   *  AI returns a list → we open a review sheet with each item
   *  pre-filled, inline editable, and individually removable. */
  const handleScanMultiple = async () => {
    if (!requirePro(userProfile, 'ai_supplement_scan')) return;
    try {
      setScanHint(null);
      const ImagePicker = await import('expo-image-picker');
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Camera permission needed', 'Enable camera access in Settings to scan.');
        return;
      }
      // Quality 0.35 keeps text readable for the AI label scan while
      // shrinking the base64 payload from ~3-5MB to ~700KB-1MB. The
      // larger payloads were the main cause of the post-scan freeze
      // — slow upload over cellular plus a 30s default request
      // timeout meant the UI sat on the spinner past the timeout.
      const result = await ImagePicker.launchCameraAsync({
        base64: true, quality: 0.35,
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
      });
      if (result.canceled || !result.assets?.[0]?.base64) return;
      setMultiLoading(true);
      const apiMod = await import('../services/api');
      const res = await apiMod.scanSupplementsMulti(authToken, {
        image_base64: result.assets[0].base64,
        mime_type: 'image/jpeg',
      });
      if (!res.supplements || res.supplements.length === 0) {
        setScanHint("Couldn't identify any supplements. Try better lighting or a clearer angle, or add one at a time.");
        return;
      }
      setMultiReview(res.supplements);
    } catch (e: any) {
      setScanHint(`Scan failed: ${String(e?.message ?? e)}`);
    } finally {
      setMultiLoading(false);
    }
  };

  /** AI text search — user types a name (e.g. "ashwagandha") and we
   *  call /ai/supplement-lookup to fill in the form. Friendly for
   *  supplements outside the seeded catalog. */
  const handleAiSearch = async () => {
    const q = aiSearch.trim();
    if (!q) return;
    if (!requirePro(userProfile, 'ai_supplement_lookup')) return;
    try {
      setAiSearching(true);
      const apiMod = await import('../services/api');
      const res = await apiMod.lookupSupplement(authToken, q);
      if (!res.found) {
        setScanHint(`AI didn't recognize "${q}". You can still type it in as a custom supplement.`);
        setCustomName(q);
        setSelected(null);
        setAiMeta(null);
        return;
      }
      const evidence = res.evidence ?? 'limited';
      const confidence = res.effectivenessConfidence ?? confidenceFromEvidence(evidence);
      setAiMeta({
        description: res.whatItDoes ?? res.tagline ?? null,
        evidence_tier: evidence,
        effectiveness_confidence: confidence,
        timing_notes: res.timing ?? null,
        safety_notes: res.cautions ?? null,
        category: res.category ?? null,
        common_uses: res.commonUses ?? null,
        deficiency_risks: res.deficiencyRisks ?? null,
        excess_risks: res.excessRisks ?? null,
        food_sources: res.foodSources ?? null,
      });
      const matched = _fuzzyMatchIngredient(res.name);
      if (matched) {
        setSelected(matched);
        setUnit(matched.default_unit);
      } else {
        setCustomName(res.name);
        setSelected(null);
      }
      const parsed = _parseDose(res.dose);
      if (parsed.amount) setDose(String(parsed.amount));
      if (parsed.unit) setUnit(parsed.unit);
      setScanHint(`Found "${res.name}"${res.dose ? ` — typical dose ${res.dose}` : ''}. Double-check before saving.`);
    } catch (e: any) {
      setScanHint(`AI search failed: ${String(e?.message ?? e)}`);
    } finally {
      setAiSearching(false);
    }
  };

  const handleSave = () => {
    if (!dose || !parseFloat(dose)) {
      Alert.alert('Dose required', 'Enter a dose amount (e.g. 5 for 5g creatine).');
      return;
    }
    onAdd({
      supplement_ingredient_id: selected?.id,
      custom_name: selected?.name || customName || 'Custom supplement',
      dose_amount: parseFloat(dose),
      dose_unit: unit,
      frequency: freq,
      timing: timing || null,
      group_label: groupLabel.trim() || null,
      category: selected?.category ?? aiMeta?.category,
      description: aiMeta?.description,
      evidence_tier: aiMeta?.evidence_tier,
      effectiveness_confidence: aiMeta?.effectiveness_confidence,
      timing_notes: aiMeta?.timing_notes,
      safety_notes: aiMeta?.safety_notes,
      common_uses: aiMeta?.common_uses,
      deficiency_risks: aiMeta?.deficiency_risks,
      excess_risks: aiMeta?.excess_risks,
      food_sources: aiMeta?.food_sources,
    });
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}>
        <View testID="supplement-add-modal" style={{
          backgroundColor: tc.background, borderTopLeftRadius: 20, borderTopRightRadius: 20,
          padding: 16, paddingBottom: 30, maxHeight: '85%',
        }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <Text style={{ fontSize: 16, fontWeight: '800', color: tc.textPrimary }}>Add supplement</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={22} color={tc.textSecondary} />
            </TouchableOpacity>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled">
            {/* Quick-add actions — photo group scan or AI text search.
                Supplements do not yet have a food-style barcode lookup,
                so the old single-label scan button is intentionally gone.
                Users who prefer manual entry can ignore both
                and scroll straight to the ingredient chips below. */}
            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10 }}>
              <TouchableOpacity
                onPress={handleScanMultiple}
                disabled={multiLoading || !onAddMany}
                style={{
                  flex: 1, paddingVertical: 10, paddingHorizontal: 8,
                  backgroundColor: multiLoading ? tc.surfaceRaised : tc.primary + '1A',
                  borderWidth: 1, borderColor: tc.primary + '55',
                  borderRadius: 10,
                  flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
                }}
              >
                {multiLoading ? (
                  <ActivityIndicator size="small" color={tc.primary} />
                ) : (
                  <Ionicons name="images-outline" size={16} color={tc.primary} />
                )}
                <Text style={{ fontSize: 12, fontWeight: '700', color: tc.primary }}>
                  {isProTier ? 'Scan bottles' : 'Scan bottles (Pro)'}
                </Text>
              </TouchableOpacity>
            </View>
            {/* AI search — type a name, get pre-filled form. */}
            <View style={{ flexDirection: 'row', gap: 6, marginBottom: 12 }}>
              <TextInput
                testID="supplement-ai-search-input"
                value={aiSearch}
                onChangeText={setAiSearch}
                placeholder={isProTier ? "Or search AI: 'ashwagandha', 'ZMA'…" : "AI supplement search (Pro)"}
                placeholderTextColor={tc.textMuted}
                onSubmitEditing={handleAiSearch}
                returnKeyType="search"
                style={{
                  flex: 1,
                  backgroundColor: tc.surface, borderWidth: 1, borderColor: tc.border,
                  borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9,
                  color: tc.textPrimary, fontSize: 13,
                  ...INPUT_TEXT_RESET,
                }}
              />
              <TouchableOpacity
                testID="supplement-ai-search-submit"
                accessibilityLabel="supplement-ai-search-submit"
                onPress={handleAiSearch}
                disabled={aiSearching || !aiSearch.trim()}
                style={{
                  paddingVertical: 9, paddingHorizontal: 14,
                  backgroundColor: aiSearching || !aiSearch.trim() ? tc.surface : tc.primary,
                  borderRadius: 10, alignItems: 'center', justifyContent: 'center',
                  borderWidth: 1, borderColor: aiSearching || !aiSearch.trim() ? tc.border : tc.primary,
                }}
              >
                {aiSearching ? (
                  <ActivityIndicator size="small" color={tc.textMuted} />
                ) : (
                  <Ionicons
                    name="sparkles"
                    size={16}
                    color={aiSearch.trim() ? getContrastingTextColor(tc.primary) : tc.textMuted}
                  />
                )}
              </TouchableOpacity>
            </View>
            {scanHint && (
              <Text style={{
                fontSize: 11,
                color: scanHint.startsWith('Scan failed') || scanHint.startsWith("Couldn't") ? tc.warning : tc.textSecondary,
                marginBottom: 10,
                lineHeight: 15,
              }}>
                {scanHint}
              </Text>
            )}
            <Text style={{ fontSize: 11, fontWeight: '700', color: tc.textMuted, marginBottom: 6, letterSpacing: 0.5 }}>
              COMMON SUPPLEMENTS
            </Text>
            {ingredientsLoading && ingredients.length === 0 && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <ActivityIndicator size="small" color={tc.primary} />
                <Text style={{ fontSize: 11, color: tc.textMuted }}>Loading common supplements…</Text>
              </View>
            )}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
              {ingredients.map(ing => {
                const active = selected?.id === ing.id;
                return (
                  <TouchableOpacity
                    key={ing.id}
                    testID={`supplement-ingredient-${e2eId(ing.name)}`}
                    accessibilityLabel={`supplement-ingredient-${e2eId(ing.name)}`}
                    onPress={() => {
                      setSelected(ing);
                      setUnit(ing.default_unit);
                      setAiMeta(null);
                    }}
                    style={{
                      backgroundColor: active ? tc.primary : tc.surface,
                      borderWidth: 1,
                      borderColor: active ? tc.primary : tc.border,
                      borderRadius: 14, paddingVertical: 6, paddingHorizontal: 10,
                    }}
                  >
                    <Text style={{
                      fontSize: 12, fontWeight: '700',
                      color: active ? getContrastingTextColor(tc.primary) : tc.textPrimary,
                    }}>{ing.name}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {selected && selected.description && (
              <View style={{ backgroundColor: tc.surfaceRaised, borderRadius: 10, padding: 10, marginBottom: 12 }}>
                <Text style={{ fontSize: 11, color: tc.textSecondary, lineHeight: 15 }}>{selected.description}</Text>
              </View>
            )}
            {!selected && aiMeta?.description && (
              <View style={{ backgroundColor: tc.surfaceRaised, borderRadius: 10, padding: 10, marginBottom: 12 }}>
                <Text style={{ fontSize: 11, color: tc.textSecondary, lineHeight: 15 }}>{aiMeta.description}</Text>
                {aiMeta.effectiveness_confidence && (
                  <View style={{ marginTop: 7 }}>
                    <Pill
                      label={`${aiMeta.effectiveness_confidence.toUpperCase()} CONFIDENCE`}
                      color={confidenceColor(tc, aiMeta.effectiveness_confidence)}
                    />
                  </View>
                )}
              </View>
            )}

            {!selected && (
              <>
                <Text style={{ fontSize: 11, fontWeight: '700', color: tc.textMuted, marginBottom: 6, letterSpacing: 0.5 }}>
                  OR CUSTOM NAME
                </Text>
                <TextInput
                  testID="supplement-custom-name-input"
                  value={customName}
                  onChangeText={setCustomName}
                  placeholder="e.g. Brand X Electrolyte Mix"
                  placeholderTextColor={tc.textMuted}
                  style={{
                    backgroundColor: tc.surface, borderWidth: 1, borderColor: tc.border,
                    borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10,
                    color: tc.textPrimary, fontSize: 13, marginBottom: 12,
                    ...INPUT_TEXT_RESET,
                  }}
                />
              </>
            )}

            <Text style={{ fontSize: 11, fontWeight: '700', color: tc.textMuted, marginBottom: 6, letterSpacing: 0.5 }}>
              DOSE
            </Text>
            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
              <TextInput
                testID="supplement-dose-input"
                value={dose}
                onChangeText={setDose}
                placeholder="Amount"
                placeholderTextColor={tc.textMuted}
                keyboardType="decimal-pad"
                style={{
                  flex: 2,
                  backgroundColor: tc.surface, borderWidth: 1, borderColor: tc.border,
                  borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10,
                  color: tc.textPrimary, fontSize: 13,
                  ...INPUT_TEXT_RESET,
                }}
              />
              <TextInput
                testID="supplement-unit-input"
                value={unit}
                onChangeText={setUnit}
                placeholder="unit"
                placeholderTextColor={tc.textMuted}
                style={{
                  flex: 1,
                  backgroundColor: tc.surface, borderWidth: 1, borderColor: tc.border,
                  borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10,
                  color: tc.textPrimary, fontSize: 13,
                  ...INPUT_TEXT_RESET,
                }}
              />
            </View>

            <Text style={{ fontSize: 11, fontWeight: '700', color: tc.textMuted, marginBottom: 6, letterSpacing: 0.5 }}>
              FREQUENCY
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
              {(['daily', 'weekdays', 'pre_workout', 'as_needed'] as const).map(f => {
                const active = freq === f;
                return (
                  <TouchableOpacity
                    key={f}
                    testID={`supplement-frequency-${f}`}
                    accessibilityLabel={`supplement-frequency-${f}`}
                    onPress={() => setFreq(f)}
                    style={{
                      backgroundColor: active ? tc.primary : tc.surface,
                      borderWidth: 1, borderColor: active ? tc.primary : tc.border,
                      borderRadius: 14, paddingVertical: 6, paddingHorizontal: 10,
                    }}
                  >
                    <Text style={{
                      fontSize: 11, fontWeight: '700',
                      color: active ? getContrastingTextColor(tc.primary) : tc.textSecondary,
                    }}>{f.replace(/_/g, ' ')}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <Text style={{ fontSize: 11, fontWeight: '700', color: tc.textMuted, marginBottom: 4, letterSpacing: 0.5 }}>
              TIMING / GROUP
            </Text>
            <Text style={{ fontSize: 11, color: tc.textMuted, marginBottom: 8, lineHeight: 15 }}>
              Items in the same bucket appear together on Today with a single "Take all" button.
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 16 }}>
              {(['morning', 'pre_workout', 'post_workout', 'with_meal', 'evening', 'bedtime'] as const).map(t => {
                const active = timing === t;
                return (
                  <TouchableOpacity
                    key={t}
                    testID={`supplement-timing-${t}`}
                    accessibilityLabel={`supplement-timing-${t}`}
                    onPress={() => setTiming(active ? '' : t)}
                    style={{
                      backgroundColor: active ? tc.primary : tc.surface,
                      borderWidth: 1, borderColor: active ? tc.primary : tc.border,
                      borderRadius: 14, paddingVertical: 6, paddingHorizontal: 10,
                    }}
                  >
                    <Text style={{
                      fontSize: 11, fontWeight: '700',
                      color: active ? getContrastingTextColor(tc.primary) : tc.textSecondary,
                    }}>{t.replace(/_/g, ' ')}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Custom group — overrides the timing bucket on the Today
                tab so users can name their own packs ("Stack 1",
                "Travel pack") and tap-to-take the whole group at once. */}
            <Text style={{ fontSize: 11, fontWeight: '700', color: tc.textMuted, marginBottom: 6, letterSpacing: 0.5 }}>
              CUSTOM BATCH NAME (OPTIONAL)
            </Text>
            <TextInput
              testID="supplement-group-label-input"
              value={groupLabel}
              onChangeText={setGroupLabel}
              placeholder="e.g. Stack 1, Travel pack, Race day"
              placeholderTextColor={tc.textMuted}
              maxLength={40}
              style={{
                backgroundColor: tc.surface,
                borderWidth: 1, borderColor: tc.border,
                borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12,
                color: tc.textPrimary, fontSize: 14, marginBottom: 6,
                ...INPUT_TEXT_RESET,
              }}
            />
            <Text style={{ fontSize: 10, color: tc.textMuted, marginBottom: 16 }}>
              Only needed if you want a custom name (overrides the bucket above). Most users can leave this blank.
            </Text>

            <TouchableOpacity
              testID="supplement-add-submit"
              accessibilityLabel="supplement-add-submit"
              onPress={handleSave}
              style={{
                backgroundColor: tc.primary, paddingVertical: 12, borderRadius: 10,
                alignItems: 'center',
              }}
            >
              <Text style={{ color: getContrastingTextColor(tc.primary), fontWeight: '800', fontSize: 14 }}>Add to stack</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </View>
      {/* Multi-scan review sheet — surfaces the AI-detected list so
          the user can correct names/doses and remove false positives
          before bulk-adding. */}
      <MultiScanReviewSheet
        visible={multiReview !== null}
        items={multiReview || []}
        themeName={themeName}
        onClose={() => setMultiReview(null)}
        onAddAll={async (finalItems) => {
          if (!onAddMany) return;
          const bodies = finalItems.map(it => ({
            custom_name: it.name,
            category: it.category,
            dose_amount: it.dose_amount || 0,
            dose_unit: it.dose_unit || 'mg',
            frequency: 'daily',
            description: it.description,
            evidence_tier: it.evidence_tier,
            effectiveness_confidence: it.effectiveness_confidence,
            risk_tier: it.risk_tier,
            common_uses: it.common_uses,
            deficiency_risks: it.deficiency_risks,
            excess_risks: it.excess_risks,
            food_sources: it.food_sources,
            source_terms: it.source_terms,
            timing_notes: it.timing_notes,
            safety_notes: it.safety_notes,
            nutrient_content: it.nutrient_content,
          }));
          await onAddMany(bodies);
          setMultiReview(null);
        }}
      />
    </Modal>
  );
}


// ─── Multi-scan review sheet ──────────────────────────────────────────

function MultiScanReviewSheet({
  visible, items, themeName, onClose, onAddAll,
}: {
  visible: boolean;
  items: api.ScannedSupplement[];
  themeName?: AppThemeName;
  onClose: () => void;
  onAddAll: (finalItems: api.ScannedSupplement[]) => void | Promise<void>;
}) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const [review, setReview] = useState<api.ScannedSupplement[]>([]);

  useEffect(() => { setReview(items); }, [items]);

  const updateAt = (i: number, patch: Partial<api.ScannedSupplement>) => {
    setReview(prev => prev.map((it, idx) => idx === i ? { ...it, ...patch } : it));
  };
  const removeAt = (i: number) => {
    setReview(prev => prev.filter((_, idx) => idx !== i));
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' }}>
        <View style={{
          backgroundColor: tc.background, borderTopLeftRadius: 20, borderTopRightRadius: 20,
          padding: 16, paddingBottom: 30, maxHeight: '88%',
        }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <Text style={{ fontSize: 16, fontWeight: '800', color: tc.textPrimary }}>
              Detected {review.length} supplement{review.length === 1 ? '' : 's'}
            </Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={22} color={tc.textSecondary} />
            </TouchableOpacity>
          </View>
          <Text style={{ fontSize: 11, color: tc.textMuted, marginBottom: 12, lineHeight: 15 }}>
            Double-check names and doses — AI guesses aren't always exact. Swipe or tap the × to remove any it got wrong.
          </Text>

          <ScrollView style={{ flexGrow: 0 }}>
            {review.length === 0 ? (
              <View style={{ padding: 20, alignItems: 'center' }}>
                <Text style={{ fontSize: 12, color: tc.textMuted }}>All items removed.</Text>
              </View>
            ) : review.map((it, i) => (
              <View key={`${i}-${it.name}`} style={{
                backgroundColor: tc.surface, borderRadius: 12, padding: 12, marginBottom: 8,
                borderWidth: 1, borderColor: tc.border,
              }}>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginBottom: 8 }}>
                  <SupplementSourceImage item={{ custom_name: it.name, category: it.category, source_terms: it.source_terms, food_sources: it.food_sources }} tc={tc} height={66} width={58} />
                  <View style={{ flex: 1, gap: 8 }}>
                    <TextInput
                      value={it.name}
                      onChangeText={(t) => updateAt(i, { name: t })}
                      placeholder="Supplement name"
                      placeholderTextColor={tc.textMuted}
                      style={{
                        backgroundColor: tc.surfaceRaised, borderRadius: 8,
                        paddingHorizontal: 10, paddingVertical: 7,
                        color: tc.textPrimary, fontSize: 13, fontWeight: '700',
                        letterSpacing: 0,
                      }}
                    />
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                      <TextInput
                        value={it.dose_amount != null ? String(it.dose_amount) : ''}
                        onChangeText={(t) => updateAt(i, { dose_amount: parseFloat(t) || 0 })}
                        placeholder="Dose"
                        placeholderTextColor={tc.textMuted}
                        keyboardType="decimal-pad"
                        style={{
                          flex: 2,
                          backgroundColor: tc.surfaceRaised, borderRadius: 8,
                          paddingHorizontal: 10, paddingVertical: 7,
                          color: tc.textPrimary, fontSize: 12,
                          ...INPUT_TEXT_RESET,
                        }}
                      />
                      <TextInput
                        value={it.dose_unit}
                        onChangeText={(t) => updateAt(i, { dose_unit: t })}
                        placeholder="unit"
                        placeholderTextColor={tc.textMuted}
                        style={{
                          flex: 1,
                          backgroundColor: tc.surfaceRaised, borderRadius: 8,
                          paddingHorizontal: 10, paddingVertical: 7,
                          color: tc.textPrimary, fontSize: 12,
                          ...INPUT_TEXT_RESET,
                        }}
                      />
                    </View>
                  </View>
                  <TouchableOpacity
                    onPress={() => removeAt(i)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    style={{
                      width: 28, height: 28, borderRadius: 14,
                      backgroundColor: tc.surfaceRaised,
                      alignItems: 'center', justifyContent: 'center',
                    }}
                  >
                    <Ionicons name="close" size={14} color={tc.textSecondary} />
                  </TouchableOpacity>
                </View>
                <View style={{ flexDirection: 'row', gap: 4, marginTop: 6 }}>
                  <Text style={{ fontSize: 10, color: tc.textMuted }}>
                    {it.category} · {it.effectiveness_confidence || confidenceFromEvidence(it.evidence_tier)} confidence · {it.evidence_tier} evidence · {it.risk_tier} risk
                  </Text>
                </View>
                {it.description && (
                  <Text style={{ fontSize: 10, color: tc.textSecondary, lineHeight: 14, marginTop: 5 }}>
                    {it.description}
                  </Text>
                )}
                {it.nutrient_content?.nutrients?.length ? (
                  <View style={{ marginTop: 8, borderTopWidth: 1, borderTopColor: tc.border, paddingTop: 7 }}>
                    <Text style={{ fontSize: 9, fontWeight: '800', color: tc.textMuted, letterSpacing: 0.4, marginBottom: 5 }}>
                      SUPPLEMENT FACTS · {it.nutrient_content.nutrients.length} NUTRIENT{it.nutrient_content.nutrients.length === 1 ? '' : 'S'}
                    </Text>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
                      {it.nutrient_content.nutrients.map((n, ni) => (
                        <View key={ni} style={{ backgroundColor: tc.surfaceRaised, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3 }}>
                          <Text style={{ fontSize: 10, color: tc.textSecondary }}>
                            {n.nutrient} {Math.round((n.amount || 0) * 100) / 100}{n.unit}
                          </Text>
                        </View>
                      ))}
                    </View>
                  </View>
                ) : null}
              </View>
            ))}
          </ScrollView>

          <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
            <TouchableOpacity
              onPress={onClose}
              style={{
                flex: 1, paddingVertical: 12, borderRadius: 10,
                alignItems: 'center',
                backgroundColor: tc.surface, borderWidth: 1, borderColor: tc.border,
              }}
            >
              <Text style={{ color: tc.textSecondary, fontWeight: '700', fontSize: 13 }}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => onAddAll(review.filter(r => (r.name || '').trim() && (r.dose_amount || 0) > 0))}
              disabled={review.length === 0}
              style={{
                flex: 2, paddingVertical: 12, borderRadius: 10,
                alignItems: 'center',
                backgroundColor: review.length === 0 ? tc.border : tc.primary,
              }}
            >
              <Text style={{ color: getContrastingTextColor(review.length === 0 ? tc.border : tc.primary), fontWeight: '800', fontSize: 13 }}>
                Add {review.length} to stack
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}
