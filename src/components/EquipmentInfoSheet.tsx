/**
 * EquipmentInfoSheet — "what is this?" popover for an equipment chip.
 *
 * Renders a bottom sheet with the bundled equipment photo (from
 * `assets/images/equipment/{slug}.png`) so the user can identify
 * unfamiliar gear without leaving the app. When no bundled image
 * is available for a slug, falls through to Google Image Search +
 * YouTube buttons.
 *
 * Image source is resolved via `getEquipmentImageSource(slug)` —
 * Metro's bundler needs a static `require()` map (see
 * `src/utils/equipmentImageAssets.ts`).
 *
 * No native dep. Works in Expo Go.
 */
import {
  Image,
  Linking,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getContrastingTextColor, getTheme } from '../constants/theme';
import type { AppThemeName } from '../types';
import { getEquipmentImageSource } from '../utils/equipmentImageAssets';

interface Props {
  name: string | null;
  slug?: string;
  onClose: () => void;
  themeName?: AppThemeName;
}

export default function EquipmentInfoSheet({ name, slug, onClose, themeName }: Props) {
  const tc = getTheme(themeName).colors;
  const onPrimary = getContrastingTextColor(tc.primary);
  const imageSource = getEquipmentImageSource(slug);

  const openImages = () => {
    if (!name) return;
    const q = encodeURIComponent(`${name} gym equipment`);
    Linking.openURL(`https://www.google.com/search?tbm=isch&q=${q}`).catch(() => {});
    onClose();
  };
  const openYouTube = () => {
    if (!name) return;
    const q = encodeURIComponent(`${name} how to use`);
    Linking.openURL(`https://www.youtube.com/results?search_query=${q}`).catch(() => {});
    onClose();
  };

  return (
    <Modal
      visible={name != null}
      transparent
      animationType="fade"
      onRequestClose={onClose}>
      <TouchableOpacity style={s.backdrop} activeOpacity={1} onPress={onClose}>
        <View
          style={[s.sheet, { backgroundColor: tc.surface, borderTopColor: tc.border }]}
          onStartShouldSetResponder={() => true}>
          <View style={s.headerRow}>
            <View style={{ flex: 1 }}>
              <Text style={[s.kicker, { color: tc.textMuted }]}>EQUIPMENT</Text>
              <Text style={[s.title, { color: tc.textPrimary }]}>{name ?? ''}</Text>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close" size={22} color={tc.textMuted} />
            </TouchableOpacity>
          </View>

          {imageSource ? (
            <View style={[s.imageWrap, { backgroundColor: tc.surfaceRaised ?? tc.surface, borderColor: tc.border }]}>
              <Image
                source={imageSource}
                style={s.image}
                resizeMode="contain"
                accessibilityLabel={name ?? undefined}
              />
            </View>
          ) : (
            <Text style={[s.placeholder, { color: tc.textSecondary }]}>
              No preview yet. Use the buttons below to look this up.
            </Text>
          )}

          <TouchableOpacity
            testID="equipment-info-open-images"
            onPress={openImages}
            style={[s.primaryBtn, { backgroundColor: tc.primary }]}>
            <Ionicons name="logo-google" size={18} color={onPrimary} />
            <Text style={[s.primaryBtnText, { color: onPrimary }]}>View Images</Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID="equipment-info-open-youtube"
            onPress={openYouTube}
            style={[s.secondaryBtn, { backgroundColor: tc.surfaceRaised ?? tc.surface, borderColor: tc.border }]}>
            <Ionicons name="logo-youtube" size={18} color={tc.textPrimary} />
            <Text style={[s.secondaryBtnText, { color: tc.textPrimary }]}>Watch Demo</Text>
          </TouchableOpacity>
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: 18, borderTopRightRadius: 18,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 18, paddingTop: 16, paddingBottom: 28,
  },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  kicker: { fontSize: 11, fontWeight: '700', letterSpacing: 0.6 },
  title: { fontSize: 18, fontWeight: '800', marginTop: 2 },
  imageWrap: {
    height: 180, borderRadius: 12, borderWidth: 1,
    marginTop: 14, marginBottom: 14, overflow: 'hidden',
    alignItems: 'center', justifyContent: 'center',
  },
  image: { width: '100%', height: '100%' },
  placeholder: { fontSize: 13, lineHeight: 18, marginTop: 12, marginBottom: 14 },
  primaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    paddingHorizontal: 14, paddingVertical: 12, borderRadius: 10, marginBottom: 8,
  },
  primaryBtnText: { fontSize: 14, fontWeight: '700' },
  secondaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    paddingHorizontal: 14, paddingVertical: 12, borderRadius: 10,
    borderWidth: 1,
  },
  secondaryBtnText: { fontSize: 14, fontWeight: '700' },
});
