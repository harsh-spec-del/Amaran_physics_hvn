"""Route feasibility tests (slope constraints per vehicle_type)."""

import math

import pytest

from app.physics.route import validate_route
from app.physics.terrain import TerrainLoadError


def test_ramp_slope_violates_wheeled_logistics(ramp_dem):
    waypoints = [
        {"lat": 34.000, "lon": 77.02},
        {"lat": 34.050, "lon": 77.02},
    ]
    res = validate_route(waypoints, "wheeled_logistics", dem=ramp_dem)
    assert res["feasible"] is False
    assert res["validation_status"] == "violations"
    assert len(res["constraints_violated"]) == 1
    entry = res["constraints_violated"][0]
    assert entry["leg"] == 1
    assert entry["slope_deg"] == pytest.approx(math.degrees(math.atan(0.3)), abs=0.2)
    assert entry["max_allowed_deg"] == 15.0
    assert "exceeds max allowed 15.0 deg for wheeled_logistics" in entry["reason"]


def test_flat_route_is_feasible(flat_dem):
    waypoints = [
        {"lat": 34.05, "lon": 77.05},
        {"lat": 34.05, "lon": 77.06},
        {"lat": 34.05, "lon": 77.07},
    ]
    res = validate_route(waypoints, "wheeled_logistics", dem=flat_dem)
    assert res["feasible"] is True
    assert res["validation_status"] == "valid"
    assert res["constraints_violated"] == []
    assert res["eta_hours"] > 0
    assert res["distance_km"] > 0
    assert res["elevation_profile"]


def test_downhill_slope_is_treated_symmetrically(ramp_dem):
    waypoints = [
        {"lat": 34.050, "lon": 77.02},
        {"lat": 34.000, "lon": 77.02},
    ]
    res = validate_route(waypoints, "wheeled_logistics", dem=ramp_dem)
    assert res["feasible"] is False
    assert res["constraints_violated"][0]["slope_deg"] == pytest.approx(math.degrees(math.atan(0.3)), abs=0.2)


def test_no_dem_is_unknown_not_silently_feasible():
    waypoints = [
        {"lat": 34.05, "lon": 77.05},
        {"lat": 34.06, "lon": 77.06},
    ]
    res = validate_route(waypoints, "wheeled_logistics", dem=None)
    assert res["feasible"] is False
    assert res["validation_status"] == "unknown"
    assert "terrain elevation data is not available" in res["constraints_violated"][0]["reason"]
    assert res["eta_hours"] > 0


def test_unknown_vehicle_type_raises(flat_dem):
    waypoints = [{"lat": 34.05, "lon": 77.05}, {"lat": 34.06, "lon": 77.06}]
    with pytest.raises(TerrainLoadError):
        validate_route(waypoints, "hovercraft", dem=flat_dem)


def test_single_waypoint_unvalidatable(flat_dem):
    res = validate_route([{"lat": 34.05, "lon": 77.05}], "wheeled_logistics", dem=flat_dem)
    assert res["feasible"] is False
    assert res["validation_status"] == "invalid"
    assert "at least two waypoints" in res["constraints_violated"][0]["reason"]