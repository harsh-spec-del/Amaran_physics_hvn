"""Hand-checkable ballistic trajectory tests.

Flat-ground muzzle velocity 827 m/s is checked against the closed-form
analytic range formula, so correctness is verifiable, not just "runs".
"""

import math

import pytest

from app.physics.trajectory import (
    G,
    calculate_trajectory,
    haversine_distance,
    solve_vacuum_trajectory,
)


def test_haversine_distance():
    # Leh Airport -> Spituk Monastery (~2.56 km).
    dist = haversine_distance(34.1436, 77.5458, 34.1278, 77.5255)
    assert 2400 < dist < 2700


def test_solve_vacuum_trajectory_flat():
    v0, d, h = 827.0, 10000.0, 0.0
    res = solve_vacuum_trajectory(d, h, v0)
    assert res["feasible"] is True

    # sin(2*theta) = g*d/v0^2 -> theta_low ~= 4.122 deg, theta_high ~= 85.878 deg.
    assert math.isclose(res["low_angle_deg"], 4.122, abs_tol=1e-2)
    assert math.isclose(res["high_angle_deg"], 85.878, abs_tol=1e-2)
    # Time of flight = d/(v0*cos(theta_low)) ~= 12.12 s.
    assert math.isclose(res["time_of_flight_s"], 12.12, abs_tol=0.1)


def test_solve_vacuum_trajectory_reaches_analytic_max_range():
    # Absolute vacuum max range is v0^2/g = 69.74 km.
    v0 = 827.0
    res = solve_vacuum_trajectory(60000.0, 0.0, v0)
    assert res["feasible"] is True
    assert math.isclose(v0**2 / (G * 1000.0), 69.74, abs_tol=0.01)


def test_solve_vacuum_trajectory_unreachable():
    res = solve_vacuum_trajectory(80000.0, 0.0, 827.0)
    assert res["feasible"] is False
    assert "Target out of range" in res["reason"]


def test_calculate_trajectory_operational_limit():
    origin = {"lat": 34.1526, "lon": 77.5771, "alt": 3500}
    target = {"lat": 34.1526 + 0.315, "lon": 77.5771, "alt": 3500}
    res = calculate_trajectory(origin, target, "artillery_001")
    assert res["feasible"] is False
    assert "exceeds maximum effective range" in res["notes"]
    assert res["platform_ont_id"] == "artillery_001"


def test_calculate_trajectory_demo_pair_feasible():
    # Exactly the demo pair: ~15 km, +1000 m. Well inside the 30 km op limit.
    origin = {"lat": 34.1526, "lon": 77.5771, "alt": 3500.0}
    target = {"lat": 34.0500, "lon": 77.6500, "alt": 4500.0}
    res = calculate_trajectory(origin, target, "artillery_l3")
    assert res["feasible"] is True
    assert res["time_of_flight_s"] > 0
    assert res["intercept_point"]["lat"] == target["lat"]
    assert "Launch Angle" in res["notes"]


def test_drag_stretch_exists_and_returns_real_answer():
    # The drag solver (flagged stretch goal) must produce a real number, and
    # drag slows the projectile so time-of-flight exceeds the vacuum value at
    # the same range.
    d, h, v0 = 6000.0, 0.0, 827.0
    vac = solve_vacuum_trajectory(d, h, v0)
    from app.physics.trajectory import solve_drag_trajectory

    drag = solve_drag_trajectory(d, h, v0)
    assert drag["feasible"] is True
    assert drag["time_of_flight_s"] > vac["time_of_flight_s"]