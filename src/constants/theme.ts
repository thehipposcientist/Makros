export type AppThemeName =
  | 'midnight' | 'neon'    | 'ocean'   | 'forest'
  | 'ember'    | 'wine'    | 'obsidian'| 'amethyst'
  | 'citrus'   | 'flamingo'| 'cocoa'   | 'slate'
  | 'scarlet'  | 'sunrise' | 'arctic'  | 'rose'    | 'blossom';

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
