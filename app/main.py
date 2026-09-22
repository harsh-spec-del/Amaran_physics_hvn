"""Amaran Layer 3 Physics Simulation Service."""

import math
import os
from typing import List, Literal, Optional

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator

from app.physics import los as los_mod
from app.physics import route as route_mod
from app.physics import terrain as terrain_mod
from app.physics.trajectory import calculate_trajectory

app = FastAPI(
    title="Amaran Layer 3 Physics Simulation Service",
    description="Physical-feasibility validation with terrain-aware diagnostics.",
    version="1.2.0",
)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
TILE_STORE = terrain_mod.TileStore()

# Optional cross-layer link to the L2 Digital Twin's ontology (a separate
# app, not always running). When it *is* running locally we can confirm a
# platform_ont_id actually refers to a real twin instead of trusting
# whatever string was typed into the form — same shared ID namespace, two
# different consoles. See amaran-os-digital-twin/docs/CROSS_LAYER_INTEGRATION.md
# for the fuller design this is one slice of.
DIGITAL_TWIN_URL = os.environ.get("AMARAN_DIGITAL_TWIN_URL", "http://127.0.0.1:8420")
_ONTOLOGY_TIMEOUT_S = 0.4


def resolve_platform_ontology(ont_id: str) -> Optional[dict]:
    """Best-effort lookup against the digital twin's live ontology. Returns
    None (never raises) if that service isn't reachable — the two layers
    are independent apps and physics validation must not depend on the
    twin console being open."""
    try:
        with httpx.Client(timeout=_ONTOLOGY_TIMEOUT_S) as client:
            r = client.get(f"{DIGITAL_TWIN_URL}/ontology/resolve/{ont_id}")
            if r.status_code == 200:
                data = r.json()
                return data if data.get("found") else None
    except httpx.HTTPError:
        pass
    return None


class Coordinate3D(BaseModel):
    lat: float = Field(..., ge=-90, le=90)
    lon: float = Field(..., ge=-180, le=180)
    alt: float = Field(..., ge=-11000, le=100000)

class Coordinate2D(BaseModel):
    lat: float = Field(..., ge=-90, le=90)
    lon: float = Field(..., ge=-180, le=180)

class TrajectoryRequest(BaseModel):
    origin: Coordinate3D
    target: Coordinate3D
    platform_ont_id: str = Field(..., min_length=1, max_length=256)

class TrajectoryResponse(BaseModel):
    feasible: bool
    time_of_flight_s: float
    intercept_point: Coordinate3D
    platform_ont_id: str
    platform_verified: bool = False
    platform_label: Optional[str] = None
    notes: str

class LineOfSightRequest(BaseModel):
    observer: Coordinate3D
    target: Coordinate3D

class LineOfSightResponse(BaseModel):
    visible: bool
    obstruction_range_km: Optional[float] = None
    method: str
    reason: Optional[str] = None
    validation_status: Literal["valid", "degraded", "unknown"] = "valid"

class Waypoint(Coordinate2D):
    ont_id: Optional[str] = Field(default=None, max_length=256)

class RouteValidateRequest(BaseModel):
    waypoints: List[Waypoint] = Field(..., min_length=2, max_length=500)
    vehicle_type: str = Field(..., min_length=1, max_length=64)
    terrain_source: Literal["srtm"] = "srtm"
    @field_validator("vehicle_type")
    @classmethod
    def normalize_vehicle(cls, value: str) -> str:
        return value.strip().lower()

class ConstraintViolation(BaseModel):
    reason: str
    leg: int
    slope_deg: Optional[float] = None
    max_allowed_deg: Optional[float] = None
    distance_km: Optional[float] = None

class ElevationPoint(BaseModel):
    distance_km: float
    elevation_m: float

class RouteValidateResponse(BaseModel):
    feasible: bool
    validation_status: Literal["valid", "violations", "unknown", "invalid"]
    eta_hours: float
    distance_km: float
    constraints_violated: List[ConstraintViolation]
    vehicle_type: str
    ont_ids: List[Optional[str]]
    elevation_profile: List[ElevationPoint] = Field(default_factory=list)

class TerrainMeshRequest(BaseModel):
    center_lat: float = Field(..., ge=-89.9, le=89.9)
    center_lon: float = Field(..., ge=-180, le=180)
    width_km: float = Field(45, gt=1, le=500)
    height_km: float = Field(45, gt=1, le=500)
    resolution: int = Field(32, ge=8, le=80)

class TerrainMeshResponse(BaseModel):
    center_lat: float
    center_lon: float
    width_km: float
    height_km: float
    resolution: int
    elevations_m: List[Optional[float]]
    source_tiles: List[str]
    degraded: bool

class HealthResponse(BaseModel):
    status: str
    srtm_loaded: bool
    tiles: List[str]

def default_dem():
    return TILE_STORE

@app.post("/api/v1/physics/trajectory", response_model=TrajectoryResponse)
def post_trajectory(req: TrajectoryRequest, use_drag: bool = False):
    try:
        res = calculate_trajectory(origin=req.origin.model_dump(), target=req.target.model_dump(), platform_ont_id=req.platform_ont_id, use_drag=use_drag)
        ontology = resolve_platform_ontology(req.platform_ont_id)
        return TrajectoryResponse(
            feasible=res["feasible"], time_of_flight_s=res["time_of_flight_s"],
            intercept_point=Coordinate3D(**res["intercept_point"]), platform_ont_id=res["platform_ont_id"],
            platform_verified=ontology is not None, platform_label=ontology["label"] if ontology else None,
            notes=res["notes"],
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Trajectory calculation error: {exc}") from exc

@app.post("/api/v1/physics/line-of-sight", response_model=LineOfSightResponse)
def post_line_of_sight(req: LineOfSightRequest):
    try:
        return LineOfSightResponse(**los_mod.line_of_sight(req.observer.model_dump(), req.target.model_dump(), dem=default_dem()))
    except terrain_mod.TerrainDataError as exc:
        return LineOfSightResponse(visible=False, obstruction_range_km=None, method="terrain-unavailable", reason=str(exc), validation_status="unknown")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"LOS calculation error: {exc}") from exc

@app.post("/api/v1/physics/route-validate", response_model=RouteValidateResponse)
def post_route_validate(req: RouteValidateRequest):
    try:
        result = route_mod.validate_route([w.model_dump() for w in req.waypoints], req.vehicle_type, dem=default_dem())
        return RouteValidateResponse(feasible=result["feasible"], validation_status=result["validation_status"], eta_hours=result["eta_hours"], distance_km=result["distance_km"], constraints_violated=[ConstraintViolation(**v) for v in result["constraints_violated"]], vehicle_type=req.vehicle_type, ont_ids=[w.ont_id for w in req.waypoints], elevation_profile=[ElevationPoint(**p) for p in result["elevation_profile"]])
    except terrain_mod.TerrainLoadError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Route validation error: {exc}") from exc

@app.post("/api/v1/physics/terrain-mesh", response_model=TerrainMeshResponse)
def post_terrain_mesh(req: TerrainMeshRequest):
    """Return a regular DEM grid for visualization; no physics decision is performed here."""
    lat_km = req.height_km / 111.32
    lon_km = req.width_km / max(111.32 * math.cos(math.radians(req.center_lat)), 1e-6)
    lat_min, lat_max = req.center_lat - lat_km / 2, req.center_lat + lat_km / 2
    lon_min, lon_max = req.center_lon - lon_km / 2, req.center_lon + lon_km / 2
    elevations: list[Optional[float]] = []
    source_tiles: set[str] = set()
    degraded = False
    for iy in range(req.resolution):
        lat = lat_max - (lat_max - lat_min) * iy / max(1, req.resolution - 1)
        for ix in range(req.resolution):
            lon = lon_min + (lon_max - lon_min) * ix / max(1, req.resolution - 1)
            try:
                dem = TILE_STORE.dem_for(lat, lon)
                value = dem.elevation_at(lat, lon)
                elevations.append(float(value))
                source_tiles.add(str(dem.source))
            except terrain_mod.TerrainDataError:
                elevations.append(None)
                degraded = True
    return TerrainMeshResponse(center_lat=req.center_lat, center_lon=req.center_lon, width_km=req.width_km, height_km=req.height_km, resolution=req.resolution, elevations_m=elevations, source_tiles=sorted(source_tiles), degraded=degraded)

@app.get("/api/v1/physics/health", response_model=HealthResponse)
def get_health():
    tiles = TILE_STORE.tiles_available()
    return HealthResponse(status="ok", srtm_loaded=bool(tiles), tiles=tiles)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host="127.0.0.1", port=8000, reload=True)
