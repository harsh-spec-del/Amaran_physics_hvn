"""Line-of-sight tests against a synthetic ridge DEM."""

import pytest

from app.physics import los
from app.physics.terrain import DEM
from app.physics.trajectory import haversine_distance


def test_los_blocked_by_ridge(ridge_dem):
    # Observer south of the ridge band [34.30, 34.40], target north of it.
    # Ridge elevation (4500 m) exceeds the sightline (~3400 m) so it must block.
    observer = {"lat": 34.05, "lon": 77.10, "alt": 3200.0}
    target = {"lat": 34.65, "lon": 77.10, "alt": 3400.0}
    result = los.line_of_sight(observer, target, dem=ridge_dem)
    assert result["visible"] is False
    assert result["obstruction_range_km"] is not None
    assert result["obstruction_range_km"] > 0
    assert "obstruction" in result["reason"].lower()


def test_los_clear_over_flat_terrain(flat_dem):
    observer = {"lat": 34.05, "lon": 77.05, "alt": 3200.0}
    target = {"lat": 34.20, "lon": 77.05, "alt": 3400.0}
    result = los.line_of_sight(observer, target, dem=flat_dem)
    assert result["visible"] is True
    assert result["obstruction_range_km"] is None


def test_los_horizon_only_degradation_no_dem():
    # No DEM -> spherical-Earth horizon check still computes a real answer.
    observer = {"lat": 34.1526, "lon": 77.5771, "alt": 3500.0}
    target = {"lat": 34.0000, "lon": 77.6500, "alt": 4500.0}
    result = los.line_of_sight(observer, target, dem=None)
    assert result["method"] == "horizon-only"
    # At ~17 km the required altitude is ~3500 + d^2/(2*R_eff) ~= 3522 m, so a
    # 4500 m target is comfortably above the horizon.
    assert result["visible"] is True


def test_earth_curvature_drop_midpoint():
    # drop(d, D) at the midpoint d = D/2 is D^2/(8*R_eff).
    D = 20_000.0
    expected = D**2 / (8.0 * los.REFRACTION_K * los.EARTH_RADIUS_M)
    assert los.earth_curvature_drop(D / 2, D) == pytest.approx(expected, rel=1e-9)