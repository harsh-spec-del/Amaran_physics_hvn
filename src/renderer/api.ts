export const API_BASE =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://127.0.0.1:8000';

export interface Coordinate3D { lat: number; lon: number; alt: number; }
export interface Coordinate2D { lat: number; lon: number; ont_id?: string; }
export interface TrajectoryRequest { origin: Coordinate3D; target: Coordinate3D; platform_ont_id: string; }
export interface TrajectoryResponse { feasible: boolean; time_of_flight_s: number; intercept_point: Coordinate3D; platform_ont_id: string; platform_verified?: boolean; platform_label?: string | null; notes: string; }
export interface LosRequest { observer: Coordinate3D; target: Coordinate3D; }
export interface LosResponse { visible: boolean; obstruction_range_km: number | null; method: string; reason: string | null; validation_status: 'valid' | 'degraded' | 'unknown'; }
export interface RouteRequest { waypoints: Coordinate2D[]; vehicle_type: string; terrain_source?: 'srtm'; }
export interface ConstraintViolation { reason: string; leg: number; slope_deg?: number; max_allowed_deg?: number; distance_km?: number; }
export interface ElevationPoint { distance_km: number; elevation_m: number; }
export interface RouteResponse { feasible: boolean; validation_status: 'valid' | 'violations' | 'unknown' | 'invalid'; eta_hours: number; distance_km: number; constraints_violated: ConstraintViolation[]; vehicle_type: string; ont_ids: (string | null)[]; elevation_profile: ElevationPoint[]; }
export interface HealthResponse { status: string; srtm_loaded: boolean; tiles: string[]; }
export interface TerrainMeshRequest { center_lat: number; center_lon: number; width_km?: number; height_km?: number; resolution?: number; }
export interface TerrainMeshResponse { center_lat: number; center_lon: number; width_km: number; height_km: number; resolution: number; elevations_m: (number | null)[]; source_tiles: string[]; degraded: boolean; }

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { const data = await res.json(); if (typeof data.detail === 'string') detail = data.detail; else if (Array.isArray(data.detail)) detail = data.detail.map((e: { msg?: string }) => e.msg ?? '').filter(Boolean).join('; '); } catch { /* keep status */ }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}
export function runTrajectory(req: TrajectoryRequest): Promise<TrajectoryResponse> { return post('/api/v1/physics/trajectory', req); }
export function runLos(req: LosRequest): Promise<LosResponse> { return post('/api/v1/physics/line-of-sight', req); }
export function runRoute(req: RouteRequest): Promise<RouteResponse> { return post('/api/v1/physics/route-validate', req); }
export function getTerrainMesh(req: TerrainMeshRequest): Promise<TerrainMeshResponse> { return post('/api/v1/physics/terrain-mesh', req); }
export async function getHealth(): Promise<HealthResponse> { const res = await fetch(`${API_BASE}/api/v1/physics/health`); if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json() as Promise<HealthResponse>; }
export type LogEntry = { id: number; title: string; ok: boolean; detail: string; };
