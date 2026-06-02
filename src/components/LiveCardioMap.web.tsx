import { Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getTheme } from '../constants/theme';
import { AppThemeName } from '../types';

interface RouteCoord {
  lat: number;
  lon: number;
}

interface Props {
  themeName?: AppThemeName;
  coords: ReadonlyArray<RouteCoord>;
  current: RouteCoord | null;
  height?: number;
}

export default function LiveCardioMap({
  themeName, height = 180,
}: Props) {
  const tc = getTheme(themeName).colors;

  return (
    <View style={{
      height, marginHorizontal: 12, marginBottom: 8,
      borderRadius: 12, borderWidth: 1, borderColor: tc.surfaceRaised,
      backgroundColor: tc.surface,
      alignItems: 'center', justifyContent: 'center', gap: 6,
    }}>
      <Ionicons name="map-outline" size={22} color={tc.textMuted} />
      <Text style={{ fontSize: 11, color: tc.textMuted }}>
        Map view unavailable on web
      </Text>
    </View>
  );
}

