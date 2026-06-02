/**
 * RouteSummaryMap — static (non-tracking) map view for the
 * post-workout summary. Renders the full route polyline + start/end
 * pins, auto-fits the camera so the whole trail is visible.
 *
 * Intended use: the workout summary screen for cardio sessions, the
 * social-share preview, the per-day completed-workout overlay, etc.
 * Anywhere a `route_coords` array is in hand and we want to render it
 * as "the route you took today."
 */
import { useEffect, useMemo, useRef } from 'react';
import { View, Text, UIManager } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getTheme } from '../constants/theme';
import { AppThemeName } from '../types';

let MapView: any = null;
let Polyline: any = null;
let Marker: any = null;
let mapModuleLoadAttempted = false;
function loadMapModule() {
  if (mapModuleLoadAttempted) return;
  mapModuleLoadAttempted = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('react-native-maps');
    // Guard against the JS module loading without its iOS native view
    // — happens when react-native-maps is added to package.json but
    // Pods weren't reinstalled. Rendering MapView in that state
    // crashes via `requireNativeComponent('AIRMap')`.
    const hasNative = UIManager.hasViewManagerConfig?.('AIRMap') ?? false;
    if (hasNative) {
      MapView = mod?.default ?? null;
      Polyline = mod?.Polyline ?? null;
      Marker = mod?.Marker ?? null;
    } else {
      MapView = null;
    }
  } catch {
    MapView = null;
  }
}

export interface RouteCoord {
  lat: number;
  lon: number;
}

interface Props {
  themeName?: AppThemeName;
  /** Persisted route_coords from WorkoutCompletion. Empty / null
   *  renders an empty-state caption ("No route captured"). */
  coords: ReadonlyArray<RouteCoord> | null | undefined;
  /** Fixed height in points; defaults to 220 for summary cards. */
  height?: number;
  /** Optional caption rendered below the map (e.g. "5.2 mi · 42 min").
   *  When omitted, no caption renders. */
  caption?: string;
  /** Touch-disabled by default — summary maps are decorative. Set to
   *  true to allow pan/zoom (e.g. on a dedicated detail screen). */
  interactive?: boolean;
}

function computeRegion(coords: ReadonlyArray<RouteCoord>): {
  latitude: number; longitude: number;
  latitudeDelta: number; longitudeDelta: number;
} | null {
  if (coords.length === 0) return null;
  let minLat = coords[0].lat, maxLat = coords[0].lat;
  let minLon = coords[0].lon, maxLon = coords[0].lon;
  for (const c of coords) {
    if (c.lat < minLat) minLat = c.lat;
    if (c.lat > maxLat) maxLat = c.lat;
    if (c.lon < minLon) minLon = c.lon;
    if (c.lon > maxLon) maxLon = c.lon;
  }
  // Add a small padding (~15%) so pins aren't pressed against the edge.
  const latPad = Math.max((maxLat - minLat) * 0.15, 0.0008);
  const lonPad = Math.max((maxLon - minLon) * 0.15, 0.0008);
  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLon + maxLon) / 2,
    latitudeDelta: (maxLat - minLat) + latPad * 2,
    longitudeDelta: (maxLon - minLon) + lonPad * 2,
  };
}

export default function RouteSummaryMap({
  themeName, coords, height = 220, caption, interactive = false,
}: Props) {
  loadMapModule();
  const tc = getTheme(themeName).colors;
  const safe = useMemo(() => coords ?? [], [coords]);
  const polylineCoords = useMemo(
    () => safe.map(c => ({ latitude: c.lat, longitude: c.lon })),
    [safe],
  );
  const region = useMemo(() => computeRegion(safe), [safe]);
  const mapRef = useRef<any>(null);

  // Re-fit when coords change (e.g. switching between completed
  // sessions in a list view that reuses one map).
  useEffect(() => {
    if (!mapRef.current || polylineCoords.length === 0) return;
    try {
      mapRef.current.fitToCoordinates(polylineCoords, {
        edgePadding: { top: 30, left: 30, right: 30, bottom: 30 },
        animated: false,
      });
    } catch { /* map not ready */ }
  }, [polylineCoords]);

  if (!MapView) {
    return (
      <View style={{
        height, marginVertical: 8,
        borderRadius: 12, borderWidth: 1, borderColor: tc.surfaceRaised,
        backgroundColor: tc.surface,
        alignItems: 'center', justifyContent: 'center', gap: 6,
      }}>
        <Ionicons name="map-outline" size={22} color={tc.textMuted} />
        <Text style={{ fontSize: 11, color: tc.textMuted }}>
          Map view unavailable in this build
        </Text>
      </View>
    );
  }

  if (safe.length === 0 || !region) {
    return (
      <View style={{
        height: 80, marginVertical: 8,
        borderRadius: 12, borderWidth: 1, borderColor: tc.surfaceRaised,
        backgroundColor: tc.surface,
        flexDirection: 'row', alignItems: 'center', gap: 10,
        paddingHorizontal: 14,
      }}>
        <Ionicons name="navigate-outline" size={18} color={tc.textMuted} />
        <Text style={{ fontSize: 12, color: tc.textMuted, flex: 1 }}>
          No route captured for this workout (indoor session, GPS off, or watch-tracked).
        </Text>
      </View>
    );
  }

  return (
    <View style={{ marginVertical: 8 }}>
      <View style={{
        height, borderRadius: 12, overflow: 'hidden',
        borderWidth: 1, borderColor: tc.surfaceRaised,
      }}>
        <MapView
          ref={mapRef}
          style={{ flex: 1 }}
          initialRegion={region}
          showsUserLocation={false}
          showsCompass={false}
          showsMyLocationButton={false}
          toolbarEnabled={false}
          scrollEnabled={interactive}
          zoomEnabled={interactive}
          pitchEnabled={false}
          rotateEnabled={false}
        >
          {polylineCoords.length > 1 && (
            <Polyline
              coordinates={polylineCoords}
              strokeColor={tc.primary}
              strokeWidth={4}
              lineCap="round"
              lineJoin="round"
            />
          )}
          {/* Start pin (green) + end pin (red) so the user can tell
              which end is the start of their run. */}
          <Marker
            coordinate={{ latitude: safe[0].lat, longitude: safe[0].lon }}
            anchor={{ x: 0.5, y: 0.5 }}
            tracksViewChanges={false}
          >
            <View style={{
              width: 14, height: 14, borderRadius: 7,
              backgroundColor: '#10B981',
              borderWidth: 2, borderColor: '#fff',
            }} />
          </Marker>
          <Marker
            coordinate={{
              latitude: safe[safe.length - 1].lat,
              longitude: safe[safe.length - 1].lon,
            }}
            anchor={{ x: 0.5, y: 0.5 }}
            tracksViewChanges={false}
          >
            <View style={{
              width: 14, height: 14, borderRadius: 7,
              backgroundColor: tc.error ?? '#EF4444',
              borderWidth: 2, borderColor: '#fff',
            }} />
          </Marker>
        </MapView>
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
