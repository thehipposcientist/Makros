export type AppThemeName =
  | 'midnight' | 'neon'    | 'ocean'   | 'forest'
  | 'ember'    | 'wine'    | 'obsidian'| 'amethyst'
  | 'citrus'   | 'flamingo'| 'cocoa'   | 'slate'
  | 'scarlet'  | 'sunrise' | 'arctic'  | 'rose'    | 'blossom'
  | 'parchment'| 'meadow'
  | 'void'     | 'dusk'    | 'steel'   | 'sand'    | 'lavender'
  | 'aurora'   | 'copper'  | 'storm'
  | 'linen'    | 'mint';

export interface ThemeColors {
  background: string;
  surface: string;
  surfaceRaised: string;
  border: string;
  primary: string;
  primaryDark: string;
  primaryLight: string;
  accent: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  error: string;
  warning: string;
  success: string;
}

export interface SectionPalette {
  soft: string;
  strong: string;
  text: string;
}

export interface AppTheme {
  name: AppThemeName;
  label: string;
  description: string;
  colors: ThemeColors;
  sections: {
    workout: SectionPalette;
    meals: SectionPalette;
    ai: SectionPalette;
    planner: SectionPalette;
    account: SectionPalette;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Section color philosophy:
//   Each theme's workout / meals / ai section palette reflects that theme's
//   actual color identity — not a shared blue/green/purple across all themes.
//   This makes each theme's swatch strip look visually unique.
// ─────────────────────────────────────────────────────────────────────────────
export const APP_THEMES: Record<AppThemeName, AppTheme> = {

  // ── DARK / COOL ──────────────────────────────────────────────────────────────

  midnight: {
    // UNCHANGED. Reference dark theme. Classic teal on pitch-black.
    name: 'midnight',
    label: 'Midnight Pulse',
    description: 'Pitch-black with teal primary — the clean dark default.',
    colors: {
      background:    '#0D0F14',
      surface:       '#161A22',
      surfaceRaised: '#1E2430',
      border:        '#2A3242',
      primary:       '#15C7B8',
      primaryDark:   '#0D9488',
      primaryLight:  '#6EE7DC',
      accent:        '#7CFCB2',
      textPrimary:   '#F5F7FB',
      textSecondary: '#A8B3C7',
      textMuted:     '#687388',
      error:         '#FF5D73',
      warning:       '#FFB454',
      success:       '#59D98E',
    },
    sections: {
      workout: { soft: '#0F1F38', strong: '#4A9EE8', text: '#9DC8F8' },
      meals:   { soft: '#0C2018', strong: '#35C46A', text: '#90E0B0' },
      ai:      { soft: '#1A1030', strong: '#8858E0', text: '#C0A0F8' },
      planner: { soft: '#231B37', strong: '#A78BFA', text: '#D2C5FF' },
      account: { soft: '#2B2317', strong: '#F59E0B', text: '#F8C978' },
    },
  },

  ocean: {
    // UNCHANGED. Navy bg, electric cyan — pure underwater palette.
    name: 'ocean',
    label: 'Deep Ocean',
    description: 'Inky navy with electric cyan — the entire palette lives underwater.',
    colors: {
      background:    '#040C18',
      surface:       '#081624',
      surfaceRaised: '#0E2030',
      border:        '#183248',
      primary:       '#00CCE8',
      primaryDark:   '#0098B0',
      primaryLight:  '#68E4F4',
      accent:        '#FF6858',
      textPrimary:   '#E4F4FF',
      textSecondary: '#88B4D4',
      textMuted:     '#4C7090',
      error:         '#FF5060',
      warning:       '#F0A820',
      success:       '#28C870',
    },
    sections: {
      workout: { soft: '#061830', strong: '#00CCE8', text: '#70E8F8' },
      meals:   { soft: '#042818', strong: '#28C878', text: '#88F0B8' },
      ai:      { soft: '#080A30', strong: '#4050F8', text: '#90A8FF' },
      planner: { soft: '#0A1430', strong: '#5870FF', text: '#A8B8FF' },
      account: { soft: '#162808', strong: '#80CC28', text: '#C8F070' },
    },
  },

  amethyst: {
    // UNCHANGED. Deep violet-black, vivid grape primary, teal accent.
    name: 'amethyst',
    label: 'Amethyst Galaxy',
    description: 'Velvet-dark violet with vivid grape primary and electric teal contrast.',
    colors: {
      background:    '#09060F',
      surface:       '#12091E',
      surfaceRaised: '#1C1030',
      border:        '#2E1850',
      primary:       '#9838F8',
      primaryDark:   '#7020C8',
      primaryLight:  '#C888FF',
      accent:        '#28E8C0',
      textPrimary:   '#F0E8FF',
      textSecondary: '#B098D8',
      textMuted:     '#706890',
      error:         '#FF4868',
      warning:       '#E0A030',
      success:       '#38C888',
    },
    sections: {
      workout: { soft: '#101840', strong: '#4848F0', text: '#A0A8FF' },
      meals:   { soft: '#062C28', strong: '#28E8C0', text: '#88FFE8' },
      ai:      { soft: '#1E0840', strong: '#9838F8', text: '#CC88FF' },
      planner: { soft: '#1E0830', strong: '#D040A0', text: '#F490D8' },
      account: { soft: '#201808', strong: '#D8A028', text: '#F0D070' },
    },
  },

  // ── DARK / WARM ──────────────────────────────────────────────────────────────

  ember: {
    // CHANGED MEALS SECTION: meals were lime-green — felt wrong for a fire theme.
    // Now fully fire-palette: orange workout / amber-gold meals / purple AI.
    // Separates ember from cocoa, which now owns the terracotta+azure lane.
    name: 'ember',
    label: 'Ember Forge',
    description: 'Scorched warm-black with flame orange and sun-amber — intense heat energy.',
    colors: {
      background:    '#0C0704',
      surface:       '#180C06',
      surfaceRaised: '#241308',
      border:        '#3C1E08',
      primary:       '#FF6018',
      primaryDark:   '#C04010',
      primaryLight:  '#FFA060',
      accent:        '#FFD020',
      textPrimary:   '#FFF8F0',
      textSecondary: '#D0A888',
      textMuted:     '#907060',
      error:         '#FF3030',
      warning:       '#FFD020',
      success:       '#50C060',
    },
    sections: {
      workout: { soft: '#281408', strong: '#FF6018', text: '#FFA870' },  // ORANGE fire
      meals:   { soft: '#281800', strong: '#FFB800', text: '#FFE078' },  // AMBER glow (was lime — now fire)
      ai:      { soft: '#100820', strong: '#9050E8', text: '#C898F8' },  // purple
      planner: { soft: '#201008', strong: '#FFD020', text: '#FFF080' },
      account: { soft: '#180E04', strong: '#E88018', text: '#F8C068' },
    },
  },

  wine: {
    // UNCHANGED. Blood-red bg, deep crimson, dusty gold — moody cellar.
    name: 'wine',
    label: 'Merlot Dark',
    description: 'Blood-red background with crimson primary and dusty gold — brooding and mature.',
    colors: {
      background:    '#100608',
      surface:       '#1C0B10',
      surfaceRaised: '#2A1018',
      border:        '#461828',
      primary:       '#C82848',
      primaryDark:   '#9A1830',
      primaryLight:  '#E87898',
      accent:        '#D0A040',
      textPrimary:   '#F8EEF0',
      textSecondary: '#C898A8',
      textMuted:     '#886070',
      error:         '#FF3848',
      warning:       '#D4A020',
      success:       '#3AB870',
    },
    sections: {
      workout: { soft: '#280C14', strong: '#C82848', text: '#F098B0' },  // CRIMSON
      meals:   { soft: '#0C2010', strong: '#38AA70', text: '#88DDB0' },  // sage
      ai:      { soft: '#1A0830', strong: '#8848D8', text: '#C898FF' },  // violet
      planner: { soft: '#200A08', strong: '#D0A040', text: '#F0CC78' },
      account: { soft: '#1A1006', strong: '#C89830', text: '#F0D068' },
    },
  },

  obsidian: {
    // UNCHANGED. Ultra-black, antique gold only — cold minimal luxury.
    name: 'obsidian',
    label: 'Obsidian & Gold',
    description: 'Ultra-black background with antique gold as the only accent — minimal and powerful.',
    colors: {
      background:    '#060708',
      surface:       '#0E1012',
      surfaceRaised: '#161820',
      border:        '#24282E',
      primary:       '#C09428',
      primaryDark:   '#906C10',
      primaryLight:  '#E0C060',
      accent:        '#7898C8',
      textPrimary:   '#F0EAD8',
      textSecondary: '#B0A888',
      textMuted:     '#706850',
      error:         '#CC3838',
      warning:       '#C09020',
      success:       '#3EA858',
    },
    sections: {
      workout: { soft: '#1A1408', strong: '#C09428', text: '#E8CC70' },  // GOLD
      meals:   { soft: '#081E10', strong: '#3AA860', text: '#88D8A8' },  // forest green
      ai:      { soft: '#0C1428', strong: '#4878C8', text: '#98B8EE' },  // steel blue
      planner: { soft: '#181408', strong: '#E0B840', text: '#F8E080' },
      account: { soft: '#181408', strong: '#A88020', text: '#DCC060' },
    },
  },

  // ── DARK / VIVID ─────────────────────────────────────────────────────────────

  neon: {
    // UNCHANGED. Purple-black, electric magenta, neon green — pure cyberpunk.
    name: 'neon',
    label: 'Neon Noir',
    description: 'Deep purple-black with electric magenta and neon green — retro-futurist cyberpunk.',
    colors: {
      background:    '#08050F',
      surface:       '#11081E',
      surfaceRaised: '#1A1030',
      border:        '#2C1A48',
      primary:       '#FF18CC',
      primaryDark:   '#C000A0',
      primaryLight:  '#FF88E8',
      accent:        '#00FF88',
      textPrimary:   '#FFF0FF',
      textSecondary: '#C0A8D8',
      textMuted:     '#806090',
      error:         '#FF2850',
      warning:       '#F0C020',
      success:       '#00F070',
    },
    sections: {
      workout: { soft: '#280830', strong: '#FF18CC', text: '#FF90EE' },  // MAGENTA
      meals:   { soft: '#022818', strong: '#00FF88', text: '#80FFD0' },  // NEON GREEN
      ai:      { soft: '#080A38', strong: '#4050FF', text: '#9098FF' },  // electric blue
      planner: { soft: '#180A28', strong: '#D020F0', text: '#F090FF' },
      account: { soft: '#1C1804', strong: '#F0D000', text: '#FFF060' },
    },
  },

  flamingo: {
    // REDESIGNED. Was: hot fuchsia on dark pink-black — too close to Neon.
    // Now: tropical CORAL-ORANGE on warm dark-brown (Miami sunset, not rave).
    // Sections: coral workout / tropical-aqua meals / orchid AI.
    name: 'flamingo',
    label: 'Flamingo Coast',
    description: 'Warm dark background with tropical coral and aqua — sunset beach, not cyberpunk.',
    colors: {
      background:    '#180E08',  // warm dark brown-black
      surface:       '#221608',
      surfaceRaised: '#301E10',
      border:        '#502C18',
      primary:       '#FF7858',  // CORAL-ORANGE (not fuchsia)
      primaryDark:   '#CC5030',
      primaryLight:  '#FFB098',
      accent:        '#20D8B8',  // tropical AQUA
      textPrimary:   '#FFF4EE',
      textSecondary: '#D0A888',
      textMuted:     '#906860',
      error:         '#FF3840',
      warning:       '#F0A820',
      success:       '#28C870',
    },
    sections: {
      workout: { soft: '#301008', strong: '#FF7858', text: '#FFB898' },  // CORAL (brand color)
      meals:   { soft: '#063028', strong: '#20D8B8', text: '#80F8E8' },  // TROPICAL AQUA
      ai:      { soft: '#1C0830', strong: '#C048D0', text: '#E898FF' },  // orchid purple
      planner: { soft: '#281808', strong: '#F0A828', text: '#F8D888' },
      account: { soft: '#280E08', strong: '#FF6840', text: '#FFA888' },
    },
  },

  citrus: {
    // REDESIGNED. Was: red-orange on warm-dark — too close to Scarlet.
    // Now: electric LIME-GREEN primary on dark olive-black — actual citrus fruit colors.
    // Sections: lime workout / electric-yellow meals / teal AI.
    name: 'citrus',
    label: 'Citrus Strike',
    description: 'Dark olive-black with electric lime and sharp yellow — sharp, acidic, high-contrast.',
    colors: {
      background:    '#080C04',  // near-black with olive tint
      surface:       '#10160A',
      surfaceRaised: '#1A2210',
      border:        '#2C3C18',
      primary:       '#AADD00',  // electric LIME
      primaryDark:   '#7AAA00',
      primaryLight:  '#D4F860',
      accent:        '#FFE000',  // sharp YELLOW
      textPrimary:   '#F4FAE8',
      textSecondary: '#A8C878',
      textMuted:     '#6A8850',
      error:         '#FF4040',
      warning:       '#FFD020',
      success:       '#40CC60',
    },
    sections: {
      workout: { soft: '#1A2A08', strong: '#AADD00', text: '#D8F860' },  // LIME
      meals:   { soft: '#2A2200', strong: '#FFE000', text: '#FFF880' },  // YELLOW
      ai:      { soft: '#082028', strong: '#20B8D0', text: '#80E8F8' },  // teal
      planner: { soft: '#202800', strong: '#C8F000', text: '#EEFF80' },
      account: { soft: '#1A2808', strong: '#88CC00', text: '#C4F060' },
    },
  },

  scarlet: {
    // CHANGED SECTIONS: bg shifted from warm-red to neutral dark (separates from Wine's
    // blood-red moodiness). Accent changed from gold to electric blue — sporty contrast.
    // Sections: red workout / electric-blue meals / steel AI — feels like a sports brand kit.
    name: 'scarlet',
    label: 'Scarlet Rush',
    description: 'Vivid performance red on neutral dark — bold, sporty, nothing subtle about it.',
    colors: {
      background:    '#0A0808',  // neutral dark (not warm-red like Wine)
      surface:       '#141010',
      surfaceRaised: '#1E1414',
      border:        '#3C1818',
      primary:       '#FF2020',  // vivid bright RED
      primaryDark:   '#CC0000',
      primaryLight:  '#FF8888',
      accent:        '#0088FF',  // electric BLUE (sporty contrast)
      textPrimary:   '#FFF8F8',
      textSecondary: '#CCA8A8',
      textMuted:     '#886868',
      error:         '#FF4444',
      warning:       '#FFCC00',
      success:       '#40CC60',
    },
    sections: {
      workout: { soft: '#2C0808', strong: '#FF2020', text: '#FF9898' },  // BRIGHT RED
      meals:   { soft: '#082038', strong: '#0088FF', text: '#88C8FF' },  // ELECTRIC BLUE (sport)
      ai:      { soft: '#0C0C1E', strong: '#6060C0', text: '#A8A8F0' },  // cool steel-violet
      planner: { soft: '#1E1808', strong: '#FFCC00', text: '#FFF080' },
      account: { soft: '#220808', strong: '#FF4040', text: '#FFA0A0' },
    },
  },

  // ── MEDIUM DARK ──────────────────────────────────────────────────────────────

  forest: {
    // UNCHANGED. Dark woodland-green bg, emerald primary, clay accent.
    name: 'forest',
    label: 'Forest Run',
    description: 'Deep woodland-green background with emerald primary and earthy amber.',
    colors: {
      background:    '#081008',
      surface:       '#101A10',
      surfaceRaised: '#182818',
      border:        '#283E28',
      primary:       '#2ECC60',
      primaryDark:   '#1E9840',
      primaryLight:  '#88E8A8',
      accent:        '#E8B848',
      textPrimary:   '#F0F8F0',
      textSecondary: '#A8C8A8',
      textMuted:     '#70906A',
      error:         '#FF6060',
      warning:       '#F6C453',
      success:       '#2ECC60',
    },
    sections: {
      workout: { soft: '#102030', strong: '#4898D8', text: '#A0C8F0' },  // sky blue
      meals:   { soft: '#143018', strong: '#2ECC60', text: '#A0F0B8' },  // EMERALD
      ai:      { soft: '#141828', strong: '#5060C8', text: '#A0A8F0' },  // forest violet
      planner: { soft: '#202A10', strong: '#E8B848', text: '#F8DCA0' },
      account: { soft: '#1E1A08', strong: '#D0A030', text: '#F0D070' },
    },
  },

  cocoa: {
    // CHANGED: primary shifted from golden-caramel to terracotta-sienna (#C04828).
    // Meals section changed from sage-green to cool AZURE BLUE — warm/cool contrast
    // makes it feel like a specialty coffee shop, not a fire theme (Ember).
    // Now clearly distinct: Ember=fire-orange, Cocoa=terracotta+azure, Obsidian=cold-gold.
    name: 'cocoa',
    label: 'Cocoa Depths',
    description: 'Warm espresso-brown panels with terracotta primary and cool azure contrast.',
    colors: {
      background:    '#1E1008',
      surface:       '#2A1808',
      surfaceRaised: '#38200C',
      border:        '#503018',
      primary:       '#C04828',  // terracotta-sienna (was golden-caramel #D09038)
      primaryDark:   '#9A3010',
      primaryLight:  '#E09068',
      accent:        '#60A8D8',  // cool azure
      textPrimary:   '#F8EAD8',
      textSecondary: '#C8A882',
      textMuted:     '#907060',
      error:         '#FF5050',
      warning:       '#E8A830',
      success:       '#50B870',
    },
    sections: {
      workout: { soft: '#301408', strong: '#C04828', text: '#E89868' },  // TERRACOTTA
      meals:   { soft: '#0C2038', strong: '#60A8D8', text: '#A8D8F8' },  // AZURE BLUE
      ai:      { soft: '#201408', strong: '#D09038', text: '#F0C870' },  // amber-ochre
      planner: { soft: '#281C08', strong: '#E0B060', text: '#F8D898' },
      account: { soft: '#281408', strong: '#B84020', text: '#E89060' },
    },
  },

  slate: {
    // UNCHANGED. Steel blue-grey bg, coral-orange primary, teal accent.
    name: 'slate',
    label: 'Slate & Coral',
    description: 'Cool steel blue-grey panels with warm coral-orange primary — clean professional contrast.',
    colors: {
      background:    '#182030',
      surface:       '#222C3E',
      surfaceRaised: '#2C3850',
      border:        '#3A4C66',
      primary:       '#F07848',
      primaryDark:   '#C05828',
      primaryLight:  '#F8A880',
      accent:        '#40C8D0',
      textPrimary:   '#E8F4FF',
      textSecondary: '#A8C0D8',
      textMuted:     '#6888A8',
      error:         '#FF5058',
      warning:       '#F0A030',
      success:       '#40C878',
    },
    sections: {
      workout: { soft: '#142840', strong: '#40C8D0', text: '#A0E8F0' },  // TEAL
      meals:   { soft: '#142A20', strong: '#40C878', text: '#98E8B0' },  // sage
      ai:      { soft: '#201408', strong: '#F07848', text: '#F8C0A0' },  // CORAL
      planner: { soft: '#1E1840', strong: '#7870E8', text: '#C0B8FF' },
      account: { soft: '#0E2010', strong: '#40C878', text: '#98E8B0' },
    },
  },

  // ── LIGHT ────────────────────────────────────────────────────────────────────

  sunrise: {
    // UNCHANGED. Warm cream/peach bg, tangerine orange primary.
    name: 'sunrise',
    label: 'Sunrise Bloom',
    description: 'Warm cream background with tangerine orange primary — a bright, cozy morning feel.',
    colors: {
      background:    '#FFF5EC',
      surface:       '#FFFDF9',
      surfaceRaised: '#FDEDDC',
      border:        '#E8CDB5',
      primary:       '#F28C28',
      primaryDark:   '#D46F0A',
      primaryLight:  '#FBC98C',
      accent:        '#D96C8B',
      textPrimary:   '#402A1E',
      textSecondary: '#75584A',
      textMuted:     '#A2806D',
      error:         '#D64545',
      warning:       '#D99A00',
      success:       '#2F9E66',
    },
    sections: {
      workout: { soft: '#DDEEFF', strong: '#3A82CC', text: '#1A4A88' },
      meals:   { soft: '#D8F0E0', strong: '#2A9E58', text: '#0E5028' },
      ai:      { soft: '#EAE0FF', strong: '#6848C8', text: '#2A1080' },
      planner: { soft: '#F5E8C9', strong: '#B98A22', text: '#6F5211' },
      account: { soft: '#FFE8EC', strong: '#D96C8B', text: '#8A1E38' },
    },
  },

  arctic: {
    // UNCHANGED. Crisp white-blue bg, deep navy primary, mint accent.
    name: 'arctic',
    label: 'Arctic Ice',
    description: 'Crisp white-blue surface with deep navy workouts and mint meals — cold, clean, precise.',
    colors: {
      background:    '#EFF7FF',
      surface:       '#FFFFFF',
      surfaceRaised: '#E0EFF8',
      border:        '#BACED8',
      primary:       '#2474C8',
      primaryDark:   '#1A5498',
      primaryLight:  '#74B4F0',
      accent:        '#18A8A0',
      textPrimary:   '#081C2C',
      textSecondary: '#2C4C68',
      textMuted:     '#587898',
      error:         '#CC2E3C',
      warning:       '#C07800',
      success:       '#1A8A54',
    },
    sections: {
      workout: { soft: '#CCEAFF', strong: '#2474C8', text: '#083468' },
      meals:   { soft: '#C0EED8', strong: '#18A8A0', text: '#064840' },
      ai:      { soft: '#EAE4FF', strong: '#5030CC', text: '#200880' },
      planner: { soft: '#E0EEFF', strong: '#6090F8', text: '#1E4898' },
      account: { soft: '#FFF8C8', strong: '#B88800', text: '#5C4400' },
    },
  },

  rose: {
    // MINOR CHANGE: primary shifted to a slightly more dusty/muted tone (#A83860 vs #B83462).
    // Stays light blush — soft, romantic, elegant. Blossom now handles the bold/dark pink lane.
    name: 'rose',
    label: 'Rose Quartz',
    description: 'Soft blush with dusty rose primary and gold — delicate, romantic, understated.',
    colors: {
      background:    '#FFF2F6',
      surface:       '#FFFFFF',
      surfaceRaised: '#FDE8F0',
      border:        '#EDB8CC',
      primary:       '#A83860',  // dusty rose (slightly more muted than before)
      primaryDark:   '#802040',
      primaryLight:  '#D88AAC',
      accent:        '#B87840',  // warm sand-gold
      textPrimary:   '#280818',
      textSecondary: '#682440',
      textMuted:     '#A06880',
      error:         '#CC2244',
      warning:       '#B07000',
      success:       '#207840',
    },
    sections: {
      workout: { soft: '#E0E4FF', strong: '#5058C8', text: '#181888' },  // periwinkle
      meals:   { soft: '#D4F0E0', strong: '#207840', text: '#0A4018' },  // sage green
      ai:      { soft: '#FFE0EC', strong: '#A83860', text: '#660030' },  // ROSE
      planner: { soft: '#FFF0E0', strong: '#B87840', text: '#684818' },
      account: { soft: '#FFDCE8', strong: '#902050', text: '#560020' },
    },
  },

  blossom: {
    // REDESIGNED: was light pink-white (too similar to Rose).
    // Now DARK HOT PINK — bold dark bg with vivid fuchsia primary.
    // Light vs Dark = instant separation from Rose.
    // Sections: purple workout / amber meals / hot-pink AI — maximally fun and contrasted.
    name: 'blossom',
    label: 'Blossom Noir',
    description: 'Dark fuchsia-black with vivid hot pink and plum — bold, dramatic, unapologetically pink.',
    colors: {
      background:    '#150810',  // dark with fuchsia tint
      surface:       '#20121C',
      surfaceRaised: '#2E1828',
      border:        '#501838',
      primary:       '#FF1890',  // vivid HOT PINK / fuchsia
      primaryDark:   '#CC0070',
      primaryLight:  '#FF88C8',
      accent:        '#FFD020',  // bright yellow pop
      textPrimary:   '#FFF0F8',
      textSecondary: '#D098B8',
      textMuted:     '#906880',
      error:         '#FF3048',
      warning:       '#FFD020',
      success:       '#40C870',
    },
    sections: {
      workout: { soft: '#280840', strong: '#B040E0', text: '#E090FF' },  // PLUM PURPLE
      meals:   { soft: '#2C1400', strong: '#FF8820', text: '#FFD090' },  // AMBER (warm pop)
      ai:      { soft: '#300830', strong: '#FF1890', text: '#FF90D0' },  // HOT PINK
      planner: { soft: '#281808', strong: '#FFD020', text: '#FFF080' },
      account: { soft: '#300828', strong: '#FF40A0', text: '#FFA8D8' },
    },
  },

  // ── LIGHT / NEUTRAL ──────────────────────────────────────────────────────────

  parchment: {
    name: 'parchment',
    label: 'Parchment & Bark',
    description: 'Clean white background with warm coffee-brown primary — natural, calm, and earthy.',
    colors: {
      background:    '#FAF7F4',
      surface:       '#FFFFFF',
      surfaceRaised: '#F0EAE2',
      border:        '#D8C8B8',
      primary:       '#7C4F2A',  // rich coffee-brown
      primaryDark:   '#5A3418',
      primaryLight:  '#B08A60',
      accent:        '#C07830',  // warm amber
      textPrimary:   '#2A1E14',
      textSecondary: '#6A4E38',
      textMuted:     '#A08870',
      error:         '#C43030',
      warning:       '#B87800',
      success:       '#307848',
    },
    sections: {
      workout: { soft: '#E8E0D8', strong: '#7C4F2A', text: '#3A200C' },  // BROWN
      meals:   { soft: '#D8EDDC', strong: '#307848', text: '#0E4020' },  // forest green
      ai:      { soft: '#E8E4F4', strong: '#5848A8', text: '#201060' },  // slate-violet
      planner: { soft: '#F4EAD8', strong: '#C07830', text: '#6A3E08' },
      account: { soft: '#F0E8E0', strong: '#8A5030', text: '#3A1808' },
    },
  },

  meadow: {
    name: 'meadow',
    label: 'Meadow Fresh',
    description: 'Crisp white background with vibrant grass-green primary — fresh, clean, outdoorsy.',
    colors: {
      background:    '#F4FAF5',
      surface:       '#FFFFFF',
      surfaceRaised: '#E4F4E8',
      border:        '#B8D8BE',
      primary:       '#2A8048',  // rich grass-green
      primaryDark:   '#1A5C30',
      primaryLight:  '#72C890',
      accent:        '#E07830',  // warm terracotta contrast
      textPrimary:   '#0E2418',
      textSecondary: '#2E6040',
      textMuted:     '#6A9870',
      error:         '#CC2E28',
      warning:       '#AC6800',
      success:       '#2A8048',
    },
    sections: {
      workout: { soft: '#D8EEE0', strong: '#2A8048', text: '#0A3818' },  // GRASS GREEN
      meals:   { soft: '#E8F4E4', strong: '#3EA860', text: '#1A5C30' },  // EMERALD
      ai:      { soft: '#E4EEFF', strong: '#3858C8', text: '#102080' },  // blue
      planner: { soft: '#FFF0E4', strong: '#E07830', text: '#6A2E08' },
      account: { soft: '#F0FAF2', strong: '#2A8048', text: '#0A3818' },
    },
  },

  // ── NEW THEMES ───────────────────────────────────────────────────────────────

  void: {
    // True OLED black — pure #000 background, ice-white text, minimal blue accent.
    name: 'void',
    label: 'Void',
    description: 'Pure OLED black with ice-white text and minimal blue — maximum contrast, zero distraction.',
    colors: {
      background:    '#000000',
      surface:       '#0A0A0A',
      surfaceRaised: '#141414',
      border:        '#222222',
      primary:       '#4C9EFF',
      primaryDark:   '#2A74CC',
      primaryLight:  '#88C4FF',
      accent:        '#FF6B6B',
      textPrimary:   '#FFFFFF',
      textSecondary: '#B0B0B0',
      textMuted:     '#666666',
      error:         '#FF4444',
      warning:       '#FFB020',
      success:       '#44CC66',
    },
    sections: {
      workout: { soft: '#0A1428', strong: '#4C9EFF', text: '#A0CCFF' },
      meals:   { soft: '#0A1E10', strong: '#44CC66', text: '#88EEAA' },
      ai:      { soft: '#140A1E', strong: '#9060E8', text: '#C8A0FF' },
      planner: { soft: '#1A1400', strong: '#FFB020', text: '#FFD880' },
      account: { soft: '#1A0A0A', strong: '#FF6B6B', text: '#FFB0B0' },
    },
  },

  dusk: {
    // Soft twilight — muted navy-purple with warm peach accent. Gentle dark theme.
    name: 'dusk',
    label: 'Twilight Dusk',
    description: 'Soft muted navy with warm peach and lavender — a gentle, calming dark theme.',
    colors: {
      background:    '#0E0E1A',
      surface:       '#161628',
      surfaceRaised: '#1E1E38',
      border:        '#2E2E50',
      primary:       '#E8A878',  // warm peach
      primaryDark:   '#C08050',
      primaryLight:  '#F8D0B0',
      accent:        '#A088D8',  // soft lavender
      textPrimary:   '#EAE6F0',
      textSecondary: '#A8A0C0',
      textMuted:     '#686080',
      error:         '#E85050',
      warning:       '#D8A040',
      success:       '#48B878',
    },
    sections: {
      workout: { soft: '#1A1230', strong: '#A088D8', text: '#D0C0F0' },  // LAVENDER
      meals:   { soft: '#201810', strong: '#E8A878', text: '#F8D0B0' },  // PEACH
      ai:      { soft: '#0E1428', strong: '#5878C8', text: '#A0B8F0' },  // slate-blue
      planner: { soft: '#1C1830', strong: '#C090E0', text: '#E8C8FF' },
      account: { soft: '#201018', strong: '#D06888', text: '#F0A8C8' },
    },
  },

  steel: {
    // Modern cool grey — neutral professional palette. No hue bias.
    name: 'steel',
    label: 'Steel Modern',
    description: 'Neutral grey surfaces with blue-steel accents — clean, modern, professional.',
    colors: {
      background:    '#F2F4F7',
      surface:       '#FFFFFF',
      surfaceRaised: '#E8ECF0',
      border:        '#CDD4DC',
      primary:       '#3A5BC8',  // strong blue
      primaryDark:   '#283E98',
      primaryLight:  '#7090E8',
      accent:        '#E06840',  // warm orange pop
      textPrimary:   '#1A1E28',
      textSecondary: '#4A5468',
      textMuted:     '#7A8498',
      error:         '#D03030',
      warning:       '#C07800',
      success:       '#1E8A48',
    },
    sections: {
      workout: { soft: '#D8E4FF', strong: '#3A5BC8', text: '#1A2E78' },
      meals:   { soft: '#D4F0DC', strong: '#1E8A48', text: '#0A4820' },
      ai:      { soft: '#EAE0F8', strong: '#6848B8', text: '#301878' },
      planner: { soft: '#FFF0E0', strong: '#E06840', text: '#702810' },
      account: { soft: '#E4EEF8', strong: '#4878B8', text: '#1A3868' },
    },
  },

  sand: {
    // Warm neutral light — desert sand tones with terracotta and sage.
    name: 'sand',
    label: 'Desert Sand',
    description: 'Warm sandy beige with terracotta primary and sage green — earthy, warm, inviting.',
    colors: {
      background:    '#F8F2EA',
      surface:       '#FFFCF8',
      surfaceRaised: '#F0E6D8',
      border:        '#D8C8B0',
      primary:       '#C06030',  // terracotta
      primaryDark:   '#984018',
      primaryLight:  '#E09060',
      accent:        '#608050',  // sage green
      textPrimary:   '#2A2018',
      textSecondary: '#6A5440',
      textMuted:     '#A08868',
      error:         '#C03030',
      warning:       '#B87800',
      success:       '#408840',
    },
    sections: {
      workout: { soft: '#F0E0D0', strong: '#C06030', text: '#702808' },   // TERRACOTTA
      meals:   { soft: '#DCE8D4', strong: '#608050', text: '#2A4020' },   // SAGE
      ai:      { soft: '#E8E0F0', strong: '#7858A8', text: '#382068' },   // dusty violet
      planner: { soft: '#F8ECD4', strong: '#C08830', text: '#684010' },
      account: { soft: '#F0E4D4', strong: '#A06838', text: '#583010' },
    },
  },

  lavender: {
    // Soft pastel dark — dark with muted lavender, mint, and rose. Cozy and calming.
    name: 'lavender',
    label: 'Lavender Dream',
    description: 'Soft dark purple with muted lavender, mint, and rose — cozy, pastel, dreamy.',
    colors: {
      background:    '#121018',
      surface:       '#1A1624',
      surfaceRaised: '#242032',
      border:        '#382E4C',
      primary:       '#B898E0',  // soft lavender
      primaryDark:   '#8868B8',
      primaryLight:  '#D8C0F8',
      accent:        '#78D8B0',  // soft mint
      textPrimary:   '#EEE8F8',
      textSecondary: '#B0A0C8',
      textMuted:     '#706488',
      error:         '#E86070',
      warning:       '#D8A848',
      success:       '#58C888',
    },
    sections: {
      workout: { soft: '#1A1430', strong: '#B898E0', text: '#D8C0F8' },  // LAVENDER
      meals:   { soft: '#0C2420', strong: '#78D8B0', text: '#B0F0D8' },  // MINT
      ai:      { soft: '#201028', strong: '#D878A8', text: '#F0A8D0' },  // soft ROSE
      planner: { soft: '#201828', strong: '#A880D0', text: '#D0B0F0' },
      account: { soft: '#1C1018', strong: '#E07090', text: '#F8B0C8' },
    },
  },

  // ── NEW THEMES ───────────────────────────────────────────────────────────────

  aurora: {
    // Northern-lights inspired — deep dark blue with shifting green, teal, and violet accents.
    name: 'aurora',
    label: 'Aurora Borealis',
    description: 'Deep arctic night with shimmering green, teal, and violet — like the northern lights.',
    colors: {
      background:    '#060B14',
      surface:       '#0C1420',
      surfaceRaised: '#14202E',
      border:        '#1C2C3E',
      primary:       '#40E8A0',  // aurora green
      primaryDark:   '#28B878',
      primaryLight:  '#80F8C8',
      accent:        '#60B8F0',  // icy blue
      textPrimary:   '#E8F0F8',
      textSecondary: '#90A8C0',
      textMuted:     '#506878',
      error:         '#F06070',
      warning:       '#E8B040',
      success:       '#40D888',
    },
    sections: {
      workout: { soft: '#081820', strong: '#40E8A0', text: '#90F8D0' },   // AURORA GREEN
      meals:   { soft: '#081420', strong: '#60B8F0', text: '#A0D8F8' },   // ICY BLUE
      ai:      { soft: '#140C28', strong: '#A070E8', text: '#C8A8F8' },   // VIOLET
      planner: { soft: '#0C1C28', strong: '#48C8D8', text: '#90E0E8' },   // TEAL
      account: { soft: '#181020', strong: '#B868D8', text: '#D8A0F0' },
    },
  },

  copper: {
    // Warm industrial — charcoal-brown base with rich copper, burnished gold, and warm cream.
    name: 'copper',
    label: 'Burnished Copper',
    description: 'Charcoal-brown with rich copper and burnished gold — warm, industrial, bold.',
    colors: {
      background:    '#0E0C0A',
      surface:       '#181410',
      surfaceRaised: '#24201A',
      border:        '#383028',
      primary:       '#D88040',  // copper
      primaryDark:   '#B06028',
      primaryLight:  '#F0A868',
      accent:        '#E8C048',  // burnished gold
      textPrimary:   '#F0E8E0',
      textSecondary: '#B8A898',
      textMuted:     '#786858',
      error:         '#E85848',
      warning:       '#E8A830',
      success:       '#68B860',
    },
    sections: {
      workout: { soft: '#201810', strong: '#D88040', text: '#F0B078' },   // COPPER
      meals:   { soft: '#141C10', strong: '#88B848', text: '#B8D878' },   // OLIVE GREEN
      ai:      { soft: '#201418', strong: '#C86070', text: '#E89098' },   // DUSTY ROSE
      planner: { soft: '#201C10', strong: '#E8C048', text: '#F0D888' },   // GOLD
      account: { soft: '#181410', strong: '#C89060', text: '#E0B888' },
    },
  },

  storm: {
    // Electric storm — dark slate with electric blue-white lightning, cool grays, and sharp cyan.
    name: 'storm',
    label: 'Thunderstorm',
    description: 'Dark slate with electric blue-white highlights — charged, sharp, powerful.',
    colors: {
      background:    '#0A0C10',
      surface:       '#12151C',
      surfaceRaised: '#1C2028',
      border:        '#2C3040',
      primary:       '#70A8F8',  // lightning blue
      primaryDark:   '#4880D0',
      primaryLight:  '#A0C8F8',
      accent:        '#E0E8F8',  // bright white-blue
      textPrimary:   '#E8ECF4',
      textSecondary: '#98A4B8',
      textMuted:     '#586474',
      error:         '#F06068',
      warning:       '#E8B040',
      success:       '#50C878',
    },
    sections: {
      workout: { soft: '#101828', strong: '#70A8F8', text: '#A0C8F8' },   // LIGHTNING BLUE
      meals:   { soft: '#0C1818', strong: '#48B8B8', text: '#88D8D8' },   // STORM TEAL
      ai:      { soft: '#181020', strong: '#9880D8', text: '#C0A8F0' },   // ELECTRIC PURPLE
      planner: { soft: '#101418', strong: '#6890C0', text: '#98B8E0' },   // SLATE BLUE
      account: { soft: '#181418', strong: '#A888C0', text: '#C8B0D8' },
    },
  },

  // ── LIGHT / NEW ──────────────────────────────────────────────────────────────

  linen: {
    name: 'linen',
    label: 'Linen & Olive',
    description: 'Soft cream background with earthy olive primary and muted clay — minimal, grown-up, serene.',
    colors: {
      background:    '#F8F4EC',
      surface:       '#FFFDF6',
      surfaceRaised: '#EFE8D8',
      border:        '#D4CAB4',
      primary:       '#6A8030',  // olive
      primaryDark:   '#4A5A1A',
      primaryLight:  '#9CB058',
      accent:        '#B85830',  // clay
      textPrimary:   '#1E2410',
      textSecondary: '#4C5A34',
      textMuted:     '#8A9468',
      error:         '#B8342C',
      warning:       '#B07020',
      success:       '#3A7A48',
    },
    sections: {
      workout: { soft: '#E8F0D4', strong: '#6A8030', text: '#2A4010' },   // OLIVE
      meals:   { soft: '#F5E4D4', strong: '#B85830', text: '#5A2010' },   // CLAY
      ai:      { soft: '#E4E8F0', strong: '#4868A8', text: '#18306E' },   // BLUESTONE
      planner: { soft: '#F4ECD4', strong: '#A88434', text: '#5E4414' },
      account: { soft: '#EDE4F4', strong: '#6A508C', text: '#30205E' },
    },
  },

  mint: {
    name: 'mint',
    label: 'Mint Fresh',
    description: 'Pale mint background with deep teal primary and coral accent — clean, cool, refreshing.',
    colors: {
      background:    '#EDF8F2',
      surface:       '#FFFFFF',
      surfaceRaised: '#DCEFE4',
      border:        '#B4D8C4',
      primary:       '#0E8078',  // deep teal
      primaryDark:   '#065850',
      primaryLight:  '#48B8A8',
      accent:        '#E06848',  // coral
      textPrimary:   '#082418',
      textSecondary: '#2C5244',
      textMuted:     '#5A7868',
      error:         '#CC2E3C',
      warning:       '#B87800',
      success:       '#1A8A54',
    },
    sections: {
      workout: { soft: '#C8ECE0', strong: '#0E8078', text: '#033630' },   // TEAL
      meals:   { soft: '#FFE4D8', strong: '#E06848', text: '#6A1C08' },   // CORAL
      ai:      { soft: '#E4E4F8', strong: '#5848CC', text: '#1C0C6A' },   // INDIGO
      planner: { soft: '#FFF0C8', strong: '#B87800', text: '#5A3C00' },
      account: { soft: '#F8E0EC', strong: '#C0347C', text: '#5A0838' },
    },
  },

};

export const colors = APP_THEMES.midnight.colors;

export function getTheme(themeName?: AppThemeName | string): AppTheme {
  return (APP_THEMES as Record<string, AppTheme>)[themeName ?? 'midnight'] ?? APP_THEMES.midnight;
}

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  full: 999,
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
} as const;
