import { Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getTheme } from '../constants/theme';
import { AppThemeName } from '../types';

export interface RouteCoord {
  lat: number;
  lon: number;
}

interface Props {
  themeName?: AppThemeName;
  coords: ReadonlyArray<RouteCoord> | null | undefined;
  height?: number;
  caption?: string;
  interactive?: boolean;
}

export default function RouteSummaryMap({
  themeName, coords, height = 220, caption,
}: Props) {
  const tc = getTheme(themeName).colors;
  const hasRoute = (coords?.length ?? 0) > 0;

  return (
    <View style={{ marginVertical: 8 }}>
      <View style={{
        height: hasRoute ? height : 80,
        borderRadius: 12, borderWidth: 1, borderColor: tc.surfaceRaised,
        backgroundColor: tc.surface,
        flexDirection: hasRoute ? 'column' : 'row',
        alignItems: 'center', justifyContent: 'center', gap: hasRoute ? 6 : 10,
        paddingHorizontal: 14,
      }}>
        <Ionicons name={hasRoute ? 'map-outline' : 'navigate-outline'} size={hasRoute ? 22 : 18} color={tc.textMuted} />
        <Text style={{
          fontSize: hasRoute ? 11 : 12,
          color: tc.textMuted,
          textAlign: hasRoute ? 'center' : 'left',
          flex: hasRoute ? 0 : 1,
        }}>
          {hasRoute
            ? 'Route map unavailable on web'
            : 'No route captured for this workout (indoor session, GPS off, or watch-tracked).'}
        </Text>
      </View>
      {caption ? (
        <Text style={{
          fontSize: 11, color: tc.textMuted, textAlign: 'center',
          marginTop: 4,
        }}>
          {caption}
        </Text>
      ) : null}
    </View>
  );
}

