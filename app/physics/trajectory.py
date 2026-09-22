"""
Ballistic trajectory solvers (Amaran L3).

Closed-form point-mass kinematics in a vacuum plus an optional numerical
drag model (STRETCH GOAL, explicitly flagged). Gravity is constant g, the
Earth is treated as flat/inertial for the ballistic segment.

ILLUSTRATIVE PLACEHOLDER PARAMETERS
-----------------------------------
The muzzle velocity, max effective range and vehicle profiles used by this
service are illustrative values for a kinematics demo (generic field-
artillery class). They are NOT sourced from any real platform specification
and must not be used to represent an actual weapon system.
"""

import math

import numpy as np
from scipy.integrate import solve_ivp
from scipy.optimize import brentq

G = 9.80665  # Standard gravity (m/s^2)
R_EARTH = 6371000.0  # Mean Earth radius (m)

# Illustrative generic field-artillery class (NOT from a real platform spec).
MUZZLE_VELOCITY_MPS = 827.0  # Muzzle velocity (m/s)
MAX_RANGE_M = 30000.0  # Max effective range (m)

# Standard-atmosphere / projectile constants for the drag stretch-goal.
RHO_0 = 1.225  # Sea-level air density (kg/m^3)
H_SCALE = 8500.0  # Atmospheric scale height (m)
DEFAULT_CD = 0.15  # Drag coefficient (dimensionless)
DEFAULT_MASS = 43.0  # Mass of generic 155 mm projectile (kg)
DEFAULT_AREA = math.pi * (0.155 / 2.0) ** 2  # Cross-sectional area (m^2)


def haversine_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance between two lat/lon points in meters."""
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)

    a = (
        math.sin(delta_phi / 2.0) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2.0) ** 2
    )
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))
    return R_EARTH * c


def solve_vacuum_trajectory(d: float, h: float, v0: float) -> dict:
    """
    Analytically solve for launch angles in a vacuum.

    Parameters
    ----------
    d : horizontal distance to target (m)
    h : height difference, target_alt - origin_alt (m)
    v0 : muzzle velocity (m/s)

    Returns a dict with keys: feasible, low_angle_deg, high_angle_deg,
    time_of_flight_s, reachable_dist_m, reason.
    """
    if v0 <= 0:
        return {
            "feasible": False,
            "low_angle_deg": None,
            "high_angle_deg": None,
            "time_of_flight_s": None,
            "reachable_dist_m": None,
            "reason": "Muzzle velocity must be greater than zero.",
        }
    if d <= 0:
        return {
            "feasible": False,
            "low_angle_deg": None,
            "high_angle_deg": None,
            "time_of_flight_s": None,
            "reachable_dist_m": None,
            "reason": "Horizontal distance must be greater than zero.",
        }

    # Trajectory with constant gravity: derive from
    # h = d*tan(theta) - (g*d^2)/(2*v0^2*cos^2(theta)).
    # In T = tan(theta): A*T^2 + B*T + C = 0
    A = (G * d**2) / (2.0 * v0**2)
    B = -d
    C = h + A

    discriminant = B**2 - 4.0 * A * C

    if discriminant < 0:
        # Physical limit exceeded: target outside the vacuum ballistic envelope.
        max_range = (v0**2 / G) * math.sqrt(max(0.0, 1.0 - (2.0 * G * h) / v0**2))
        reason = (
            f"Target out of range. Max ballistic range for elevation difference "
            f"{h:.1f}m is {max_range / 1000.0:.2f} km. Target distance is {d / 1000.0:.2f} km."
        )
        return {
            "feasible": False,
            "low_angle_deg": None,
            "high_angle_deg": None,
            "time_of_flight_s": None,
            "reachable_dist_m": max_range,
            "reason": reason,
        }

    sqrt_disc = math.sqrt(discriminant)
    t1 = (-B + sqrt_disc) / (2.0 * A)  # high-angle solution (larger tan)
    t2 = (-B - sqrt_disc) / (2.0 * A)  # low-angle solution

    theta_high = math.atan(t1)
    theta_low = math.atan(t2)

    valid_angles = [
        th for th in (theta_low, theta_high) if 0.0 <= th <= math.pi / 2.0
    ]
    if not valid_angles:
        return {
            "feasible": False,
            "low_angle_deg": None,
            "high_angle_deg": None,
            "time_of_flight_s": None,
            "reachable_dist_m": None,
            "reason": "No feasible launch angle in the positive quadrant [0, 90] degrees.",
        }

    # Time of flight for the selected (low-angle) trajectory: t = d / (v0*cos).
    theta_selected = min(valid_angles)
    time_of_flight = d / (v0 * math.cos(theta_selected))

    return {
        "feasible": True,
        "low_angle_deg": math.degrees(theta_low),
        "high_angle_deg": math.degrees(theta_high),
        "time_of_flight_s": time_of_flight,
        "reachable_dist_m": d,
        "reason": None,
    }


def projectile_ode(t, y, Cd: float, mass: float, area: float):
    """
    ODE system for point-mass projectile motion with gravity and air drag.
    State vector y = [x, z, vx, vz].
    """
    x, z, vx, vz = y
    v = math.sqrt(vx**2 + vz**2)
    rho = RHO_0 * math.exp(-max(0.0, z) / H_SCALE)

    if v > 1e-6:
        a_drag = 0.5 * Cd * rho * area * v / mass
        ax = -a_drag * vx
        az = -G - a_drag * vz
    else:
        ax, az = 0.0, -G
    return [vx, vz, ax, az]


def solve_drag_trajectory(
    d: float,
    h: float,
    v0: float,
    Cd: float = DEFAULT_CD,
    mass: float = DEFAULT_MASS,
    area: float = DEFAULT_AREA,
) -> dict:
    """
    STRETCH GOAL (flagged): numerically solve the trajectory including
    atmospheric drag via a shooting method + Brent root finder.

    This is a deliberate fidelity upgrade over the vacuum solver; it is NOT a
    6-DOF flight model. No stability/control fin dynamics are modelled.
    """
    def hit_distance(t, y, *args):
        return y[0] - d
    hit_distance.terminal = True
    hit_distance.direction = 1

    def simulate_angle(theta_rad):
        vx0 = v0 * math.cos(theta_rad)
        vz0 = v0 * math.sin(theta_rad)
        y0 = [0.0, 0.0, vx0, vz0]
        t_span = (0.0, max(200.0, 2.0 * d / (v0 * math.cos(theta_rad) + 1e-3)))
        sol = solve_ivp(
            projectile_ode,
            t_span,
            y0,
            args=(Cd, mass, area),
            events=hit_distance,
            dense_output=False,
            rtol=1e-5,
            atol=1e-5,
        )
        if len(sol.y_events[0]) > 0:
            final_state = sol.y_events[0][0]
            return final_state[1], sol.t_events[0][0]
        return -999999.0, 0.0

    # Note: the ODE lives in a plane-parallel frame where z starts at 0 and
    # target drop is accounted by requiring final z = h. This matches the
    # vacuum solver convention (d horizontal, h = target_alt - origin_alt).
    def objective(theta_rad):
        z_at_d, _ = simulate_angle(theta_rad)
        return z_at_d - h

    def scan(angles):
        objs = []
        for a in angles:
            try:
                objs.append(objective(a))
            except Exception:
                objs.append(-999999.0)
        for i in range(len(objs) - 1):
            if objs[i] != -999999.0 and objs[i + 1] != -999999.0:
                if objs[i] * objs[i + 1] <= 0:
                    return angles[i], angles[i + 1]
        return None

    best_theta = None
    best_t = None
    bracket = scan(np.linspace(math.radians(1.0), math.radians(45.0), 10))
    if bracket is None:
        bracket = scan(np.linspace(math.radians(45.0), math.radians(85.0), 10))
    if bracket is not None:
        try:
            best_theta = brentq(objective, bracket[0], bracket[1], xtol=1e-5)
            _, best_t = simulate_angle(best_theta)
        except ValueError:
            pass

    if best_theta is not None:
        return {
            "feasible": True,
            "low_angle_deg": math.degrees(best_theta),
            "high_angle_deg": None,
            "time_of_flight_s": best_t,
            "reason": None,
        }
    return {
        "feasible": False,
        "low_angle_deg": None,
        "high_angle_deg": None,
        "time_of_flight_s": None,
        "reason": f"Target physically unreachable under atmospheric drag (Cd={Cd}).",
    }


def calculate_trajectory(
    origin: dict,
    target: dict,
    platform_ont_id: str,
    v0: float = MUZZLE_VELOCITY_MPS,
    max_range: float = MAX_RANGE_M,
    use_drag: bool = False,
) -> dict:
    """
    Main orchestrator for trajectory feasibility.

    Returns a dict with feasible, time_of_flight_s, intercept_point, notes,
    and platform_ont_id (echoed for the shared ontology join key).
    """
    lat1, lon1, alt1 = origin["lat"], origin["lon"], origin["alt"]
    lat2, lon2, alt2 = target["lat"], target["lon"], target["alt"]

    d = haversine_distance(lat1, lon1, lat2, lon2)
    h = alt2 - alt1

    notes = [
        f"Horizontal distance: {d/1000.0:.3f} km",
        f"Altitude difference: {h:.1f} m",
    ]

    if d > max_range:
        return {
            "feasible": False,
            "time_of_flight_s": 0.0,
            "intercept_point": {"lat": lat2, "lon": lon2, "alt": alt2},
            "platform_ont_id": platform_ont_id,
            "notes": (
                f"Horizontal range {d/1000.0:.2f} km exceeds maximum effective "
                f"range of {max_range/1000.0:.1f} km (platform {platform_ont_id})."
            ),
        }

    if use_drag:
        res = solve_drag_trajectory(d, h, v0)
        notes.append(
            "Simulation mode: Drag active (numerical integration, standard "
            "atmosphere, generic 155mm projectile) [STRETCH GOAL]"
        )
    else:
        res = solve_vacuum_trajectory(d, h, v0)
        notes.append("Simulation mode: Ballistic vacuum (analytic solver)")

    if res["feasible"]:
        notes.append(f"Launch Angle: {res['low_angle_deg']:.2f} degrees")
        if res["high_angle_deg"] is not None:
            notes.append(f"Alternative High-Angle Option: {res['high_angle_deg']:.2f} degrees")
        return {
            "feasible": True,
            "time_of_flight_s": res["time_of_flight_s"],
            "intercept_point": {"lat": lat2, "lon": lon2, "alt": alt2},
            "platform_ont_id": platform_ont_id,
            "notes": " | ".join(notes),
        }

    return {
        "feasible": False,
        "time_of_flight_s": 0.0,
        "intercept_point": {"lat": lat2, "lon": lon2, "alt": alt2},
        "platform_ont_id": platform_ont_id,
        "notes": f"{res['reason']} | " + " | ".join(notes),
    }