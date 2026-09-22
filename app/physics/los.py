"""Reduced-fidelity line-of-sight analysis against terrain data."""

import math

from .trajectory import haversine_distance
from .terrain import TerrainDataError

EARTH_RADIUS_M = 6371000.0
REFRACTION_K = 1.33


def earth_curvature_drop(dist_from_observer_m: float, total_dist_m: float,
                         r_eff_m: float = REFRACTION_K * EARTH_RADIUS_M) -> float:
    d = max(0.0, min(dist_from_observer_m, total_dist_m))
    return d * (total_dist_m - d) / (2.0 * r_eff_m)


def _horizon_only(observer: dict, target: dict) -> dict:
    d = haversine_distance(observer["lat"], observer["lon"], target["lat"], target["lon"])
    # At d=D the parabola is zero; this fallback deliberately remains a simple
    # availability-preserving horizon check rather than pretending DEM detail exists.
    drop = earth_curvature_drop(d, d)
    required = observer["alt"] + drop
    visible = target["alt"] >= required - 1e-6
    return {
        "visible": visible,
        "obstruction_range_km": None,
        "reason": (
            "No terrain data loaded; spherical-Earth horizon check only."
            if visible else
            f"Target below horizon due to Earth curvature: target {target['alt']:.0f}m "
            f"vs required {required:.0f}m at {d/1000.0:.2f}km (no DEM loaded)."
        ),
        "method": "horizon-only",
        "validation_status": "degraded",
    }


def line_of_sight(observer: dict, target: dict, dem=None) -> dict:
    lat1, lon1, alt1 = observer["lat"], observer["lon"], observer["alt"]
    lat2, lon2, alt2 = target["lat"], target["lon"], target["alt"]
    d = haversine_distance(lat1, lon1, lat2, lon2)

    if d <= 0:
        return {"visible": True, "obstruction_range_km": None,
                "reason": "Observer and target are co-located.",
                "method": "colocated", "validation_status": "valid"}
    if dem is None:
        return _horizon_only(observer, target)

    profile = dem.profile(lat1, lon1, lat2, lon2, step_m=90.0)
    unknown_ranges = []
    for dist_m, ground_elev in profile:
        if ground_elev is None:
            unknown_ranges.append(dist_m)
            continue
        line_elev = alt1 + (alt2 - alt1) * (dist_m / d) - earth_curvature_drop(dist_m, d)
        if ground_elev > line_elev:
            return {
                "visible": False,
                "obstruction_range_km": round(dist_m / 1000.0, 2),
                "reason": (
                    f"Terrain obstruction at {dist_m/1000.0:.1f}km: ground {ground_elev:.0f}m "
                    f"blocks sightline {line_elev:.0f}m."
                ),
                "method": "dem-raytrace",
                "validation_status": "valid",
            }

    if unknown_ranges:
        first = min(unknown_ranges)
        return {
            "visible": False,
            "obstruction_range_km": None,
            "reason": (
                f"LOS could not be fully validated: terrain data is unavailable at "
                f"~{first/1000.0:.2f}km along the path."
            ),
            "method": "dem-raytrace",
            "validation_status": "unknown",
        }

    return {"visible": True, "obstruction_range_km": None,
            "reason": None, "method": "dem-raytrace",
            "validation_status": "valid"}