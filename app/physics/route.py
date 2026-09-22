"""Terrain-constrained route feasibility for Amaran L3."""

import math

from .terrain import TerrainDataError
from .trajectory import haversine_distance

VEHICLE_PROFILES = {
    "wheeled_logistics": {"max_slope_deg": 15.0, "cruise_speed_kmh": 40.0},
    "tracked_utility": {"max_slope_deg": 30.0, "cruise_speed_kmh": 25.0},
    "motor_convoy": {"max_slope_deg": 10.0, "cruise_speed_kmh": 60.0},
}


def vehicle_profile(vehicle_type: str) -> dict:
    try:
        return VEHICLE_PROFILES[vehicle_type.strip().lower()]
    except (KeyError, AttributeError):
        raise TerrainDataError(
            f"Unknown vehicle_type {vehicle_type!r}. Known: "
            + ", ".join(sorted(VEHICLE_PROFILES))
        )


def validate_route(waypoints: list, vehicle_type: str, dem) -> dict:
    profile = vehicle_profile(vehicle_type)
    max_slope = profile["max_slope_deg"]
    cruise = profile["cruise_speed_kmh"]

    if len(waypoints) < 2:
        return {
            "feasible": False,
            "validation_status": "invalid",
            "eta_hours": 0.0,
            "distance_km": 0.0,
            "constraints_violated": [{"reason": "Route requires at least two waypoints.", "leg": 0}],
            "elevation_profile": [],
        }

    violations = []
    profile_points = []
    total_dist = 0.0
    data_unknown = False

    for i in range(len(waypoints) - 1):
        p0, p1 = waypoints[i], waypoints[i + 1]
        d = haversine_distance(p0["lat"], p0["lon"], p1["lat"], p1["lon"])
        leg = i + 1
        total_dist += d
        if d <= 0:
            continue

        if dem is None:
            data_unknown = True
            violations.append({
                "reason": f"Leg {leg}: terrain elevation data is not available; slope constraint cannot be validated.",
                "leg": leg,
                "distance_km": round(d / 1000.0, 2),
            })
            continue

        try:
            samples = dem.profile(p0["lat"], p0["lon"], p1["lat"], p1["lon"], step_m=90.0)
        except TerrainDataError as exc:
            data_unknown = True
            violations.append({"reason": f"Leg {leg}: {exc}", "leg": leg,
                               "distance_km": round(d / 1000.0, 2)})
            continue

        steepest_abs = 0.0
        steepest_at = 0.0
        unknown = False
        for k, (x, elev) in enumerate(samples):
            if elev is None:
                unknown = True
                data_unknown = True
                continue
            profile_points.append({"distance_km": round((total_dist - d + x) / 1000.0, 3),
                                   "elevation_m": round(elev, 1)})
            if k == 0:
                continue
            x_prev, e_prev = samples[k - 1]
            if e_prev is None:
                unknown = True
                data_unknown = True
                continue
            step = x - x_prev
            if step <= 0:
                continue
            angle = math.degrees(math.atan2(elev - e_prev, step))
            if abs(angle) > steepest_abs:
                steepest_abs = abs(angle)
                steepest_at = x

        if unknown:
            violations.append({
                "reason": f"Leg {leg}: terrain data is incomplete; slope validation is uncertain.",
                "leg": leg,
                "distance_km": round(d / 1000.0, 2),
            })
        elif steepest_abs > max_slope:
            violations.append({
                "reason": f"Leg {leg}: maximum absolute slope {steepest_abs:.1f} deg at ~{steepest_at/1000.0:.2f}km "
                           f"exceeds max allowed {max_slope:.1f} deg for {vehicle_type}.",
                "leg": leg,
                "slope_deg": round(steepest_abs, 1),
                "max_allowed_deg": max_slope,
                "distance_km": round(d / 1000.0, 2),
            })

    if data_unknown:
        validation_status = "unknown"
    elif violations:
        validation_status = "violations"
    else:
        validation_status = "valid"

    return {
        "feasible": len(violations) == 0 and not data_unknown,
        "validation_status": validation_status,
        "eta_hours": round(total_dist / 1000.0 / cruise if cruise > 0 else 0.0, 2),
        "distance_km": round(total_dist / 1000.0, 2),
        "constraints_violated": violations,
        "elevation_profile": _downsample_profile(profile_points, 240),
        "vehicle_type": vehicle_type,
    }


def _downsample_profile(points: list[dict], limit: int) -> list[dict]:
    if len(points) <= limit:
        return points
    stride = (len(points) - 1) / (limit - 1)
    return [points[round(i * stride)] for i in range(limit)]