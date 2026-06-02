from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any


_GEOHASH_BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz"


def coarse_location_hash(lat: float, lon: float, precision: int = 5) -> str:
    """Return a coarse geohash-like cell id.

    Precision 5 is intentionally coarse enough for passive insights while
    still letting area coefficients and UV context be grouped. The derived
    sun exposure tables store this hash, never the raw lat/lon route.
    """
    precision = max(1, min(6, int(precision)))
    lat_interval = [-90.0, 90.0]
    lon_interval = [-180.0, 180.0]
    geohash: list[str] = []
    bit = 0
    ch = 0
    even = True
    bits = [16, 8, 4, 2, 1]
    while len(geohash) < precision:
        if even:
            mid = (lon_interval[0] + lon_interval[1]) / 2
            if lon > mid:
                ch |= bits[bit]
                lon_interval[0] = mid
            else:
                lon_interval[1] = mid
        else:
            mid = (lat_interval[0] + lat_interval[1]) / 2
            if lat > mid:
                ch |= bits[bit]
                lat_interval[0] = mid
            else:
                lat_interval[1] = mid
        even = not even
        if bit < 4:
            bit += 1
        else:
            geohash.append(_GEOHASH_BASE32[ch])
            bit = 0
            ch = 0
    return "".join(geohash)


def _valid_coord(value: Mapping[str, Any]) -> tuple[float, float] | None:
    try:
        lat = float(value.get("lat"))
        lon = float(value.get("lon"))
    except Exception:
        return None
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None
    return lat, lon


def coarse_hash_from_route(route_coords: Iterable[Mapping[str, Any]] | None, precision: int = 5) -> str | None:
    if not route_coords:
        return None
    for coord in route_coords:
        if not isinstance(coord, Mapping):
            continue
        valid = _valid_coord(coord)
        if valid is None:
            continue
        lat, lon = valid
        return coarse_location_hash(lat, lon, precision=precision)
    return None

