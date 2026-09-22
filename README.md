# Amaran L3 — Physics Simulation Service

Layer 3 of **Amaran**. This service is an independently runnable FastAPI + Electron/React application for reduced-fidelity physical-feasibility analysis.

## Architecture

```text
Electron / React
       │
       ▼
    FastAPI
       │
       ├── trajectory.py  → analytic point-mass trajectory model
       ├── los.py         → DEM-aware visibility check
       ├── route.py       → terrain slope validation + profile
       └── terrain.py     → SRTM / DEM loading, interpolation, profiling
```

The physics modules remain independent of FastAPI so they are unit-testable and reusable. `ont_id` remains the cross-layer join key.

## What is modeled

| Capability | Model | Notes |
|---|---|---|
| Trajectory | Closed-form point-mass model | Existing model retained; illustrative parameters only |
| Optional drag | Numerical point-mass ODE | Reduced-order demonstration, not a flight model |
| LOS | DEM profile + curvature correction | Explicit `valid`, `degraded`, and `unknown` data states |
| Terrain | SRTM `.hgt` + rasterio DEM support | Independent latitude/longitude resolution; nodata is never treated as sea level |
| Route | Per-leg absolute slope check | Returns a downsampled elevation profile for visualization |

## Backend

Create the virtual environment and install dependencies once:

```bash
python -m venv .venv
.venv\\Scripts\\activate
pip install -r requirements.txt
```

The Electron application **starts the local backend automatically when it opens**. It first checks whether a healthy service already exists on `127.0.0.1:8000`, otherwise it starts it and waits for health, then opens the window. The backend is also stopped with the application when Electron owns the process.

**Packaged builds are now fully standalone**, matching the other four Amaran OS apps: the backend is bundled as a PyInstaller executable (`scripts/build_backend.py` → `backend-dist/amaran-physics-backend[.exe]`, shipped as an Electron `extraResource` at `resources/backend/`) — no separate Python runtime needs to be installed on the machine running the packaged app. `src/main/main.ts` prefers this bundled executable when `app.isPackaged`, and only falls back to spawning a system/venv Python interpreter in dev mode (or if a packaged build somehow ships without the bundled executable, which shouldn't happen but fails toward the old behavior rather than refusing to start).

To build and package locally:

```bash
pip install -r requirements.txt pyinstaller
python scripts/build_backend.py      # -> backend-dist/amaran-physics-backend[.exe]
npm install
npm run build                        # tsc + vite build
npm run package                      # electron-builder, bundles backend-dist/ as a resource
```

**DEM data directory for packaged installs**: the bundled executable's own file location is a temp extraction path recreated on every launch, so `main.ts` points `AMARAN_DATA_DIR` at a persistent location instead — `app.getPath('userData')/dem-data` (e.g. `~/.config/AmaranPhysics/dem-data` on Linux, `%APPDATA%\AmaranPhysics\dem-data` on Windows). Fetch/copy SRTM tiles into *that* directory for a packaged install, not into the repo's `app/data/` (which only applies in dev mode, running from source).

### Demo terrain data

`app/data/` ships empty (no SRTM tiles committed). Before a live demo, fetch
the tile that covers wherever the current demo incident actually is —
for KAVACH's "Contact at Gurez Sector" narrative that's:

```bash
python scripts/fetch_srtm.py N34E074
```

Without it, `/health` reports `srtm_loaded: false` and route/line-of-sight
validation returns `unknown`/infeasible on terrain grounds — which is a
correct, honest response given no elevation data is loaded, not a bug.
That's also exactly what you'll see in any environment (including this
one) where `srtm.kurviger.de` isn't reachable. Check
`app.physics.terrain.srtm_tile_name(lat, lon)` if the demo location ever
moves again, rather than assuming N34E074 stays correct.

Development:

```bash
npm install
npm run electron:dev
```


## API

```text
POST /api/v1/physics/trajectory
POST /api/v1/physics/line-of-sight
POST /api/v1/physics/route-validate
GET  /api/v1/physics/health
```

Coordinates are validated at the API boundary. Route responses include `validation_status` and a bounded `elevation_profile` suitable for UI charts. LOS responses distinguish a genuine obstruction from incomplete terrain data.

## UI visualization

The Scenario Console now includes:

- scenario geometry view for origin, target, and route waypoints;
- route elevation profile with sampled terrain points;
- service/DEM health indicators;
- persistent decision-trace entries for validation explanations;
- compact result metrics for trajectory, LOS, and route operations.

The UI continues to use the existing Amaran dark command-console design system.

## Tests

```bash
pytest
```

The test suite uses synthetic flat, ridge, and ramp DEMs so it can run offline. It covers interpolation, tile naming, nodata behavior, LOS obstruction/degradation, route slope validation, API response shapes, and coordinate bounds.

## Known engineering limits

The system is intentionally reduced fidelity. Terrain resolution and sampling limit what can be inferred from a DEM, and route ETA is a nominal distance/speed estimate. Missing terrain produces an `unknown` validation state rather than silently assuming an elevation.
