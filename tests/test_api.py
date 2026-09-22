"""End-to-end API contract tests via FastAPI TestClient."""

from fastapi.testclient import TestClient

from app.main import app
from tests.conftest import make_flat_dem, make_ridge_dem

client = TestClient(app)

DEMO_ORIGIN = {"lat": 34.1526, "lon": 77.5771, "alt": 3500.0}
DEMO_TARGET = {"lat": 34.05, "lon": 77.65, "alt": 4500.0}


def test_health_endpoint():
    resp = client.get("/api/v1/physics/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert isinstance(body["srtm_loaded"], bool)
    assert isinstance(body["tiles"], list)


def test_coordinate_bounds_are_validated():
    resp = client.post("/api/v1/physics/trajectory", json={
        "origin": {"lat": 91, "lon": 0, "alt": 0},
        "target": DEMO_TARGET,
        "platform_ont_id": "demo",
    })
    assert resp.status_code == 422


def test_trajectory_endpoint_success():
    resp = client.post("/api/v1/physics/trajectory", json={
        "origin": DEMO_ORIGIN,
        "target": DEMO_TARGET,
        "platform_ont_id": "artillery_l3",
    })
    assert resp.status_code == 200
    body = resp.json()
    assert body["feasible"] is True
    assert body["time_of_flight_s"] > 0
    assert body["platform_ont_id"] == "artillery_l3"
    assert body["intercept_point"]["lat"] == DEMO_TARGET["lat"]
    assert "Horizontal distance" in body["notes"]


def test_trajectory_endpoint_missing_field_is_422():
    resp = client.post("/api/v1/physics/trajectory", json={"origin": DEMO_ORIGIN, "platform_ont_id": "demo"})
    assert resp.status_code == 422


def test_los_endpoint_blocked(monkeypatch):
    monkeypatch.setattr("app.main.default_dem", lambda: make_ridge_dem())
    resp = client.post("/api/v1/physics/line-of-sight", json={
        "observer": {"lat": 34.05, "lon": 77.10, "alt": 3200.0},
        "target": {"lat": 34.65, "lon": 77.10, "alt": 3400.0},
    })
    assert resp.status_code == 200
    body = resp.json()
    assert body["visible"] is False
    assert body["validation_status"] == "valid"
    assert body["obstruction_range_km"] is not None
    assert body["reason"]


def test_los_endpoint_clear(monkeypatch):
    monkeypatch.setattr("app.main.default_dem", lambda: make_flat_dem())
    resp = client.post("/api/v1/physics/line-of-sight", json={
        "observer": {"lat": 34.1526, "lon": 77.5771, "alt": 3500.0},
        "target": {"lat": 34.1000, "lon": 77.6000, "alt": 4100.0},
    })
    assert resp.status_code == 200
    body = resp.json()
    assert body["visible"] is True
    assert body["validation_status"] == "valid"


def test_route_endpoint_feasible(monkeypatch):
    monkeypatch.setattr("app.main.default_dem", lambda: make_flat_dem())
    resp = client.post("/api/v1/physics/route-validate", json={
        "waypoints": [
            {"lat": 34.1526, "lon": 77.5771, "ont_id": "wp_1"},
            {"lat": 34.1000, "lon": 77.6000},
        ],
        "vehicle_type": "wheeled_logistics",
        "terrain_source": "srtm",
    })
    assert resp.status_code == 200
    body = resp.json()
    assert body["feasible"] is True
    assert body["validation_status"] == "valid"
    assert body["constraints_violated"] == []
    assert body["elevation_profile"]
    assert body["vehicle_type"] == "wheeled_logistics"
    assert body["ont_ids"] == ["wp_1", None]


def test_route_endpoint_unknown_vehicle_400():
    resp = client.post("/api/v1/physics/route-validate", json={
        "waypoints": [
            {"lat": 34.1526, "lon": 77.5771},
            {"lat": 34.1000, "lon": 77.6000},
        ],
        "vehicle_type": "spaceship",
        "terrain_source": "srtm",
    })
    assert resp.status_code == 400
    assert "Unknown vehicle_type" in resp.json()["detail"]
