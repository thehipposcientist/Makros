import type { ImageSourcePropType } from 'react-native';

type PexelsExtension = 'jpeg' | 'png';

type PexelsOptions = {
  extension?: PexelsExtension;
  width?: number;
  height?: number;
};

export function pexelsPhoto(id: string, options: PexelsOptions = {}) {
  const extension = options.extension ?? 'jpeg';
  const width = options.width ?? 900;
  const height = options.height ?? 540;
  return `https://images.pexels.com/photos/${id}/pexels-photo-${id}.${extension}?auto=compress&cs=tinysrgb&w=${width}&h=${height}&fit=crop`;
}

const SUPPLEMENT_SOURCE_ASSETS = {
  '10123049': require('../../assets/supplements/sources/10123049.jpg'),
  '10421049': require('../../assets/supplements/sources/10421049.jpg'),
  '10727027': require('../../assets/supplements/sources/10727027.jpg'),
  '10866144': require('../../assets/supplements/sources/10866144.jpg'),
  '1092730': require('../../assets/supplements/sources/1092730.jpg'),
  '11178470': require('../../assets/supplements/sources/11178470.jpg'),
  '11178478': require('../../assets/supplements/sources/11178478.jpg'),
  '11199366': require('../../assets/supplements/sources/11199366.jpg'),
  '11679219': require('../../assets/supplements/sources/11679219.jpg'),
  '11868780': require('../../assets/supplements/sources/11868780.jpg'),
  '1261728': require('../../assets/supplements/sources/1261728.jpg'),
  '128756': require('../../assets/supplements/sources/128756.jpg'),
  '12984540': require('../../assets/supplements/sources/12984540.jpg'),
  '13013778': require('../../assets/supplements/sources/13013778.jpg'),
  '1313267': require('../../assets/supplements/sources/1313267.jpg'),
  '1337825': require('../../assets/supplements/sources/1337825.jpg'),
  '13779110': require('../../assets/supplements/sources/13779110.jpg'),
  '13788116': require('../../assets/supplements/sources/13788116.jpg'),
  '14542171': require('../../assets/supplements/sources/14542171.jpg'),
  '15532964': require('../../assets/supplements/sources/15532964.jpg'),
  '16381140': require('../../assets/supplements/sources/16381140.jpg'),
  '16682100': require('../../assets/supplements/sources/16682100.jpg'),
  '16748187': require('../../assets/supplements/sources/16748187.jpg'),
  '16768137': require('../../assets/supplements/sources/16768137.jpg'),
  '1695052': require('../../assets/supplements/sources/1695052.jpg'),
  '1716001': require('../../assets/supplements/sources/1716001.jpg'),
  '17249985': require('../../assets/supplements/sources/17249985.jpg'),
  '17380332': require('../../assets/supplements/sources/17380332.jpg'),
  '17592733': require('../../assets/supplements/sources/17592733.jpg'),
  '17820707': require('../../assets/supplements/sources/17820707.jpg'),
  '17820731': require('../../assets/supplements/sources/17820731.jpg'),
  '18014999': require('../../assets/supplements/sources/18014999.jpg'),
  '18275947': require('../../assets/supplements/sources/18275947.jpg'),
  '18333898': require('../../assets/supplements/sources/18333898.jpg'),
  '19141522': require('../../assets/supplements/sources/19141522.jpg'),
  '19768979': require('../../assets/supplements/sources/19768979.jpg'),
  '20062650': require('../../assets/supplements/sources/20062650.jpg'),
  '2014775': require('../../assets/supplements/sources/2014775.jpg'),
  '20233144': require('../../assets/supplements/sources/20233144.jpg'),
  '20234958': require('../../assets/supplements/sources/20234958.jpg'),
  '20234970': require('../../assets/supplements/sources/20234970.jpg'),
  '208518': require('../../assets/supplements/sources/208518.jpg'),
  '2198626': require('../../assets/supplements/sources/2198626.jpg'),
  '22020984': require('../../assets/supplements/sources/22020984.jpg'),
  '2288683': require('../../assets/supplements/sources/2288683.jpg'),
  '2288692': require('../../assets/supplements/sources/2288692.jpg'),
  '2290078': require('../../assets/supplements/sources/2290078.jpg'),
  '2347447': require('../../assets/supplements/sources/2347447.jpg'),
  '25397899': require('../../assets/supplements/sources/25397899.jpg'),
  '260426': require('../../assets/supplements/sources/260426.jpg'),
  '27580157': require('../../assets/supplements/sources/27580157.jpg'),
  '28255124': require('../../assets/supplements/sources/28255124.jpg'),
  '28255125': require('../../assets/supplements/sources/28255125.jpg'),
  '299347': require('../../assets/supplements/sources/299347.jpg'),
  '301599': require('../../assets/supplements/sources/301599.jpg'),
  '30801724': require('../../assets/supplements/sources/30801724.jpg'),
  '31346461': require('../../assets/supplements/sources/31346461.jpg'),
  '3296279': require('../../assets/supplements/sources/3296279.jpg'),
  '33099040': require('../../assets/supplements/sources/33099040.jpg'),
  '33893317': require('../../assets/supplements/sources/33893317.jpg'),
  '340874': require('../../assets/supplements/sources/340874.jpg'),
  '34692627': require('../../assets/supplements/sources/34692627.jpg'),
  '36829381': require('../../assets/supplements/sources/36829381.jpg'),
  '3682192': require('../../assets/supplements/sources/3682192.jpg'),
  '3683074': require('../../assets/supplements/sources/3683074.jpg'),
  '4040573': require('../../assets/supplements/sources/4040573.jpg'),
  '4047077': require('../../assets/supplements/sources/4047077.jpg'),
  '4113306': require('../../assets/supplements/sources/4113306.jpg'),
  '4198015': require('../../assets/supplements/sources/4198015.jpg'),
  '4198023': require('../../assets/supplements/sources/4198023.jpg'),
  '4390014': require('../../assets/supplements/sources/4390014.jpg'),
  '4391986': require('../../assets/supplements/sources/4391986.jpg'),
  '463445': require('../../assets/supplements/sources/463445.jpg'),
  '4725735': require('../../assets/supplements/sources/4725735.jpg'),
  '4750266': require('../../assets/supplements/sources/4750266.jpg'),
  '5601517': require('../../assets/supplements/sources/5601517.jpg'),
  '566566': require('../../assets/supplements/sources/566566.jpg'),
  '5945967': require('../../assets/supplements/sources/5945967.jpg'),
  '6107721': require('../../assets/supplements/sources/6107721.jpg'),
  '6107722': require('../../assets/supplements/sources/6107722.jpg'),
  '6187593': require('../../assets/supplements/sources/6187593.jpg'),
  '6189293': require('../../assets/supplements/sources/6189293.jpg'),
  '6220710': require('../../assets/supplements/sources/6220710.jpg'),
  '6294296': require('../../assets/supplements/sources/6294296.jpg'),
  '6475115': require('../../assets/supplements/sources/6475115.jpg'),
  '6475116': require('../../assets/supplements/sources/6475116.jpg'),
  '669161': require('../../assets/supplements/sources/669161.jpg'),
  '669164': require('../../assets/supplements/sources/669164.jpg'),
  '6979973': require('../../assets/supplements/sources/6979973.jpg'),
  '7333136': require('../../assets/supplements/sources/7333136.jpg'),
  '7420867': require('../../assets/supplements/sources/7420867.jpg'),
  '768098': require('../../assets/supplements/sources/768098.jpg'),
  '7907597': require('../../assets/supplements/sources/7907597.jpg'),
  '7988019': require('../../assets/supplements/sources/7988019.jpg'),
  '8618970': require('../../assets/supplements/sources/8618970.jpg'),
  '8653041': require('../../assets/supplements/sources/8653041.jpg'),
  '8801171': require('../../assets/supplements/sources/8801171.jpg'),
  '8878503': require('../../assets/supplements/sources/8878503.jpg'),
  '894695': require('../../assets/supplements/sources/894695.jpg'),
  '8973375': require('../../assets/supplements/sources/8973375.jpg'),
  '912110': require('../../assets/supplements/sources/912110.jpg'),
  '942801': require('../../assets/supplements/sources/942801.jpg'),
  '9432701': require('../../assets/supplements/sources/9432701.jpg'),
  '9541976': require('../../assets/supplements/sources/9541976.jpg'),
  '9974504': require('../../assets/supplements/sources/9974504.jpg'),
} as const;

type SupplementSourceAssetId = keyof typeof SUPPLEMENT_SOURCE_ASSETS;

function supplementSourceAsset(id: SupplementSourceAssetId): ImageSourcePropType {
  return SUPPLEMENT_SOURCE_ASSETS[id];
}

function supplementSourceAssets(ids: SupplementSourceAssetId[]): ImageSourcePropType[] {
  return ids.map(supplementSourceAsset);
}

function pexelsPhotoSource(id: string, options: PexelsOptions = {}): ImageSourcePropType {
  return { uri: pexelsPhoto(id, options) };
}

export const STOCK_IMAGES = {
  gear: {
    hero: pexelsPhoto('6740822'),
    shoes: pexelsPhoto('6283383'),
    bike: pexelsPhoto('17774659'),
    strength: pexelsPhoto('35469930'),
    recovery: pexelsPhoto('4028197'),
    boxing: pexelsPhoto('6296121'),
    tools: pexelsPhoto('8032758'),
    fallback: pexelsPhoto('8154269'),
  },
  supplements: {
    hero: pexelsPhoto('15120889'),
    fallback: pexelsPhoto('13013778'),
  },
  imports: {
    hero: pexelsPhoto('35147278'),
    empty: pexelsPhoto('6373220'),
  },
  progress: {
    bodyMeasureFemale: require('../../assets/female-body-measure.jpg'),
    bodyMeasureMale: require('../../assets/male-body-measure.jpg'),
  },
  onboarding: {
    workoutStyle: pexelsPhoto('5878699'),
    setupPath: pexelsPhoto('32977239'),
    quickTraining: pexelsPhoto('13993018'),
    quickNutrition: pexelsPhoto('30635713'),
    equipment: pexelsPhoto('19025674'),
    equipmentScan: pexelsPhoto('3931367'),
    baseline: pexelsPhoto('19025673'),
    foodScan: pexelsPhoto('30635717'),
    supplements: pexelsPhoto('13013778'),
    health: pexelsPhoto('32977239'),
    appFocus: pexelsPhoto('32977239'),
  },
} as const;

export type SupplementSourceImage = {
  key: string;
  label: string;
  source: ImageSourcePropType;
  sources?: ImageSourcePropType[];
  aliases: string[];
};

export const SUPPLEMENT_SOURCE_IMAGES: SupplementSourceImage[] = [
  {
    key: 'spirulina',
    label: 'Spirulina',
    source: pexelsPhotoSource('13787643'),
    sources: [pexelsPhotoSource('13787643'), pexelsPhotoSource('5337681'), pexelsPhotoSource('12049996')],
    aliases: ['spirulina', 'spirulina algae', 'blue green algae', 'blue-green algae', 'chlorella', 'chlorophyll'],
  },
  {
    key: 'fish',
    label: 'Fish / seafood',
    source: supplementSourceAsset('14542171'),
    sources: supplementSourceAssets(['14542171', '20062650', '19768979', '3296279', '128756']),
    aliases: ['omega 3', 'omega3', 'fish oil', 'epa', 'dha', 'cod liver', 'krill', 'fish', 'salmon', 'seafood', 'fatty acid'],
  },
  {
    key: 'milk',
    label: 'Milk / dairy',
    source: supplementSourceAsset('17249985'),
    sources: supplementSourceAssets(['17249985', '9432701', '16748187', '12984540', '2198626', '7907597', '11679219', '18333898', '13788116', '2347447']),
    aliases: ['whey', 'casein', 'milk protein', 'milk', 'dairy', 'lactose', 'cow', 'colostrum'],
  },
  {
    key: 'yogurt',
    label: 'Yogurt / probiotics',
    source: supplementSourceAsset('10421049'),
    sources: supplementSourceAssets(['10421049', '17249985', '9432701']),
    aliases: ['probiotic', 'probiotics', 'lactobacillus', 'bifidobacterium', 'cfu', 'yogurt', 'kefir', 'gut health'],
  },
  {
    key: 'egg',
    label: 'Egg',
    source: supplementSourceAsset('7333136'),
    sources: supplementSourceAssets(['7333136', '6979973', '6294296', '566566']),
    aliases: ['egg', 'eggs', 'egg protein', 'albumin', 'ovalbumin'],
  },
  {
    key: 'chicken',
    label: 'Chicken',
    source: supplementSourceAsset('15532964'),
    sources: supplementSourceAssets(['15532964', '6107722', '6107721']),
    aliases: ['chicken', 'poultry', 'turkey', 'chicken protein', 'bone broth chicken', 'beta alanine', 'beta-alanine', 'carnosine'],
  },
  {
    key: 'beef',
    label: 'Beef',
    source: supplementSourceAsset('9541976'),
    sources: supplementSourceAssets(['9541976', '18014999', '299347', '36829381']),
    aliases: ['beef', 'red meat', 'bovine', 'beef protein', 'desiccated liver', 'liver extract'],
  },
  {
    key: 'pea',
    label: 'Pea / plant protein',
    source: supplementSourceAsset('8878503'),
    sources: supplementSourceAssets(['8878503', '4750266', '768098', '8801171', '6187593']),
    aliases: ['plant protein', 'pea protein', 'soy protein', 'rice protein', 'hemp protein', 'vegan protein', 'plant based protein', 'legume', 'legumes'],
  },
  {
    key: 'fenugreek',
    label: 'Fenugreek',
    source: pexelsPhotoSource('27867128'),
    sources: [pexelsPhotoSource('27867128'), pexelsPhotoSource('5987968')],
    aliases: ['fenugreek', 'trigonella', 'fenugreek seed', 'fenugreek seeds'],
  },
  {
    key: 'seed',
    label: 'Nuts / seeds',
    source: supplementSourceAsset('8653041'),
    sources: supplementSourceAssets(['8653041', '9974504', '6187593', '2290078', '18275947']),
    aliases: ['almond', 'almonds', 'nut', 'nuts', 'seed', 'seeds', 'pumpkin seed', 'flax', 'flaxseed', 'chia', 'hemp seed', 'sunflower seed'],
  },
  {
    key: 'fiber',
    label: 'Oats / fiber',
    source: supplementSourceAsset('4725735'),
    sources: supplementSourceAssets(['4725735', '10421049']),
    aliases: ['psyllium', 'fiber', 'fibre', 'soluble fiber', 'inulin', 'oat', 'oats', 'regularity', 'whole grain', 'whole grains'],
  },
  {
    key: 'vinegar',
    label: 'Apple cider vinegar',
    source: pexelsPhotoSource('5471920'),
    sources: [pexelsPhotoSource('5471920'), pexelsPhotoSource('35438467'), pexelsPhotoSource('14630305'), pexelsPhotoSource('5223214')],
    aliases: ['apple cider vinegar', 'apple vinegar', 'vinegar', 'acv'],
  },
  {
    key: 'coffee',
    label: 'Coffee',
    source: supplementSourceAsset('669161'),
    sources: supplementSourceAssets(['669161', '669164', '942801', '1695052', '894695']),
    aliases: ['caffeine', 'coffee', 'espresso', 'stimulant'],
  },
  {
    key: 'tea',
    label: 'Tea leaves',
    source: supplementSourceAsset('4390014'),
    sources: supplementSourceAssets(['4390014', '463445', '4391986']),
    aliases: ['green tea', 'egcg', 'theanine', 'l theanine', 'l-theanine', 'tea extract', 'tea'],
  },
  {
    key: 'cherry',
    label: 'Tart cherry',
    source: supplementSourceAsset('8973375'),
    sources: supplementSourceAssets(['8973375', '1092730']),
    aliases: ['tart cherry', 'cherry', 'anthocyanin', 'anthocyanins'],
  },
  {
    key: 'cranberry',
    label: 'Cranberry',
    source: supplementSourceAsset('7420867'),
    sources: supplementSourceAssets(['7420867', '10421049']),
    aliases: ['cranberry', 'cranberries', 'urinary tract', 'urinary'],
  },
  {
    key: 'watermelon',
    label: 'Watermelon',
    source: supplementSourceAsset('16682100'),
    sources: supplementSourceAssets(['16682100', '1337825', '1313267', '260426', '2288692']),
    aliases: ['citrulline', 'l citrulline', 'l-citrulline', 'citrulline malate', 'watermelon'],
  },
  {
    key: 'sunlight',
    label: 'Sunlight',
    source: supplementSourceAsset('11199366'),
    sources: supplementSourceAssets(['11199366', '2014775', '912110', '1261728', '301599']),
    aliases: ['vitamin d', 'vitamin d3', 'd3', 'cholecalciferol', 'sunlight', 'sunshine', 'sun exposure'],
  },
  {
    key: 'leafy',
    label: 'Leafy greens',
    source: supplementSourceAsset('5945967'),
    sources: supplementSourceAssets(['5945967', '3682192']),
    aliases: ['folate', 'folic acid', 'methylfolate', 'vitamin k', 'vitamin k2', 'k2', 'spinach', 'kale', 'leafy green', 'leafy greens'],
  },
  {
    key: 'banana',
    label: 'Banana / potassium',
    source: supplementSourceAsset('20233144'),
    sources: supplementSourceAssets(['20233144', '27580157']),
    aliases: ['potassium', 'banana', 'bananas'],
  },
  {
    key: 'avocado',
    label: 'Avocado',
    source: supplementSourceAsset('27580157'),
    sources: supplementSourceAssets(['27580157', '5945967']),
    aliases: ['vitamin e', 'tocopherol', 'avocado', 'healthy fat'],
  },
  {
    key: 'mushroom',
    label: 'Mushroom',
    source: supplementSourceAsset('5601517'),
    sources: supplementSourceAssets(['5601517', '340874', '1716001', '10123049']),
    aliases: ['mushroom', 'mushrooms', 'fungi', 'ergocalciferol', 'vitamin d2', 'd2', 'lion mane', "lion's mane", 'reishi', 'cordyceps'],
  },
  {
    key: 'beet',
    label: 'Beetroot',
    source: pexelsPhotoSource('29436276'),
    sources: [
      pexelsPhotoSource('29436276'),
      pexelsPhotoSource('4963554'),
      pexelsPhotoSource('5502849'),
      pexelsPhotoSource('29355934'),
      pexelsPhotoSource('29546374'),
      supplementSourceAsset('8618970'),
      pexelsPhotoSource('20517382'),
      supplementSourceAsset('25397899'),
      supplementSourceAsset('33893317'),
    ],
    aliases: ['beet', 'beets', 'beetroot', 'beet root', 'beet juice', 'nitrate', 'nitrates'],
  },
  {
    key: 'citrus',
    label: 'Citrus',
    source: supplementSourceAsset('28255125'),
    sources: supplementSourceAssets(['28255125', '10866144', '28255124', '2288683', '10727027']),
    aliases: ['vitamin c', 'ascorbic acid', 'citrus', 'orange', 'oranges', 'lemon', 'lemons'],
  },
  {
    key: 'cocoa',
    label: 'Cocoa',
    source: supplementSourceAsset('11178470'),
    sources: supplementSourceAssets(['11178470', '4113306', '11178478']),
    aliases: ['cocoa', 'cacao', 'dark chocolate', 'chocolate', 'flavanol', 'flavanols'],
  },
  {
    key: 'ginseng',
    label: 'Ginseng root',
    source: pexelsPhotoSource('16122309'),
    sources: [pexelsPhotoSource('16122309'), pexelsPhotoSource('4871365')],
    aliases: ['panax ginseng', 'ginseng', 'red ginseng', 'korean ginseng', 'ginseng root'],
  },
  {
    key: 'maca',
    label: 'Maca root',
    source: pexelsPhotoSource('16122309'),
    sources: [pexelsPhotoSource('16122309')],
    aliases: ['maca', 'maca root', 'black maca', 'black maca root', 'lepidium meyenii'],
  },
  {
    key: 'ashwagandha',
    label: 'Ashwagandha root',
    source: pexelsPhotoSource('16122309'),
    sources: [pexelsPhotoSource('16122309'), pexelsPhotoSource('4871365')],
    aliases: ['ashwagandha', 'ashwagandha root', 'withania somnifera'],
  },
  {
    key: 'saffron',
    label: 'Saffron',
    source: pexelsPhotoSource('33654800'),
    sources: [pexelsPhotoSource('33654800'), pexelsPhotoSource('10487658')],
    aliases: ['saffron', 'crocus', 'crocin', 'crocins', 'safranal'],
  },
  {
    key: 'tribulus',
    label: 'Tribulus',
    source: pexelsPhotoSource('36638498'),
    sources: [pexelsPhotoSource('36638498')],
    aliases: ['tribulus', 'tribulus terrestris', 'puncture vine', 'protodioscin'],
  },
  {
    key: 'barberry',
    label: 'Barberry',
    source: pexelsPhotoSource('5668188'),
    sources: [pexelsPhotoSource('5668188'), pexelsPhotoSource('19167320'), pexelsPhotoSource('15204915'), pexelsPhotoSource('5876243')],
    aliases: ['berberine', 'barberry', 'barberries', 'goldenseal', 'oregon grape', 'berberis'],
  },
  {
    key: 'root',
    label: 'Herbal root',
    source: pexelsPhotoSource('16122309'),
    sources: [pexelsPhotoSource('16122309'), pexelsPhotoSource('4871365')],
    aliases: ['tongkat', 'tongkat ali', 'long jack', 'eurycoma', 'eurycoma longifolia', 'malaysian ginseng', 'herbal root'],
  },
  {
    key: 'capsule',
    label: 'Capsules',
    source: supplementSourceAsset('13779110'),
    sources: supplementSourceAssets(['13779110', '17820731', '17820707', '22020984', '4040573', '208518', '3683074', '4047077']),
    aliases: ['capsule', 'capsules', 'pill', 'pills', 'multivitamin', 'vitamin', 'b12', 'zinc', 'magnesium', 'iron', 'calcium', 'mineral', 'electrolyte', 'electrolytes', 'zma', 'selenium', 'iodine', 'copper', 'boron', 'coq10', 'nac', 'melatonin', 'inositol'],
  },
  {
    key: 'herb',
    label: 'Herb / root',
    source: supplementSourceAsset('7988019'),
    sources: supplementSourceAssets(['7988019', '20234970', '20234958', '31346461', '6220710', '17380332']),
    aliases: ['rhodiola', 'turmeric', 'curcumin', 'ginger', 'adaptogen', 'herb', 'herbal', 'root', 'epimedium', 'horny goat weed', 'icariin', 'yin yang huo'],
  },
  {
    key: 'garlic',
    label: 'Garlic',
    source: supplementSourceAsset('18275947'),
    sources: supplementSourceAssets(['18275947']),
    aliases: ['garlic', 'allicin'],
  },
  {
    key: 'collagen',
    label: 'Broth / collagen',
    source: supplementSourceAsset('19141522'),
    sources: supplementSourceAssets(['19141522', '6475116', '6475115', '17592733', '16768137', '16381140', '6189293']),
    aliases: ['collagen', 'gelatin', 'peptide', 'peptides', 'bone broth', 'broth', 'marine collagen'],
  },
  {
    key: 'powder',
    label: 'Powder / supplement',
    source: supplementSourceAsset('13013778'),
    sources: supplementSourceAssets(['13013778', '17820731', '17820707', '6475116', '6475115']),
    aliases: ['creatine', 'beta alanine', 'beta-alanine', 'bcaa', 'eaa', 'glutamine', 'amino acid', 'taurine', 'glycine', 'hmb', 'sodium bicarbonate', 'baking soda', 'pre workout', 'pre-workout', 'performance', 'powder', 'protein powder', 'supplement'],
  },
];

function normalizeSupplementImageText(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function supplementImageTextList(value: unknown): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value.flatMap(supplementImageTextList);
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return [];
    if (text.startsWith('[')) {
      try {
        return supplementImageTextList(JSON.parse(text));
      } catch {
        return [text];
      }
    }
    return [text];
  }
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap(supplementImageTextList);
  }
  return [String(value)];
}

function normalizedSupplementImageTextIncludes(text: string, alias: string) {
  const normalizedText = ` ${normalizeSupplementImageText(text)} `;
  const normalizedAlias = normalizeSupplementImageText(alias);
  return Boolean(normalizedAlias) && normalizedText.includes(` ${normalizedAlias} `);
}

function supplementImageIndex(seed: string, count: number) {
  if (count <= 1) return 0;
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % count;
}

function selectSupplementSourceImage(source: SupplementSourceImage, seed: string): SupplementSourceImage {
  const sources = source.sources?.length ? source.sources : [source.source];
  return {
    ...source,
    source: sources[supplementImageIndex(seed || source.key, sources.length)] ?? source.source,
  };
}

export function supplementSourceImageFor(input: {
  name?: string | null;
  category?: string | null;
  slug?: string | null;
  sourceTerms?: Array<string | null | undefined> | null;
  foodSources?: Array<string | null | undefined> | null;
}): SupplementSourceImage {
  const identityText = normalizeSupplementImageText([
    input.slug,
    input.name,
  ].filter(Boolean).join(' '));
  const foodSources = supplementImageTextList(input.foodSources);
  const sourceText = normalizeSupplementImageText(supplementImageTextList(input.sourceTerms).join(' '));
  const categoryText = normalizeSupplementImageText(input.category ?? '');

  const findMatch = (text: string) => SUPPLEMENT_SOURCE_IMAGES.find((source) =>
    source.aliases.some((alias) => normalizedSupplementImageTextIncludes(text, alias))
  );
  const foodMatch = foodSources.reduce<SupplementSourceImage | undefined>((found, source) => (
    found ?? findMatch(normalizeSupplementImageText(String(source ?? '')))
  ), undefined);
  const match = findMatch(identityText) ?? foodMatch ?? findMatch(sourceText) ?? findMatch(categoryText);

  const seed = [
    identityText,
    ...foodSources.map(source => normalizeSupplementImageText(String(source ?? ''))),
    sourceText,
    categoryText,
  ].filter(Boolean).join(':');
  return selectSupplementSourceImage(match ?? SUPPLEMENT_SOURCE_IMAGES[SUPPLEMENT_SOURCE_IMAGES.length - 1], seed);
}

const GEAR_STOCK_IMAGE_BY_TYPE: Record<string, string> = {
  running_shoe: STOCK_IMAGES.gear.shoes,
  trail_shoe: STOCK_IMAGES.gear.shoes,
  cycling_shoe: STOCK_IMAGES.gear.shoes,
  bike: STOCK_IMAGES.gear.bike,
  stationary_bike: STOCK_IMAGES.gear.bike,
  bike_tire: STOCK_IMAGES.gear.bike,
  bike_chain: STOCK_IMAGES.gear.bike,
  treadmill_belt: STOCK_IMAGES.gear.shoes,
  jump_rope: STOCK_IMAGES.gear.tools,
  lifting_shoe: STOCK_IMAGES.gear.strength,
  lifting_belt: STOCK_IMAGES.gear.strength,
  knee_sleeves: STOCK_IMAGES.gear.strength,
  wrist_wraps: STOCK_IMAGES.gear.strength,
  lifting_straps: STOCK_IMAGES.gear.strength,
  chest_strap: STOCK_IMAGES.gear.shoes,
  yoga_mat: STOCK_IMAGES.gear.recovery,
  climbing_shoe: STOCK_IMAGES.gear.shoes,
  resistance_band: STOCK_IMAGES.gear.tools,
  foam_roller: STOCK_IMAGES.gear.recovery,
  massage_gun: STOCK_IMAGES.gear.recovery,
  boxing_gloves: STOCK_IMAGES.gear.boxing,
};

export function gearStockImageUri(gearType: string) {
  return GEAR_STOCK_IMAGE_BY_TYPE[gearType] ?? STOCK_IMAGES.gear.fallback;
}
