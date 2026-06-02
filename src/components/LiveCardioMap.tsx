/**
 * LiveCardioMap — Apple-MapKit (via react-native-maps) view that renders
 * the GPS trail of an in-progress outdoor cardio session.
 *
 * Used on ActiveWorkoutScreen for run/walk/bike/hike sessions only.
 * Camera follows the user's most recent fix; a polyline draws the trail
 * as it accumulates. Indoor cardio + lifting never instantiate this
 * component, so the (heavy) MapView native view never mounts for them.
 *
 * Performance note: react-native-maps will re-flatten the polyline on
 * every prop change. We pass the coords array by stable reference and
 * let the parent throttle updates (the GPS tracker emits ≥1s apart).
 */
import { useEffect, useMemo, useRef } from 'react';
import { View, Text, Platform, UIManager } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getTheme } from '../constants/theme';
import { AppThemeName } from '../types';

// Lazy-required so iOS-only native module doesn't blow up an Android
// or Expo Go boot. Resolved at first render — null on platforms where
// react-native-maps isn't installed or wasn't bundled.
let MapView: any = null;
let Polyline: any = null;
let Marker: any = null;
let UrlTile: any = null;
let mapModuleLoadAttempted = false;
function loadMapModule() {
  if (mapModuleLoadAttempted) return;
  mapModuleLoadAttempted = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('react-native-maps');
    // The JS module can resolve fine while the iOS native view
    // (`AIRMap`) is missing — happens when react-native-maps is added
    // to package.json but the iOS Pods weren't reinstalled. Rendering
    // <MapView> in that state calls `requireNativeComponent('AIRMap')`
    // which throws a fatal error. Probe `UIManager.hasViewManagerConfig`
    // up front and fall through to the placeholder when it's missing.
    const hasNative = UIManager.hasViewManagerConfig?.('AIRMap') ?? false;
    if (hasNative) {
      MapView = mod?.default ?? null;
      Polyline = mod?.Polyline ?? null;
      Marker = mod?.Marker ?? null;
      UrlTile = mod?.UrlTile ?? null;
    } else {
      MapView = null;
    }
  } catch {
    // react-native-maps not in this build — graceful degrade. The
    // workout still functions; the map tile just doesn't render.
    MapView = null;
  }
}

interface RouteCoord {
  lat: number;
  lon: number;
}

interface Props {
  themeName?: AppThemeName;
  /** All accepted GPS samples so far. Drawn as a single polyline. The
   *  parent passes this by reference so the array identity changes
   *  only when actual new points have arrived. */
  coords: ReadonlyArray<RouteCoord>;
  /** Most recent fix — drives the camera-follow and the head pin. Pass
   *  null before the first sample arrives. */
  current: RouteCoord | null;
  /** Optional fixed height in points. Defaults to 180 — fits in the
   *  ActiveWorkoutScreen header without dominating the screen. */
  height?: number;
}

export default function LiveCardioMap({
  themeName, coords, current, height = 180,
}: Props) {
  loadMapModule();
  const tc = getTheme(themeName).colors;
  const mapRef = useRef<any>(null);

  // Animate the camera to follow the current fix. Skip the first ~3
  // updates so the map doesn't yo-yo while the GPS settles.
  const updateCountRef = useRef(0);
  useEffect(() => {
    if (!current || !mapRef.current) return;
    updateCountRef.current += 1;
    if (updateCountRef.current < 3) return;
    try {
      mapRef.current.animateCamera(
        {
          center: { latitude: current.lat, longitude: current.lon },
          zoom: Platform.OS === 'ios' ? undefined : 16,
          pitch: 0,
          heading: 0,
        },
        { duration: 800 },
      );
    } catch { /* map not ready yet */ }
  }, [current]);

  const polylineCoords = useMemo(
    () => coords.map(c => ({ latitude: c.lat, longitude: c.lon })),
    [coords],
  );

  if (!MapView) {
    return (
      <View style={{
        height, marginHorizontal: 12, marginBottom: 8,
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

  if (!current && coords.length === 0) {
    return (
      <View style={{
        height, marginHorizontal: 12, marginBottom: 8,
        borderRadius: 12, borderWidth: 1, borderColor: tc.surfaceRaised,
        backgroundColor: tc.surface,
        alignItems: 'center', justifyContent: 'center', gap: 6,
      }}>
        <Ionicons name="navigate-outline" size={22} color={tc.textMuted} />
        <Text style={{ fontSize: 11, color: tc.textMuted }}>
          Acquiring GPS fix…
        </Text>
      </View>
    );
  }

  const initialRegion = current ? {
    latitude: current.lat,
    longitude: current.lon,
    latitudeDelta: 0.005,    // ≈ 500 m
    longitudeDelta: 0.005,
  } : undefined;

  return (
    <View style={{
      height, marginHorizontal: 12, marginBottom: 8,
      borderRadius: 12, overflow: 'hidden',
      borderWidth: 1, borderColor: tc.surfaceRaised,
    }}>
      <MapView
        ref={mapRef}
        style={{ flex: 1 }}
        initialRegion={initialRegion}
        showsUserLocation={false}
        showsMyLocationButton={false}
        showsCompass={false}
        toolbarEnabled={false}
        loadingEnabled
        loadingBackgroundColor={tc.surface}
        loadingIndicatorColor={tc.primary}
        // Apple Maps default styling on iOS; Google Maps on Android.
        // Both honor `showsUserLocation` for the blue dot but we draw
        // our own pin to keep the look consistent across platforms.
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
        {coords.length > 0 && (
          <Marker
            coordinate={{
              latitude: coords[0].lat,
              longitude: coords[0].lon,
            }}
            anchor={{ x: 0.5, y: 0.5 }}
            tracksViewChanges={false}
          >
            <View style={{
              width: 14, height: 14, borderRadius: 7,
              backgroundColor: '#10B981',
              borderWidth: 2, borderColor: '#fff',
            }} />
          </Marker>
        )}
        {current && (
          <Marker
            coordinate={{ latitude: current.lat, longitude: current.lon }}
            anchor={{ x: 0.5, y: 0.5 }}
            tracksViewChanges={false}
          >
            <View style={{
              width: 18, height: 18, borderRadius: 9,
              backgroundColor: tc.primary,
              borderWidth: 3, borderColor: '#fff',
              shadowColor: '#000', shadowOpacity: 0.5,
              shadowRadius: 4, shadowOffset: { width: 0, height: 1 },
            }} />
          </Marker>
        )}
      </MapView>
    </View>
  );
}
