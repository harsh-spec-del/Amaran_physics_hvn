import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './styles/global.css';
import './styles/visual-console.css';

import {
  Coordinate2D,
  Coordinate3D,
  HealthResponse,
  LogEntry,
  LosResponse,
  RouteResponse,
  TrajectoryResponse,
  getHealth,
  runLos,
  runRoute,
  runTrajectory,
} from './api';
import { publishScene, registerSceneEditHandler } from './sceneStore';

const DEMO_ORIGIN: Coordinate3D = { lat: 34.1526, lon: 77.5771, alt: 3500 };
const DEMO_TARGET: Coordinate3D = { lat: 34.05, lon: 77.65, alt: 4500 };

type RunKind = 'trajectory' | 'los' | 'route' | null;
type ViewKey = 'scenario' | 'entities' | 'sandbox';
type TheaterLayer = 'route' | 'los' | 'trajectory' | 'terrain';
type Entity = {
  id: string;
  type: string;
  label: string;
  lat: number;
  lon: number;
  alt?: number;
  status: string;
  source: string;
};
type VisualParams = {
  verticalScale: number;
  arcBias: number;
  terrainLift: number;
};

type Point2 = { x: number; y: number };

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const lat = ((a.lat + b.lat) / 2) * Math.PI / 180;
  const dx = (b.lon - a.lon) * 111 * Math.cos(lat);
  const dy = (b.lat - a.lat) * 111;
  return Math.sqrt(dx * dx + dy * dy);
}
function lonLatToWorld(lat: number, lon: number, zoom: number) {
  const scale = 256 * 2 ** zoom;
  const sinLat = clamp(Math.sin((lat * Math.PI) / 180), -0.9999, 0.9999);
  return {
    x: ((lon + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale,
  };
}
function worldToLonLat(x: number, y: number, zoom: number) {
  const scale = 256 * 2 ** zoom;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  return {
    lon: (x / scale) * 360 - 180,
    lat: (180 / Math.PI) * Math.atan(Math.sinh(n)),
  };
}
function Panel({ title, children, className = '' }: { title: string; children: React.ReactNode; className?: string }) {
  return <section className={`panel ${className}`.trim()}><div className="panel-heading"><h3 className="panel-title">{title}</h3><span className="panel-rule" /></div>{children}</section>;
}
function Metric({ label, value, meta }: { label: string; value: string; meta?: string }) {
  return <div className="metric"><span className="metric-label">{label}</span><strong className="metric-value">{value}</strong>{meta && <span className="metric-meta">{meta}</span>}</div>;
}
function StatusPill({ status, label }: { status: 'ok' | 'warn' | 'error'; label: string }) {
  return <span className={`status-pill ${status}`}><span className="pill-dot" />{label}</span>;
}
function NumField({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return <label className="field"><span className="field-label">{label}</span><input className="field-input" type="number" step="any" value={Number.isFinite(value) ? value : ''} onChange={(e) => onChange(e.target.value === '' ? Number.NaN : Number(e.target.value))} /></label>;
}

function UnifiedTheater({
  origin,
  target,
  losObserver,
  losTarget,
  waypoints,
  trajectoryResult,
  routeResult,
  losResult,
  layers,
  params,
  playing,
  onTogglePlay,
  selectedEntity,
  onSelectWaypoint,
  onAddWaypoint,
  onDeleteWaypoint,
}: {
  origin: Coordinate3D;
  target: Coordinate3D;
  losObserver: Coordinate3D;
  losTarget: Coordinate3D;
  waypoints: Coordinate2D[];
  trajectoryResult: TrajectoryResponse | null;
  routeResult: RouteResponse | null;
  losResult: LosResponse | null;
  layers: Record<TheaterLayer, boolean>;
  params: VisualParams;
  playing: boolean;
  onTogglePlay: () => void;
  selectedEntity: string | null;
  onSelectWaypoint: (index: number) => void;
  onAddWaypoint: (point: Coordinate2D) => void;
  onDeleteWaypoint: (index: number) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);
  const [size, setSize] = useState({ width: 1200, height: 660 });
  const [zoom, setZoom] = useState(12);
  const [center, setCenter] = useState(() => lonLatToWorld(34.11, 77.61, 12));
  const [cursor, setCursor] = useState<{ lat: number; lon: number } | null>(null);
  const [orbit, setOrbit] = useState({ yaw: 0, pitch: 0.42 });
  const [progress, setProgress] = useState(0.18);

  const mapPoints = useMemo(() => [origin, target, losObserver, losTarget, ...waypoints], [origin, target, losObserver, losTarget, waypoints]);
  const fitScene = useCallback(() => {
    const valid = mapPoints.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
    if (!valid.length) return;
    let bestZoom = 12;
    for (let candidate = 16; candidate >= 7; candidate -= 1) {
      const pts = valid.map((p) => lonLatToWorld(p.lat, p.lon, candidate));
      const dx = Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x));
      const dy = Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y));
      if (dx < size.width * 0.62 && dy < size.height * 0.52) { bestZoom = candidate; break; }
    }
    const pts = valid.map((p) => lonLatToWorld(p.lat, p.lon, bestZoom));
    setZoom(bestZoom);
    setCenter({
      x: (Math.min(...pts.map((p) => p.x)) + Math.max(...pts.map((p) => p.x))) / 2,
      y: (Math.min(...pts.map((p) => p.y)) + Math.max(...pts.map((p) => p.y))) / 2,
    });
  }, [mapPoints, size.width, size.height]);

  useEffect(() => {
    const node = hostRef.current;
    if (!node) return;
    const resize = () => setSize({ width: Math.max(1, node.clientWidth), height: Math.max(1, node.clientHeight) });
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { fitScene(); }, [fitScene]);
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(40, now - last);
      last = now;
      setProgress((p) => (p + dt / 8000) % 1);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const routeGeo = useMemo(() => [origin, ...waypoints, target], [origin, waypoints, target]);
  const allRouteDistance = useMemo(() => routeGeo.slice(1).reduce((sum, p, i) => sum + distanceKm(routeGeo[i], p), 0), [routeGeo]);
  const profile = routeResult?.elevation_profile ?? [];
  const maxProfileDistance = profile.length ? Math.max(...profile.map((p) => p.distance_km), 0.001) : allRouteDistance;

  const tiles = useMemo(() => {
    const tileCount = 2 ** zoom;
    const left = Math.floor((center.x - size.width / 2) / 256) - 1;
    const top = Math.floor((center.y - size.height / 2) / 256) - 1;
    const out: Array<{ tx: number; ty: number; wx: number }> = [];
    for (let tx = left; tx < left + Math.ceil(size.width / 256) + 3; tx += 1) {
      for (let ty = top; ty < top + Math.ceil(size.height / 256) + 3; ty += 1) {
        if (ty >= 0 && ty < tileCount) out.push({ tx, ty, wx: ((tx % tileCount) + tileCount) % tileCount });
      }
    }
    return out;
  }, [center.x, center.y, size.width, size.height, zoom]);

  const projectGround = useCallback((point: { lat: number; lon: number }) => {
    const world = lonLatToWorld(point.lat, point.lon, zoom);
    const px = size.width / 2 + world.x - center.x;
    const py = size.height * 0.60 + world.y - center.y;
    const cx = size.width / 2;
    const cy = size.height * 0.60;
    const dx = px - cx;
    const dy = py - cy;
    const cyaw = Math.cos(orbit.yaw), syaw = Math.sin(orbit.yaw);
    const x = cx + dx * cyaw - dy * syaw;
    const depth = cy + dx * syaw + dy * cyaw;
    return { x, y: depth };
  }, [zoom, size.width, size.height, center.x, center.y, orbit.yaw]);

  const screenToGeo = useCallback((clientX: number, clientY: number) => {
    const rect = hostRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const cx = size.width / 2;
    const cy = size.height * 0.60;
    const dx = sx - cx;
    const dy = sy - cy;
    const cyaw = Math.cos(orbit.yaw), syaw = Math.sin(orbit.yaw);
    const worldX = center.x + dx * cyaw + dy * syaw;
    const worldY = center.y - dx * syaw + dy * cyaw;
    return worldToLonLat(worldX, worldY, zoom);
  }, [center.x, center.y, orbit.yaw, size.height, size.width, zoom]);

  const liftPoint = useCallback((ground: Point2, altitudeMeters: number) => {
    const base = (altitudeMeters - Math.min(origin.alt, target.alt)) / 1000 * params.verticalScale + params.terrainLift;
    const lift = base * (22 * Math.cos(orbit.pitch));
    return { x: ground.x, y: ground.y - lift };
  }, [origin.alt, target.alt, params.verticalScale, params.terrainLift, orbit.pitch]);

  const routeGroundPoints = routeGeo.map(projectGround);
  const groundPath = routeGroundPoints.map((p) => `${p.x},${p.y}`).join(' ');
  const trajTarget = trajectoryResult?.intercept_point ?? target;
  const trajSamples = useMemo(() => Array.from({ length: 50 }, (_, i) => {
    const t = i / 49;
    const lat = origin.lat + (trajTarget.lat - origin.lat) * t;
    const lon = origin.lon + (trajTarget.lon - origin.lon) * t;
    const baseAlt = origin.alt + (trajTarget.alt - origin.alt) * t;
    const hump = Math.sin(Math.PI * t) * 2500 * params.arcBias;
    return { geo: { lat, lon }, alt: baseAlt + hump };
  }), [origin, trajTarget, params.arcBias]);
  const trajectoryPoints = trajSamples.map((p) => liftPoint(projectGround(p.geo), p.alt));
  const playhead = trajectoryPoints[Math.min(trajectoryPoints.length - 1, Math.floor(progress * trajectoryPoints.length))] ?? trajectoryPoints[0];

  const terrainRibbon = useMemo(() => {
    if (!layers.terrain || !profile.length || routeGeo.length < 2) return null;
    const legLengths: number[] = [];
    let total = 0;
    for (let i = 1; i < routeGeo.length; i += 1) {
      const d = distanceKm(routeGeo[i - 1], routeGeo[i]);
      legLengths.push(d);
      total += d;
    }
    const points: Point2[] = [];
    profile.forEach((sample) => {
      let remaining = sample.distance_km / Math.max(maxProfileDistance, 0.001) * total;
      let leg = 0;
      while (leg < legLengths.length - 1 && remaining > legLengths[leg]) { remaining -= legLengths[leg]; leg += 1; }
      const start = routeGeo[leg];
      const end = routeGeo[leg + 1] ?? routeGeo[routeGeo.length - 1];
      const u = legLengths[leg] ? clamp(remaining / legLengths[leg], 0, 1) : 0;
      points.push(projectGround({ lat: start.lat + (end.lat - start.lat) * u, lon: start.lon + (end.lon - start.lon) * u }));
    });
    return { ground: points, elevated: profile.map((sample, i) => liftPoint(points[i], sample.elevation_m)) };
  }, [layers.terrain, profile, routeGeo, maxProfileDistance, projectGround, liftPoint]);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = { x: event.clientX, y: event.clientY, cx: center.x, cy: center.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = hostRef.current?.getBoundingClientRect();
    if (rect) {
      const lx = event.clientX - rect.left;
      const ly = event.clientY - rect.top;
      const point = screenToGeo(event.clientX, event.clientY);
      if (point) setCursor(point);
    }
    if (!dragRef.current) return;
    const dx = event.clientX - dragRef.current.x;
    const dy = event.clientY - dragRef.current.y;
    setCenter({ x: dragRef.current.cx - dx, y: dragRef.current.cy - dy });
    if (event.buttons === 1 && event.altKey) setOrbit((o) => ({ ...o, yaw: o.yaw + dx * 0.004, pitch: clamp(o.pitch - dy * 0.002, 0.08, 0.9) }));
  };
  const onDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const targetNode = event.target as Element | null;
    if (targetNode?.closest('.theater-controls, .theater-legend, .theater-hud, .map-attribution, .input-command-deck, .theater-point')) return;
    const point = screenToGeo(event.clientX, event.clientY);
    if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return;
    onAddWaypoint({ lat: clamp(point.lat, -85, 85), lon: point.lon });
    event.preventDefault();
    event.stopPropagation();
  };

  const originGround = projectGround(origin);
  const targetGround = projectGround(target);
  const losA = projectGround(losObserver);
  const losB = projectGround(losTarget);
  const selectedIndex = selectedEntity?.startsWith('wp_') ? Number(selectedEntity.slice(3)) : null;

  return <div
    className="unified-theater"
    ref={hostRef}
    tabIndex={0}
    onPointerDown={onPointerDown}
    onPointerMove={onPointerMove}
    onPointerUp={() => { dragRef.current = null; }}
    onPointerCancel={() => { dragRef.current = null; }}
    onDoubleClick={onDoubleClick}
    onKeyDown={(event) => {
      if (event.key !== 'Delete' || selectedIndex === null) return;
      event.preventDefault();
      onDeleteWaypoint(selectedIndex);
    }}
    title="Double-click empty terrain to add a waypoint. Right-click an interior waypoint to delete it."
  >
    <div className="theater-tiles">
      {tiles.map((tile) => <img key={`${tile.tx}:${tile.ty}`} className="map-tile" draggable={false} src={`https://tile.openstreetmap.org/${zoom}/${tile.wx}/${tile.ty}.png`} alt="" style={{ left: size.width / 2 + tile.tx * 256 + 128 - center.x, top: size.height * 0.60 + tile.ty * 256 + 128 - center.y }} />)}
    </div>
    <div className="theater-vignette" />
    <svg className="theater-svg" viewBox={`0 0 ${Math.max(1, size.width)} ${Math.max(1, size.height)}`}>
      {layers.route && <polyline points={groundPath} fill="none" className="theater-route-ground" />}
      {layers.terrain && terrainRibbon && <>
        <polyline points={terrainRibbon.elevated.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" className="theater-terrain-ridge" />
        {terrainRibbon.elevated.filter((_, i) => i % 3 === 0).map((p, i) => {
          const g = terrainRibbon.ground[i * 3];
          return g ? <line key={`drop-${i}`} x1={g.x} y1={g.y} x2={p.x} y2={p.y} className="theater-terrain-drop" /> : null;
        })}
      </>}
      {layers.trajectory && <>
        <polyline points={trajectoryPoints.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" className="theater-trajectory-shadow" />
        <polyline points={trajectoryPoints.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" className="theater-trajectory" />
        <line x1={trajectoryPoints[0]?.x ?? 0} y1={trajectoryPoints[0]?.y ?? 0} x2={originGround.x} y2={originGround.y} className="theater-drop-line" />
        <line x1={trajectoryPoints[trajectoryPoints.length - 1]?.x ?? 0} y1={trajectoryPoints[trajectoryPoints.length - 1]?.y ?? 0} x2={targetGround.x} y2={targetGround.y} className="theater-drop-line" />
      </>}
      {layers.los && losResult && <line x1={losA.x} y1={losA.y} x2={losB.x} y2={losB.y} className={`theater-los ${losResult.visible ? 'clear' : 'blocked'}`} />}
      <g className="theater-point"><circle cx={originGround.x} cy={originGround.y} r="8" className="map-origin" /><text x={originGround.x + 12} y={originGround.y - 12} className="theater-label">ORIGIN · {origin.alt.toFixed(0)} M</text></g>
      {waypoints.map((wp, i) => { const p = projectGround(wp); const active = selectedIndex === i; return <g key={`${wp.lat}:${wp.lon}:${i}`} className={`theater-point ${active ? 'active' : ''}`} onClick={(e) => { e.stopPropagation(); onSelectWaypoint(i); }} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onSelectWaypoint(i); onDeleteWaypoint(i); }}><circle cx={p.x} cy={p.y} r={active ? 8 : 6} className="map-waypoint" /><text x={p.x + 9} y={p.y - 9} className="theater-label">WP {i + 1}</text></g>; })}
      <g className="theater-point"><circle cx={targetGround.x} cy={targetGround.y} r="8" className="map-target" /><text x={targetGround.x + 12} y={targetGround.y - 12} className="theater-label">TARGET · {target.alt.toFixed(0)} M</text></g>
      {playing && playhead && <circle cx={playhead.x} cy={playhead.y} r="7" className="theater-playhead" />}
      <text x="18" y="30" className="theater-title">UNIFIED GEOGRAPHIC / ELEVATION THEATER</text>
      <text x="18" y="49" className="theater-subtitle">MAP = GROUND PLANE · TRAJECTORY + TERRAIN = LIFTED GEOMETRY</text>
      <text x={size.width - 18} y={size.height - 18} textAnchor="end" className="theater-subtitle">ALTITUDE × {params.verticalScale.toFixed(2)} · ARC × {params.arcBias.toFixed(2)} · ALT/HORIZONTAL ARE VISUAL SCALES</text>
    </svg>
    <div className="theater-hud">
      <span>OSM · Z{zoom}</span><span>{routeResult ? `ROUTE ${routeResult.feasible ? 'CLEAR' : 'REVIEW'}` : 'ROUTE PREVIEW'}</span><span>{profile.length ? `${profile.length} TERRAIN SAMPLES` : 'TERRAIN PROFILE NOT RUN'}</span><span>{cursor ? `${cursor.lat.toFixed(4)}, ${cursor.lon.toFixed(4)}` : 'DOUBLE-CLICK TO ADD · RIGHT-CLICK TO DELETE'}</span>
    </div>
    <div className="theater-controls" onPointerDown={(e) => e.stopPropagation()}>
      <button className="map-control" onClick={() => setZoom((z) => clamp(z + 1, 6, 17))}>+</button>
      <button className="map-control" onClick={() => setZoom((z) => clamp(z - 1, 6, 17))}>−</button>
      <button className="map-control map-control-fit" onClick={fitScene}>FIT</button>
      <button className="map-control map-control-fit" onClick={() => setOrbit({ yaw: 0, pitch: 0.42 })}>3D</button>
    </div>
    <div className="theater-legend">
      {(['route','terrain','los','trajectory'] as TheaterLayer[]).map((key) => <span key={key} className={layers[key] ? 'on' : ''}><i className={`theater-swatch ${key}`} />{key}</span>)}
      <button className="theater-play" onClick={onTogglePlay}>{playing ? 'PAUSE' : 'PLAY'}</button>
    </div>
    <div className="theater-status"><strong>{trajectoryResult ? (trajectoryResult.feasible ? 'TRAJECTORY FEASIBLE' : 'TRAJECTORY INFEASIBLE') : 'TRAJECTORY PREVIEW'}</strong><span>{trajectoryResult ? `${trajectoryResult.time_of_flight_s.toFixed(1)} s reported` : 'run geometry validation for result state'}</span></div>
    <div className="map-attribution">© OpenStreetMap contributors</div>
  </div>;
}

function ElevationChart({ data, selectedLeg }: { data: RouteResponse['elevation_profile']; selectedLeg: number | null }) {
  if (!data.length) return <div className="viz-empty">Run route validation to populate terrain elevation.</div>;
  const width = 820, height = 260, padX = 42, padY = 28;
  const xs = data.map((p) => p.distance_km), ys = data.map((p) => p.elevation_m);
  const minX = Math.min(...xs), maxX = Math.max(...xs, minX + 0.001), minY = Math.min(...ys), maxY = Math.max(...ys, minY + 1);
  const x = (v: number) => padX + ((v - minX) / (maxX - minX)) * (width - padX * 2);
  const y = (v: number) => height - padY - ((v - minY) / (maxY - minY)) * (height - padY * 2);
  const line = data.map((p) => `${x(p.distance_km)},${y(p.elevation_m)}`).join(' ');
  const area = `${padX},${height - padY} ${line} ${width - padX},${height - padY}`;
  return <div className="viz-frame"><svg viewBox={`0 0 ${width} ${height}`}><rect x="0" y="0" width={width} height={height} className="viz-bg" />{[1,2,3].map((n) => <line key={n} x1={padX} x2={width-padX} y1={padY+n*(height-padY*2)/4} y2={padY+n*(height-padY*2)/4} className="viz-grid" />)}<polygon points={area} className="viz-area" /><polyline points={line} className="viz-elevation" fill="none" />{selectedLeg !== null && <text x={width-padX} y="18" textAnchor="end" className="viz-label">LEG {selectedLeg + 1} SELECTED</text>}<text x={padX} y="17" className="viz-label">{maxY.toFixed(0)} m</text><text x={padX} y={height-6} className="viz-label">{minY.toFixed(0)} m</text><text x={width-padX} y={height-6} textAnchor="end" className="viz-label">{maxX.toFixed(1)} km</text></svg><div className="viz-axis"><span>TERRAIN ELEVATION</span><span>{data.length} SAMPLES</span><span>DISTANCE</span></div></div>;
}

function App() {
  const [view, setView] = useState<ViewKey>('scenario');
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [backendError, setBackendError] = useState<string | null>(null);
  const [origin, setOrigin] = useState(DEMO_ORIGIN), [target, setTarget] = useState(DEMO_TARGET), [platformOntId, setPlatformOntId] = useState('artillery_l3');
  const [losObserver, setLosObserver] = useState(DEMO_ORIGIN), [losTarget, setLosTarget] = useState(DEMO_TARGET);
  const [routeWps, setRouteWps] = useState<Coordinate2D[]>([{ lat: DEMO_ORIGIN.lat, lon: DEMO_ORIGIN.lon, ont_id: 'wp_leh_base' }, { lat: 34.1, lon: 77.6 }, { lat: DEMO_TARGET.lat, lon: DEMO_TARGET.lon, ont_id: 'wp_ridge' }]);
  const [vehicleType, setVehicleType] = useState('wheeled_logistics');
  const [busy, setBusy] = useState<RunKind>(null), [log, setLog] = useState<LogEntry[]>([]);
  const [trajectoryResult, setTrajectoryResult] = useState<TrajectoryResponse | null>(null), [losResult, setLosResult] = useState<LosResponse | null>(null), [routeResult, setRouteResult] = useState<RouteResponse | null>(null);
  const [layers, setLayers] = useState<Record<TheaterLayer, boolean>>({ route: true, los: true, trajectory: true, terrain: true });
  const [selectedWaypoint, setSelectedWaypoint] = useState<number | null>(null), [selectedEntity, setSelectedEntity] = useState<string | null>(null), [query, setQuery] = useState(''), [playing, setPlaying] = useState(false);
  const [visualParams, setVisualParams] = useState<VisualParams>({ verticalScale: 1.25, arcBias: 1, terrainLift: 0 });
  const logId = useRef(0);
  const pushLog = useCallback((entry: Omit<LogEntry, 'id'>) => setLog((prev) => [{ ...entry, id: logId.current++ }, ...prev].slice(0, 40)), []);
  const pollHealth = useCallback(async () => { try { const h = await getHealth(); setHealth(h); setBackendError(null); } catch { setHealth(null); setBackendError('Backend is starting or unreachable; retrying automatically.'); } }, []);
  useEffect(() => { void pollHealth(); const timer = window.setInterval(() => void pollHealth(), 5000); return () => window.clearInterval(timer); }, [pollHealth]);
  const invalidateResults = useCallback((label: string) => {
    setTrajectoryResult(null);
    setLosResult(null);
    setRouteResult(null);
    pushLog({ title: 'Inputs changed · REVALIDATION REQUIRED', ok: false, detail: `${label} edited. Previous validation results were cleared.` });
  }, [pushLog]);
  const updateWaypoint = useCallback((index: number, point: Coordinate2D) => {
    setRouteWps((prev) => prev.map((wp, i) => i === index ? { ...wp, lat: point.lat, lon: point.lon } : wp));
    setSelectedWaypoint(index);
    setSelectedEntity(`wp_${index}`);
    invalidateResults(`Waypoint ${index + 1}`);
  }, [invalidateResults]);
  const addWaypoint = useCallback((point: Coordinate2D) => {
    setRouteWps((prev) => {
      const insertAt = Math.max(1, prev.length - 1);
      const next = [...prev.slice(0, insertAt), { lat: point.lat, lon: point.lon }, ...prev.slice(insertAt)];
      setSelectedWaypoint(insertAt);
      setSelectedEntity(`wp_${insertAt}`);
      return next;
    });
    invalidateResults('New waypoint');
  }, [invalidateResults]);
  const deleteWaypoint = useCallback((index: number) => {
    if (index <= 0) { pushLog({ title: 'Waypoint · PROTECTED', ok: false, detail: 'The first waypoint anchors the route start and cannot be deleted.' }); return; }
    setRouteWps((prev) => {
      if (index >= prev.length - 1) return prev;
      const next = prev.filter((_, i) => i !== index);
      setSelectedWaypoint(Math.min(index, next.length - 1));
      setSelectedEntity(`wp_${Math.min(index, next.length - 1)}`);
      return next;
    });
    invalidateResults(`Waypoint ${index + 1} deleted`);
  }, [invalidateResults, pushLog]);
  const setOriginPoint = useCallback((point: Coordinate3D) => { setOrigin(point); setLosObserver({ ...point }); invalidateResults('Origin'); }, [invalidateResults]);
  const setTargetPoint = useCallback((point: Coordinate3D) => { setTarget(point); setLosTarget({ ...point }); invalidateResults('Target'); }, [invalidateResults]);

  // Publish the live scenario state to the 3D globe overlay (mounted as a
  // sibling in AppShell, outside this component tree) regardless of which
  // of the three views is currently active — see sceneStore.ts for why.
  useEffect(() => {
    publishScene({
      origin: { lat: origin.lat, lon: origin.lon, alt: origin.alt },
      target: { lat: target.lat, lon: target.lon, alt: target.alt },
      observer: { lat: losObserver.lat, lon: losObserver.lon, alt: losObserver.alt },
      losTarget: { lat: losTarget.lat, lon: losTarget.lon, alt: losTarget.alt },
      waypoints: routeWps.map((wp) => ({ lat: wp.lat, lon: wp.lon })),
    });
  }, [origin, target, losObserver, losTarget, routeWps]);

  // Accept edits coming back from the globe (marker drags, coordinate editor apply).
  useEffect(() => registerSceneEditHandler((edit) => {
    const { target: kind, index, point } = edit;
    if (kind === 'origin') setOriginPoint({ ...origin, lat: point.lat, lon: point.lon });
    else if (kind === 'target') setTargetPoint({ ...target, lat: point.lat, lon: point.lon });
    else if (kind === 'observer') { setLosObserver({ ...losObserver, lat: point.lat, lon: point.lon }); invalidateResults('LOS observer'); }
    else if (kind === 'losTarget') { setLosTarget({ ...losTarget, lat: point.lat, lon: point.lon }); invalidateResults('LOS target'); }
    else if (kind === 'waypoint') updateWaypoint(index, { lat: point.lat, lon: point.lon });
  }), [origin, target, losObserver, losTarget, setOriginPoint, setTargetPoint, updateWaypoint, invalidateResults]);

  const runTrajectoryOp = async () => { setBusy('trajectory'); try { const r = await runTrajectory({ origin, target, platform_ont_id: platformOntId }); setTrajectoryResult(r); pushLog({ title: `Trajectory · ${r.feasible ? 'FEASIBLE' : 'INFEASIBLE'}`, ok: r.feasible, detail: r.notes }); } catch (e) { pushLog({ title: 'Trajectory · ERROR', ok: false, detail: String(e) }); } finally { setBusy(null); } };
  const runLosOp = async () => { setBusy('los'); try { const r = await runLos({ observer: losObserver, target: losTarget }); setLosResult(r); const state = r.validation_status === 'unknown' ? 'UNKNOWN' : r.visible ? 'VISIBLE' : 'OBSTRUCTED'; pushLog({ title: `Line-of-Sight · ${state}`, ok: r.visible, detail: r.reason ?? 'No terrain obstruction detected.' }); } catch (e) { pushLog({ title: 'Line-of-Sight · ERROR', ok: false, detail: String(e) }); } finally { setBusy(null); } };
  const runRouteOp = async () => { setBusy('route'); try { const r = await runRoute({ waypoints: routeWps, vehicle_type: vehicleType, terrain_source: 'srtm' }); setRouteResult(r); pushLog({ title: `Route · ${r.feasible ? 'CLEAR' : `${r.constraints_violated.length} VIOLATION(S)`}`, ok: r.feasible, detail: r.constraints_violated.length ? r.constraints_violated.map((v) => v.reason).join(' || ') : `Route clear. ${r.distance_km} km, nominal ETA ${r.eta_hours} h.` }); } catch (e) { pushLog({ title: 'Route · ERROR', ok: false, detail: String(e) }); } finally { setBusy(null); } };
  const runAll = async () => { if (busy || backendError) return; await runTrajectoryOp(); await runLosOp(); await runRouteOp(); };
  const entities = useMemo<Entity[]>(() => [
    { id: 'origin', type: 'POSITION', label: 'Origin', lat: origin.lat, lon: origin.lon, alt: origin.alt, status: trajectoryResult?.feasible ? 'validated' : 'input', source: 'trajectory' },
    { id: 'target', type: 'POSITION', label: 'Target', lat: target.lat, lon: target.lon, alt: target.alt, status: trajectoryResult ? 'validated' : 'input', source: 'trajectory' },
    { id: 'observer', type: 'SENSOR', label: 'LOS Observer', lat: losObserver.lat, lon: losObserver.lon, alt: losObserver.alt, status: losResult ? (losResult.visible ? 'visible' : 'obstructed') : 'input', source: 'los' },
    ...routeWps.map((wp, i) => ({ id: `wp_${i}`, type: 'WAYPOINT', label: wp.ont_id ?? `Waypoint ${i + 1}`, lat: wp.lat, lon: wp.lon, status: routeResult?.constraints_violated.some((v) => v.leg === i) ? 'constraint' : routeResult ? 'checked' : 'input', source: 'route' })),
    { id: 'platform', type: 'ONTOLOGY', label: platformOntId, lat: origin.lat, lon: origin.lon, alt: origin.alt, status: 'linked', source: 'platform' },
  ], [origin, target, losObserver, routeWps, platformOntId, trajectoryResult, losResult, routeResult]);
  const filteredEntities = entities.filter((e) => `${e.id} ${e.label} ${e.type} ${e.source}`.toLowerCase().includes(query.toLowerCase()));
  const selectedViolation = selectedWaypoint !== null ? routeResult?.constraints_violated.find((v) => v.leg === selectedWaypoint + 1) : undefined;
  const overall: 'ok' | 'warn' | 'error' = backendError ? 'warn' : routeResult?.validation_status === 'unknown' || losResult?.validation_status === 'unknown' ? 'warn' : 'ok';
  const selectEntity = (id: string) => { setSelectedEntity(id); if (id.startsWith('wp_')) setSelectedWaypoint(Number(id.slice(3))); else setSelectedWaypoint(null); };
  const theaterProps = { origin, target, losObserver, losTarget, waypoints: routeWps, trajectoryResult, routeResult, losResult, layers, params: visualParams, playing, onTogglePlay: () => setPlaying((p) => !p), selectedEntity, onSelectWaypoint: (i: number) => { setSelectedWaypoint(i); setSelectedEntity(`wp_${i}`); }, onAddWaypoint: addWaypoint, onDeleteWaypoint: deleteWaypoint };

  return <div className="app-container"><aside className="sidebar"><div className="brand-block"><span className="brand-mark">AMARAN</span><span className="brand-sub">L3 · UNIFIED VISUAL PHYSICS</span></div><nav className="nav"><button className={`nav-item ${view === 'scenario' ? 'active' : ''}`} onClick={() => setView('scenario')}>Unified Theater</button><button className={`nav-item ${view === 'entities' ? 'active' : ''}`} onClick={() => setView('entities')}>Entity Explorer <span className="nav-count">{entities.length}</span></button><button className={`nav-item ${view === 'sandbox' ? 'active' : ''}`} onClick={() => setView('sandbox')}>Physics Sandbox <span className="nav-count">LIVE</span></button></nav><div className="sidebar-toolbox"><span className="field-label">WORKSPACE STATE</span><div className="mini-state"><span>{entities.length} ENTITIES</span><span>{Object.values(layers).filter(Boolean).length}/4 LAYERS</span></div><button className="sidebar-run" disabled={busy !== null || !!backendError} onClick={runAll}>{busy ? 'RUNNING…' : 'RUN ALL CHECKS'}</button></div><div className="sidebar-foot"><span className="field-label">LOCAL SERVICE</span><span>127.0.0.1:8000</span></div></aside>
    <main className="main-panel"><header className="header"><div><span className="section-label muted">DECISION SUPPORT / L3</span><h1 className="big-title">{view === 'scenario' ? 'Unified Theater' : view === 'entities' ? 'Entity Explorer' : 'Physics Sandbox'}</h1></div><div className="header-actions"><StatusPill status={overall} label={backendError ? 'STARTING' : 'ONLINE'} /><div className="health-compact"><span className={`status-dot ${health?.srtm_loaded ? 'ok' : 'warn'}`} />DEM {health?.srtm_loaded ? `${health.tiles.length} TILE(S)` : 'UNAVAILABLE'}</div></div></header>
      {view === 'scenario' && <div className="workspace"><div className="panel-col"><Panel title="Unified 3D Geographic Theater" className="unified-panel"><div className="layer-bar"><span className="field-label">LAYER STACK</span>{(['route','terrain','los','trajectory'] as TheaterLayer[]).map((key) => <button key={key} className={`layer-toggle ${layers[key] ? 'active' : ''}`} onClick={() => setLayers((p) => ({ ...p, [key]: !p[key] }))}>{key}</button>)}<span className="layer-spacer" /><span className="selection-readout">{selectedEntity ? `FOCUS · ${selectedEntity}` : 'MAP + TERRAIN + TRAJECTORY IN ONE FRAME'}</span></div><UnifiedTheater {...theaterProps} /></Panel>
        <div className="visual-grid"><Panel title="Terrain Profile"><ElevationChart data={routeResult?.elevation_profile ?? []} selectedLeg={selectedWaypoint} /></Panel><Panel title="Decision Snapshot"><div className="metric-grid"><Metric label="TRAJECTORY" value={trajectoryResult ? (trajectoryResult.feasible ? 'FEASIBLE' : 'INFEASIBLE') : '—'} meta={trajectoryResult ? `${trajectoryResult.time_of_flight_s.toFixed(1)} s reported${trajectoryResult.platform_verified ? ` · ${trajectoryResult.platform_label} (verified)` : ' · platform unverified'}` : 'not run'} /><Metric label="LINE OF SIGHT" value={losResult ? (losResult.validation_status === 'unknown' ? 'UNKNOWN' : losResult.visible ? 'VISIBLE' : 'BLOCKED') : '—'} meta={losResult?.method} /><Metric label="ROUTE" value={routeResult ? (routeResult.feasible ? 'CLEAR' : 'REVIEW') : '—'} meta={routeResult ? `${routeResult.constraints_violated.length} constraint(s)` : 'not run'} /><Metric label="ENTITIES" value={`${entities.length}`} meta="linked in explorer" /></div>{selectedViolation && <div className="selection-card"><span className="field-label">SELECTED LEG {selectedViolation.leg}</span><strong>{selectedViolation.slope_deg?.toFixed(1) ?? '—'}° SLOPE</strong><p>{selectedViolation.reason}</p></div>}</Panel></div>
        <div className="input-grid"><Panel title="Trajectory / Geometry"><div className="coord-grid"><div className="coord"><h4 className="section-label">Origin</h4><NumField label="Lat" value={origin.lat} onChange={(v) => { setOrigin({ ...origin, lat: v }); setLosObserver({ ...losObserver, lat: v }); invalidateResults('Origin latitude'); }} /><NumField label="Lon" value={origin.lon} onChange={(v) => { setOrigin({ ...origin, lon: v }); setLosObserver({ ...losObserver, lon: v }); invalidateResults('Origin longitude'); }} /><NumField label="Alt m" value={origin.alt} onChange={(v) => { setOrigin({ ...origin, alt: v }); setLosObserver({ ...losObserver, alt: v }); invalidateResults('Origin altitude'); }} /></div><div className="coord"><h4 className="section-label">Target</h4><NumField label="Lat" value={target.lat} onChange={(v) => { setTarget({ ...target, lat: v }); setLosTarget({ ...losTarget, lat: v }); invalidateResults('Target latitude'); }} /><NumField label="Lon" value={target.lon} onChange={(v) => { setTarget({ ...target, lon: v }); setLosTarget({ ...losTarget, lon: v }); invalidateResults('Target longitude'); }} /><NumField label="Alt m" value={target.alt} onChange={(v) => { setTarget({ ...target, alt: v }); setLosTarget({ ...losTarget, alt: v }); invalidateResults('Target altitude'); }} /></div></div><label className="field"><span className="field-label">Platform Ontology ID</span><input className="field-input text" value={platformOntId} onChange={(e) => { setPlatformOntId(e.target.value); invalidateResults('Platform ontology'); }} /></label><button className="action" disabled={busy !== null || !!backendError} onClick={runTrajectoryOp}>{busy === 'trajectory' ? 'COMPUTING...' : 'Validate Geometry'}</button></Panel><Panel title="Line-of-Sight"><div className="coord-grid"><div className="coord"><h4 className="section-label">Observer</h4><NumField label="Lat" value={losObserver.lat} onChange={(v) => { setLosObserver({ ...losObserver, lat: v }); invalidateResults('LOS observer latitude'); }} /><NumField label="Lon" value={losObserver.lon} onChange={(v) => { setLosObserver({ ...losObserver, lon: v }); invalidateResults('LOS observer longitude'); }} /><NumField label="Alt m" value={losObserver.alt} onChange={(v) => { setLosObserver({ ...losObserver, alt: v }); invalidateResults('LOS observer altitude'); }} /></div><div className="coord"><h4 className="section-label">Target</h4><NumField label="Lat" value={losTarget.lat} onChange={(v) => { setLosTarget({ ...losTarget, lat: v }); invalidateResults('LOS target latitude'); }} /><NumField label="Lon" value={losTarget.lon} onChange={(v) => { setLosTarget({ ...losTarget, lon: v }); invalidateResults('LOS target longitude'); }} /><NumField label="Alt m" value={losTarget.alt} onChange={(v) => { setLosTarget({ ...losTarget, alt: v }); invalidateResults('LOS target altitude'); }} /></div></div><button className="action" disabled={busy !== null || !!backendError} onClick={runLosOp}>{busy === 'los' ? 'COMPUTING...' : 'Check Visibility'}</button></Panel></div>
        <Panel title="Route Validation" className="route-panel"><div className="wp-table"><div className="wp-row wp-head"><span>WP</span><span>LAT</span><span>LON</span><span>ONT_ID</span><span>LEG</span></div>{routeWps.map((wp, index) => <div className={`wp-row ${selectedWaypoint === index ? 'selected' : ''}`} key={index} onClick={() => { setSelectedWaypoint(index); setSelectedEntity(`wp_${index}`); }}><span>{index + 1}</span><input className="field-input compact" type="number" step="any" value={wp.lat} onChange={(e) => { const next = [...routeWps]; next[index] = { ...next[index], lat: Number(e.target.value) }; setRouteWps(next); invalidateResults(`Waypoint ${index + 1} latitude`); }} /><input className="field-input compact" type="number" step="any" value={wp.lon} onChange={(e) => { const next = [...routeWps]; next[index] = { ...next[index], lon: Number(e.target.value) }; setRouteWps(next); invalidateResults(`Waypoint ${index + 1} longitude`); }} /><span className="wp-ont">{wp.ont_id ?? '—'}</span><span className="leg-state">{index === 0 ? 'START' : index === routeWps.length - 1 ? 'END' : routeResult?.constraints_violated.some((v) => v.leg === index) ? 'CHECK' : 'OK'}</span></div>)}</div><div className="route-controls"><label className="field"><span className="field-label">VEHICLE TYPE</span><select className="field-input text" value={vehicleType} onChange={(e) => { setVehicleType(e.target.value); invalidateResults('Vehicle type'); }}><option value="wheeled_logistics">wheeled_logistics</option><option value="tracked_utility">tracked_utility</option><option value="motor_convoy">motor_convoy</option></select></label><div className="route-action-stack"><button className="action" disabled={busy !== null || !!backendError} onClick={runRouteOp}>{busy === 'route' ? 'COMPUTING...' : 'Validate Route'}</button><span className="route-hint">DOUBLE-CLICK MAP TO ADD · RIGHT-CLICK INTERIOR WP TO DELETE · DELETE KEY REMOVES SELECTED</span></div></div></Panel></div><aside className="detail-panel"><div className="detail-section"><div className="detail-title-row"><h3 className="section-label">EXPLANATION TRACE</h3><span className="log-count">{log.length}</span></div>{log.length === 0 ? <p className="hint">Run checks to populate the linked trace. The theater, terrain profile, route table and entity explorer share the same scenario state.</p> : <ul className="log">{log.map((entry) => <li key={entry.id} className={`log-entry ${entry.ok ? 'ok' : 'err'}`}><div className="log-title">{entry.title}</div><div className="log-detail">{entry.detail}</div></li>)}</ul>}</div><div className="detail-section"><h3 className="section-label">ACTIVE CONTEXT</h3><div className="context-grid"><Metric label="WAYPOINTS" value={`${routeWps.length}`} /><Metric label="DEM" value={health?.srtm_loaded ? 'READY' : 'MISSING'} /><Metric label="FOCUS" value={selectedEntity ?? 'NONE'} /></div></div><div className="detail-section"><h3 className="section-label">THEATER CONTROLS</h3><div className="sandbox-control-row"><label className="field"><span className="field-label">HEIGHT EXAGGERATION</span><input type="range" min="0.7" max="2.4" step="0.05" value={visualParams.verticalScale} onChange={(e) => setVisualParams((p) => ({ ...p, verticalScale: Number(e.target.value) }))} /></label><output>{visualParams.verticalScale.toFixed(2)}×</output></div><div className="sandbox-control-row"><label className="field"><span className="field-label">PATH CURVATURE</span><input type="range" min="0.2" max="1.8" step="0.05" value={visualParams.arcBias} onChange={(e) => setVisualParams((p) => ({ ...p, arcBias: Number(e.target.value) }))} /></label><output>{visualParams.arcBias.toFixed(2)}×</output></div><button className="action" onClick={() => setPlaying((p) => !p)}>{playing ? 'Pause Playback' : 'Play Playback'}</button></div></aside></div>}
      {view === 'entities' && <div className="workspace"><div className="entity-workspace"><Panel title="Entity Registry" className="entity-panel"><div className="entity-toolbar"><input className="field-input text" placeholder="Search id, type or ontology…" value={query} onChange={(e) => setQuery(e.target.value)} /><span className="entity-summary">{filteredEntities.length} / {entities.length}</span></div><div className="entity-grid">{filteredEntities.map((entity) => <button className={`entity-card ${selectedEntity === entity.id ? 'active' : ''}`} key={entity.id} onClick={() => selectEntity(entity.id)}><div className="entity-card-head"><span className="entity-type">{entity.type}</span><span className="entity-status">{entity.status}</span></div><strong>{entity.label}</strong><span className="entity-id">{entity.id}</span><div className="entity-coord">{entity.lat.toFixed(4)}, {entity.lon.toFixed(4)}{entity.alt !== undefined ? ` · ${entity.alt.toFixed(0)} m` : ''}</div><span className="entity-source">SOURCE · {entity.source}</span></button>)}</div></Panel><Panel title="Synchronized Theater"><UnifiedTheater {...theaterProps} /></Panel><Panel title="Focused Entity"><div className="entity-focus">{selectedEntity ? (() => { const e = entities.find((x) => x.id === selectedEntity); return e ? <><Metric label="TYPE" value={e.type} /><Metric label="STATUS" value={e.status} /><Metric label="COORDINATES" value={`${e.lat.toFixed(4)}, ${e.lon.toFixed(4)}`} meta={e.alt !== undefined ? `${e.alt.toFixed(0)} m` : undefined} /><div className="focus-ring">{e.source.toUpperCase()}</div></> : <p className="hint">Entity no longer exists.</p>; })() : <p className="hint">Select an entity to focus it in the unified theater.</p>}</div></Panel></div></div>}
      {view === 'sandbox' && <div className="workspace"><div className="sandbox-workspace"><Panel title="Unified Physics Sandbox" className="sandbox-panel"><div className="sandbox-note">The controls below change the visualization model only. Backend validation remains the source of truth for results; the lifted geometry is a visual aid.</div><div className="sandbox-sliders"><label className="sandbox-slider"><span>HEIGHT EXAGGERATION</span><input type="range" min="0.7" max="2.4" step="0.05" value={visualParams.verticalScale} onChange={(e) => setVisualParams((p) => ({ ...p, verticalScale: Number(e.target.value) }))} /><output>{visualParams.verticalScale.toFixed(2)}×</output></label><label className="sandbox-slider"><span>PATH CURVATURE</span><input type="range" min="0.2" max="1.8" step="0.05" value={visualParams.arcBias} onChange={(e) => setVisualParams((p) => ({ ...p, arcBias: Number(e.target.value) }))} /><output>{visualParams.arcBias.toFixed(2)}×</output></label><label className="sandbox-slider"><span>TERRAIN LIFT</span><input type="range" min="-2" max="2" step="0.1" value={visualParams.terrainLift} onChange={(e) => setVisualParams((p) => ({ ...p, terrainLift: Number(e.target.value) }))} /><output>{visualParams.terrainLift.toFixed(1)} km</output></label></div><div className="sandbox-stat-grid"><Metric label="TRAJECTORY" value={trajectoryResult ? (trajectoryResult.feasible ? 'FEASIBLE' : 'INFEASIBLE') : 'PREVIEW'} /><Metric label="TERRAIN" value={routeResult ? `${routeResult.elevation_profile.length}` : '—'} meta="samples" /><Metric label="ROUTE" value={routeResult ? `${routeResult.distance_km.toFixed(1)} km` : '—'} /><Metric label="PLAYBACK" value={playing ? 'RUNNING' : 'PAUSED'} /></div><div className="sandbox-actions"><button className="action" onClick={() => setPlaying((p) => !p)}>{playing ? 'Pause Playback' : 'Play Playback'}</button><button className="action" onClick={() => setVisualParams({ verticalScale: 1.25, arcBias: 1, terrainLift: 0 })}>Reset Visual Model</button><button className="action" disabled={busy !== null || !!backendError} onClick={runAll}>Refresh Backend Results</button></div></Panel><Panel title="Live Unified Theater"><UnifiedTheater {...theaterProps} /></Panel><div className="sandbox-dual"><Panel title="Terrain Profile"><ElevationChart data={routeResult?.elevation_profile ?? []} selectedLeg={selectedWaypoint} /></Panel><Panel title="Explainability"><ul className="sandbox-insights"><li><span>01</span><strong>GROUNDING</strong><p>The map is the geographic ground plane. Waypoints, route and LOS stay anchored to their real latitude/longitude positions.</p></li><li><span>02</span><strong>ELEVATION</strong><p>The terrain samples are lifted above the map along the route so elevation becomes visible in the same frame.</p></li><li><span>03</span><strong>TRAJECTORY</strong><p>The displayed arc is an illustrative visualization anchored to the current origin and API-reported endpoint, not an operational firing solution.</p></li></ul></Panel></div></div></div>}
    </main></div>;
}

export default App;
