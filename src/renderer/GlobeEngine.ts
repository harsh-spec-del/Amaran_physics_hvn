import { TerrainMeshResponse, getTerrainMesh } from './api';

export type GlobePoint = { lat: number; lon: number; alt?: number };
export type GlobeScene = {
  origin: GlobePoint | null;
  target: GlobePoint | null;
  observer: GlobePoint | null;
  losTarget: GlobePoint | null;
  waypoints: GlobePoint[];
};
export type GlobeCamera = {
  yaw: number;
  pitch: number;
  distance: number;
  tx: number;
  ty: number;
  tz: number;
};
export type GlobeEngineState = {
  center: GlobePoint;
  mesh: TerrainMeshResponse | null;
  zoom: number;
  loading: boolean;
  degraded: boolean;
  patchKm: number;
  imageryLoaded: boolean;
};

type V3 = { x: number; y: number; z: number };
type Color = [number, number, number, number];
type Resources = {
  terrain: WebGLProgram;
  solid: WebGLProgram;
  terrainBuffer: WebGLBuffer;
  indexBuffer: WebGLBuffer;
  lineBuffer: WebGLBuffer;
  shapeBuffer: WebGLBuffer;
  pointBuffer: WebGLBuffer;
  indexCount: number;
  texture: WebGLTexture | null;
};
type PickResult = { x: number; y: number; behind: boolean };
type AtlasMeta = { zoom: number; centerX: number; centerY: number; radius: number };

// Engagement animation types
export type Faction = 'blue' | 'red';
export type EngagementEvent = {
  id: string;
  faction: Faction;
  originLatLon: { lat: number; lon: number; alt: number };
  targetLatLon: { lat: number; lon: number; alt: number };
  waypoints: GlobePoint[];
  launchTime: number;
  impactTime: number;
  status: 'pending' | 'in-flight' | 'impact' | 'done';
};
export type ImpactEffect = {
  eventId: string;
  position: V3;
  startTime: number;
  duration: number;
  faction: Faction;
};

const EARTH_KM = 6371.0088;
const DEG_KM = 111.32;
const FOV = 52 * Math.PI / 180;
const MIN_DISTANCE = 7;
const MAX_DISTANCE = 500;
const MIN_PATCH = 18;
const MAX_PATCH = 240;
const TILE_SIZE = 256;
const TILE_SERVER = 'https://tile.openstreetmap.org';
const tileCache = new Map<string, Promise<HTMLImageElement | null>>();

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const norm = (v: V3): V3 => { const l = Math.hypot(v.x, v.y, v.z) || 1; return { x: v.x / l, y: v.y / l, z: v.z / l }; };
const cross = (a: V3, b: V3): V3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const dot = (a: V3, b: V3) => a.x * b.x + a.y * b.y + a.z * b.z;
const add = (a: V3, b: V3): V3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const scale = (a: V3, s: number): V3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });

function mul4(a: Float32Array, b: Float32Array) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
}
function mulVec(m: Float32Array, v: V3) {
  return { x: m[0] * v.x + m[4] * v.y + m[8] * v.z + m[12], y: m[1] * v.x + m[5] * v.y + m[9] * v.z + m[13], z: m[2] * v.x + m[6] * v.y + m[10] * v.z + m[14], w: m[3] * v.x + m[7] * v.y + m[11] * v.z + m[15] };
}
function perspective(fov: number, aspect: number, near: number, far: number) {
  const f = 1 / Math.tan(fov / 2), nf = 1 / (near - far), m = new Float32Array(16);
  m[0] = f / aspect; m[5] = f; m[10] = (far + near) * nf; m[11] = -1; m[14] = 2 * far * near * nf;
  return m;
}
function lookAt(eye: V3, target: V3) {
  const z = norm(sub(eye, target));
  const up = Math.abs(z.y) > .98 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
  const x = norm(cross(up, z));
  const y = cross(z, x);
  const m = new Float32Array(16);
  m[0] = x.x; m[1] = y.x; m[2] = z.x; m[4] = x.y; m[5] = y.y; m[6] = z.y; m[8] = x.z; m[9] = y.z; m[10] = z.z;
  m[12] = -dot(x, eye); m[13] = -dot(y, eye); m[14] = -dot(z, eye); m[15] = 1;
  return m;
}
function cameraVP(c: GlobeCamera, width: number, height: number) {
  const cp = Math.cos(c.pitch), sp = Math.sin(c.pitch), cy = Math.cos(c.yaw), sy = Math.sin(c.yaw), horizontal = c.distance * cp;
  const eye = { x: c.tx + horizontal * sy, y: c.ty + c.distance * sp, z: c.tz + horizontal * cy };
  return mul4(perspective(FOV, width / Math.max(1, height), .05, 900), lookAt(eye, { x: c.tx, y: c.ty, z: c.tz }));
}

export function geoWorld(p: GlobePoint, center: GlobePoint): V3 {
  const lat0 = center.lat * Math.PI / 180;
  const east = (p.lon - center.lon) * DEG_KM * Math.cos(lat0);
  const north = (p.lat - center.lat) * DEG_KM;
  const theta = Math.hypot(east, north) / EARTH_KM;
  const bearing = Math.atan2(east, north);
  const radius = EARTH_KM + (p.alt ?? 0) / 1000;
  return { x: radius * Math.sin(theta) * Math.sin(bearing), y: radius * Math.cos(theta) - EARTH_KM, z: -radius * Math.sin(theta) * Math.cos(bearing) };
}
export function worldToGeo(x: number, z: number, center: GlobePoint): GlobePoint {
  const rho = Math.hypot(x, z), theta = rho / EARTH_KM, bearing = Math.atan2(x, -z), lat0 = center.lat * Math.PI / 180;
  const lat = Math.asin(Math.sin(lat0) * Math.cos(theta) + Math.cos(lat0) * Math.sin(theta) * Math.cos(bearing));
  const lon = (center.lon * Math.PI / 180) + Math.atan2(Math.sin(bearing) * Math.sin(theta) * Math.cos(lat0), Math.cos(theta) - Math.sin(lat0) * Math.sin(lat));
  return { lat: lat * 180 / Math.PI, lon: lon * 180 / Math.PI };
}
function chooseZoom(distance: number) { return Math.round(clamp(15 - Math.log2(Math.max(8, distance) / 8) * 1.25, 10, 15)); }
function chooseResolution(distance: number) { return distance < 24 ? 96 : distance < 70 ? 72 : distance < 150 ? 56 : 40; }
function patchSize(distance: number) { return clamp(distance * 2.8, MIN_PATCH, MAX_PATCH); }
function tileXY(lat: number, lon: number, zoom: number) { const n = 2 ** zoom, r = clamp(lat, -85.05112878, 85.05112878) * Math.PI / 180; return { x: ((lon + 180) / 360) * n, y: (1 - Math.asinh(Math.tan(r)) / Math.PI) * n / 2 }; }
function shader(gl: WebGL2RenderingContext, type: number, src: string) { const s = gl.createShader(type); if (!s) throw new Error('shader allocation failed'); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader compile failed'); return s; }
function makeProgram(gl: WebGL2RenderingContext, vs: string, fs: string) { const p = gl.createProgram(); if (!p) throw new Error('program allocation failed'); const v = shader(gl, gl.VERTEX_SHADER, vs), f = shader(gl, gl.FRAGMENT_SHADER, fs); gl.attachShader(p, v); gl.attachShader(p, f); gl.linkProgram(p); gl.deleteShader(v); gl.deleteShader(f); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'program link failed'); return p; }
function loadTile(url: string) { let p = tileCache.get(url); if (p) return p; p = new Promise<HTMLImageElement | null>(resolve => { const img = new Image(); img.crossOrigin = 'anonymous'; img.onload = () => resolve(img); img.onerror = () => resolve(null); img.src = url; }); tileCache.set(url, p); return p; }

function buildTerrain(mesh: TerrainMeshResponse, zoom: number) {
  const n = Math.max(2, mesh.resolution), verts = new Float32Array(n * n * 8), ids = new Uint32Array((n - 1) * (n - 1) * 6);
  const tileCenter = tileXY(mesh.center_lat, mesh.center_lon, zoom), radius = zoom >= 14 ? 1 : 2, atlasSize = radius * 2 + 1;
  const atlasOriginX = Math.floor(tileCenter.x) - radius, atlasOriginY = Math.floor(tileCenter.y) - radius;
  let vk = 0;
  for (let iy = 0; iy < n; iy++) for (let ix = 0; ix < n; ix++) {
    const u = ix / (n - 1), v = iy / (n - 1), north = mesh.height_km / 2 - mesh.height_km * v, east = -mesh.width_km / 2 + mesh.width_km * u;
    const theta = Math.hypot(east, north) / EARTH_KM, bearing = Math.atan2(east, north), lat0 = mesh.center_lat * Math.PI / 180, lon0 = mesh.center_lon * Math.PI / 180;
    const lat = Math.asin(Math.sin(lat0) * Math.cos(theta) + Math.cos(lat0) * Math.sin(theta) * Math.cos(bearing));
    const lon = lon0 + Math.atan2(Math.sin(bearing) * Math.sin(theta) * Math.cos(lat0), Math.cos(theta) - Math.sin(lat0) * Math.sin(theta));
    const latDeg = lat * 180 / Math.PI, lonDeg = lon * 180 / Math.PI, elevation = mesh.elevations_m[iy * n + ix] ?? 0, radiusWorld = EARTH_KM + elevation / 1000;
    const x = radiusWorld * Math.sin(theta) * Math.sin(bearing), z = -radiusWorld * Math.sin(theta) * Math.cos(bearing), y = radiusWorld * Math.cos(theta) - EARTH_KM;
    const sample = (a: number, b: number) => mesh.elevations_m[clamp(b, 0, n - 1) * n + clamp(a, 0, n - 1)] ?? elevation;
    const dx = Math.max(.1, mesh.width_km / Math.max(1, n - 1)), dz = Math.max(.1, mesh.height_km / Math.max(1, n - 1));
    const normal = norm({ x: -(sample(ix + 1, iy) - sample(ix - 1, iy)) / 1000 / dx, y: 1, z: (sample(ix, iy + 1) - sample(ix, iy - 1)) / 1000 / dz });
    const t = tileXY(latDeg, lonDeg, zoom), atlasU = (t.x - atlasOriginX) / atlasSize, atlasV = (t.y - atlasOriginY) / atlasSize;
    verts.set([x, y, z, normal.x, normal.y, normal.z, atlasU, atlasV], vk); vk += 8;
  }
  let ik = 0;
  for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) { const a = y * n + x, b = a + 1, c = a + n, d = c + 1; ids.set([a, b, c, b, d, c], ik); ik += 6; }
  return { vertices: verts, indices: ids };
}

function pushVertex(out: number[], p: V3, n: V3, c: Color) { out.push(p.x, p.y, p.z, n.x, n.y, n.z, c[0], c[1], c[2], c[3]); }
function pushTri(out: number[], a: V3, b: V3, c: V3, color: Color, normal?: V3) { const n = normal ?? norm(cross(sub(b, a), sub(c, a))); pushVertex(out, a, n, color); pushVertex(out, b, n, color); pushVertex(out, c, n, color); }
function appendSphere(out: number[], center: V3, radius: number, color: Color, segments = 12, rings = 7) {
  for (let y = 0; y < rings; y++) for (let x = 0; x < segments; x++) {
    const phi0 = y / rings * Math.PI, phi1 = (y + 1) / rings * Math.PI, th0 = x / segments * Math.PI * 2, th1 = (x + 1) / segments * Math.PI * 2;
    const p00 = { x: center.x + radius * Math.sin(phi0) * Math.cos(th0), y: center.y + radius * Math.cos(phi0), z: center.z + radius * Math.sin(phi0) * Math.sin(th0) };
    const p10 = { x: center.x + radius * Math.sin(phi0) * Math.cos(th1), y: center.y + radius * Math.cos(phi0), z: center.z + radius * Math.sin(phi0) * Math.sin(th1) };
    const p01 = { x: center.x + radius * Math.sin(phi1) * Math.cos(th0), y: center.y + radius * Math.cos(phi1), z: center.z + radius * Math.sin(phi1) * Math.sin(th0) };
    const p11 = { x: center.x + radius * Math.sin(phi1) * Math.cos(th1), y: center.y + radius * Math.cos(phi1), z: center.z + radius * Math.sin(phi1) * Math.sin(th1) };
    const n0 = norm({ x: Math.sin(phi0) * Math.cos(th0), y: Math.cos(phi0), z: Math.sin(phi0) * Math.sin(th0) });
    const n1 = norm({ x: Math.sin(phi0) * Math.cos(th1), y: Math.cos(phi0), z: Math.sin(phi0) * Math.sin(th1) });
    pushTri(out, p00, p01, p11, color, n0); pushTri(out, p00, p11, p10, color, n1);
  }
}
function appendTube(out: number[], points: V3[], radius: number, color: Color, sides = 7) {
  if (points.length < 2) return;
  const rings: V3[][] = [];
  for (let i = 0; i < points.length; i++) {
    const tangent = norm(sub(points[Math.min(points.length - 1, i + 1)], points[Math.max(0, i - 1)]));
    const helper = Math.abs(tangent.y) > .92 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
    const side = norm(cross(tangent, helper)), up = norm(cross(side, tangent)), ring: V3[] = [];
    for (let j = 0; j < sides; j++) { const a = j / sides * Math.PI * 2; ring.push(add(points[i], scale(add(scale(side, Math.cos(a)), scale(up, Math.sin(a))), radius))); }
    rings.push(ring);
  }
  for (let i = 0; i < rings.length - 1; i++) for (let j = 0; j < sides; j++) {
    const a = rings[i][j], b = rings[i][(j + 1) % sides], c = rings[i + 1][j], d = rings[i + 1][(j + 1) % sides];
    pushTri(out, a, c, d, color); pushTri(out, a, d, b, color);
  }
}
function appendLineVertices(out: number[], a: V3, b: V3, color: Color) { out.push(a.x, a.y, a.z, 0, 1, 0, ...color, b.x, b.y, b.z, 0, 1, 0, ...color); }
function interpolatedPoint(a: GlobePoint, b: GlobePoint, t: number, lift: number): GlobePoint { const arc = 4 * t * (1 - t); return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t, alt: (a.alt ?? 0) + ((b.alt ?? 0) - (a.alt ?? 0)) * t + lift * arc }; }

// Faction color mapping using existing palette tokens
function factionColor(faction: Faction): Color {
  // Blue: accent-primary #A56F63 at higher brightness/saturation for own side
  // Red: accent-secondary #D99B7F for opposing side
  if (faction === 'blue') return [0.65, 0.45, 0.38, 1.0];  // muted terracotta
  return [0.85, 0.61, 0.50, 1.0];  // warm tan
}

function factionColorBright(faction: Faction): Color {
  if (faction === 'blue') return [0.85, 0.65, 0.55, 1.0];
  return [1.0, 0.85, 0.70, 1.0];
}

function factionColorDim(faction: Faction): Color {
  if (faction === 'blue') return [0.45, 0.30, 0.25, 0.6];
  return [0.60, 0.40, 0.32, 0.6];
}

export class GlobeEngine {
  private gl: WebGL2RenderingContext;
  private canvas: HTMLCanvasElement;
  private r: Resources;
  private center: GlobePoint;
  private mesh: TerrainMeshResponse | null = null;
  private generation = 0;
  private atlasMeta: AtlasMeta | null = null;
  public state: GlobeEngineState;
  public onState: (state: GlobeEngineState) => void = () => {};

  // Engagement animation state
  private engagementEvents: EngagementEvent[] = [];
  private impactEffects: ImpactEffect[] = [];
  private lastFrameTime = 0;

  constructor(canvas: HTMLCanvasElement, center: GlobePoint) {
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WEBGL2 unavailable');
    this.gl = gl; this.canvas = canvas; this.center = { ...center };
    this.state = { center: this.center, mesh: null, zoom: 13, loading: false, degraded: false, patchKm: 40, imageryLoaded: false };
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.disable(gl.CULL_FACE); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this.r = {
      terrain: makeProgram(gl, '#version 300 es\nprecision highp float;layout(location=0)in vec3 p;layout(location=1)in vec3 n;layout(location=2)in vec2 uv;uniform mat4 uVP;out vec3 N;out vec2 UV;void main(){N=n;UV=uv;gl_Position=uVP*vec4(p,1.0);}', '#version 300 es\nprecision highp float;uniform sampler2D uTex;uniform float uHasTex;uniform vec3 uLight;in vec3 N;in vec2 UV;out vec4 O;void main(){float lam=max(dot(normalize(N),normalize(uLight)),0.0);float l=.30+.88*lam;vec3 base=vec3(.10,.16,.14);if(uHasTex>.5)base=mix(base,texture(uTex,UV).rgb,.90);O=vec4(base*l,1.0);}'),
      solid: makeProgram(gl, '#version 300 es\nprecision highp float;layout(location=0)in vec3 p;layout(location=1)in vec3 n;layout(location=2)in vec4 c;uniform mat4 uVP;out vec3 N;out vec4 C;void main(){N=n;C=c;gl_Position=uVP*vec4(p,1.0);}', '#version 300 es\nprecision highp float;uniform vec3 uLight;in vec3 N;in vec4 C;out vec4 O;void main(){float lam=max(dot(normalize(N),normalize(uLight)),0.0);float l=.34+.92*lam;O=vec4(C.rgb*l,C.a);}'),
      terrainBuffer: gl.createBuffer()!, indexBuffer: gl.createBuffer()!, lineBuffer: gl.createBuffer()!, shapeBuffer: gl.createBuffer()!, pointBuffer: gl.createBuffer()!, indexCount: 0, texture: null,
    };
  }
  destroy() { const gl = this.gl; gl.deleteTexture(this.r.texture); gl.deleteBuffer(this.r.terrainBuffer); gl.deleteBuffer(this.r.indexBuffer); gl.deleteBuffer(this.r.lineBuffer); gl.deleteBuffer(this.r.shapeBuffer); gl.deleteBuffer(this.r.pointBuffer); gl.deleteProgram(this.r.terrain); gl.deleteProgram(this.r.solid); }
  resize() { const b = this.canvas.getBoundingClientRect(), d = Math.min(window.devicePixelRatio || 1, 2); this.canvas.width = Math.max(1, Math.floor(b.width * d)); this.canvas.height = Math.max(1, Math.floor(b.height * d)); this.gl.viewport(0, 0, this.canvas.width, this.canvas.height); }
  getCenter() { return { ...this.center }; }
  getMesh() { return this.mesh; }
  getMinDistance() { return MIN_DISTANCE; }
  getMaxDistance() { return MAX_DISTANCE; }
  project(camera: GlobeCamera, p: GlobePoint, width: number, height: number): PickResult | null { const q = mulVec(cameraVP(camera, width, height), geoWorld(p, this.center)); if (q.w <= 0) return null; return { x: (q.x / q.w * .5 + .5) * width, y: (1 - (q.y / q.w * .5 + .5)) * height, behind: false }; }
  screenToGeo(camera: GlobeCamera, x: number, y: number, width: number, height: number) { const nx = x / Math.max(1, width) - .5, ny = y / Math.max(1, height) - .5, span = camera.distance * Math.tan(FOV / 2), aspect = width / Math.max(1, height), fx = -Math.sin(camera.yaw), fz = -Math.cos(camera.yaw), rx = Math.cos(camera.yaw), rz = -Math.sin(camera.yaw); const wx = camera.tx + rx * (nx * 2 * span * aspect) - fx * (ny * 2 * span), wz = camera.tz + rz * (nx * 2 * span * aspect) - fz * (ny * 2 * span); return worldToGeo(wx, wz, this.center); }
  private elevationAt(p: GlobePoint) {
    if (!this.mesh) return 0;
    const north = (p.lat - this.mesh.center_lat) * DEG_KM, east = (p.lon - this.mesh.center_lon) * DEG_KM * Math.cos(this.mesh.center_lat * Math.PI / 180);
    const fx = clamp((east + this.mesh.width_km / 2) / this.mesh.width_km, 0, 1) * (this.mesh.resolution - 1), fy = clamp((this.mesh.height_km / 2 - north) / this.mesh.height_km, 0, 1) * (this.mesh.resolution - 1);
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(this.mesh.resolution - 1, x0 + 1), y1 = Math.min(this.mesh.resolution - 1, y0 + 1), tx = fx - x0, ty = fy - y0;
    const at = (x: number, y: number) => this.mesh?.elevations_m[y * this.mesh.resolution + x] ?? 0, a = at(x0, y0), b = at(x1, y0), c = at(x0, y1), d = at(x1, y1);
    return a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
  }

  async load(center: GlobePoint, distance: number) {
    const requestId = ++this.generation, size = patchSize(distance), zoom = chooseZoom(distance), resolution = chooseResolution(distance);
    this.state = { ...this.state, center: { ...center }, zoom, loading: true, patchKm: size }; this.onState(this.state);
    try {
      const mesh = await getTerrainMesh({ center_lat: center.lat, center_lon: center.lon, width_km: size, height_km: size, resolution });
      if (requestId !== this.generation) return;
      const built = buildTerrain(mesh, zoom); this.mesh = mesh; this.center = { ...center }; const gl = this.gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.r.terrainBuffer); gl.bufferData(gl.ARRAY_BUFFER, built.vertices, gl.STATIC_DRAW); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.r.indexBuffer); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, built.indices, gl.STATIC_DRAW); this.r.indexCount = built.indices.length;
      this.state = { ...this.state, center: this.center, mesh, loading: false, degraded: mesh.degraded, zoom, patchKm: size }; this.onState(this.state); void this.loadImagery(mesh, zoom, requestId);
    } catch {
      if (requestId === this.generation) { this.state = { ...this.state, loading: false, degraded: true }; this.onState(this.state); }
    }
  }

  private async loadImagery(mesh: TerrainMeshResponse, zoom: number, requestId: number) {
    const gl = this.gl, center = tileXY(mesh.center_lat, mesh.center_lon, zoom), cx = Math.floor(center.x), cy = Math.floor(center.y), radius = zoom >= 14 ? 1 : 2, size = radius * 2 + 1;
    const atlas = document.createElement('canvas'); atlas.width = atlas.height = size * TILE_SIZE; const ctx = atlas.getContext('2d'); if (!ctx) return;
    ctx.fillStyle = '#23342e'; ctx.fillRect(0, 0, atlas.width, atlas.height); const n = 2 ** zoom; const jobs: Promise<boolean>[] = [];
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) { const tx = ((cx + dx) % n + n) % n, ty = cy + dy; if (ty < 0 || ty >= n) continue; jobs.push(loadTile(`${TILE_SERVER}/${zoom}/${tx}/${ty}.png`).then(img => { if (img) { ctx.drawImage(img, (dx + radius) * TILE_SIZE, (dy + radius) * TILE_SIZE, TILE_SIZE, TILE_SIZE); return true; } return false; })); }
    const results = await Promise.all(jobs); if (requestId !== this.generation) return;
    const imageryLoaded = results.some(Boolean);
    const texture = this.r.texture ?? gl.createTexture(); if (!texture) return; this.r.texture = texture; this.atlasMeta = { zoom, centerX: cx, centerY: cy, radius };
    gl.bindTexture(gl.TEXTURE_2D, texture); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas); gl.generateMipmap(gl.TEXTURE_2D); gl.bindTexture(gl.TEXTURE_2D, null);
    this.state = { ...this.state, imageryLoaded }; this.onState(this.state);
  }

  maybeRecenter(camera: GlobeCamera) { if (!this.mesh) return false; const threshold = this.mesh.width_km * .30; if (Math.hypot(camera.tx, camera.tz) < threshold) return false; const p = worldToGeo(camera.tx, camera.tz, this.center); camera.tx = 0; camera.tz = 0; void this.load(p, camera.distance); return true; }
  private drawTerrain(vp: Float32Array) {
    const gl = this.gl; gl.useProgram(this.r.terrain); gl.bindBuffer(gl.ARRAY_BUFFER, this.r.terrainBuffer); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 32, 0); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 32, 12); gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 32, 24); gl.uniformMatrix4fv(gl.getUniformLocation(this.r.terrain, 'uVP'), false, vp); gl.uniform3f(gl.getUniformLocation(this.r.terrain, 'uLight'), -.42, .92, .24); gl.uniform1f(gl.getUniformLocation(this.r.terrain, 'uHasTex'), this.r.texture ? 1 : 0);
    if (this.r.texture) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.r.texture); gl.uniform1i(gl.getUniformLocation(this.r.terrain, 'uTex'), 0); }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.r.indexBuffer); gl.drawElements(gl.TRIANGLES, this.r.indexCount, gl.UNSIGNED_INT, 0);
  }
  private drawSolid(vp: Float32Array, data: number[]) {
    if (!data.length) return; const gl = this.gl; gl.useProgram(this.r.solid); gl.bindBuffer(gl.ARRAY_BUFFER, this.r.shapeBuffer); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.DYNAMIC_DRAW); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 40, 0); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 40, 12); gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 40, 24); gl.uniformMatrix4fv(gl.getUniformLocation(this.r.solid, 'uVP'), false, vp); gl.uniform3f(gl.getUniformLocation(this.r.solid, 'uLight'), -.52, .88, .35); gl.drawArrays(gl.TRIANGLES, 0, data.length / 10);
  }
  private drawLineLayer(vp: Float32Array, data: number[]) {
    if (!data.length) return; const gl = this.gl; gl.useProgram(this.r.solid); gl.bindBuffer(gl.ARRAY_BUFFER, this.r.lineBuffer); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.DYNAMIC_DRAW); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 40, 0); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 40, 12); gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 40, 24); gl.uniformMatrix4fv(gl.getUniformLocation(this.r.solid, 'uVP'), false, vp); gl.uniform3f(gl.getUniformLocation(this.r.solid, 'uLight'), 0, 1, 0); gl.drawArrays(gl.LINES, 0, data.length / 10);
  }

  // Public API for engagement animation
  setEngagementEvents(events: EngagementEvent[]): void {
    this.engagementEvents = events;
  }

  // Called each frame to update animation state
  private updateEngagementAnimation(currentTime: number): void {
    const dt = this.lastFrameTime ? (currentTime - this.lastFrameTime) / 1000 : 0;
    this.lastFrameTime = currentTime;

    // Update impact effects
    this.impactEffects = this.impactEffects.filter(eff => currentTime - eff.startTime < eff.duration);

    // Check for new impacts
    for (const evt of this.engagementEvents) {
      if (evt.status === 'in-flight' && currentTime >= evt.impactTime) {
        // Trigger impact effect
        const targetPos = geoWorld(evt.targetLatLon, this.center);
        this.impactEffects.push({
          eventId: evt.id,
          position: targetPos,
          startTime: currentTime,
          duration: 2.0, // 2 second impact VFX
          faction: evt.faction,
        });
        evt.status = 'impact';
      }
    }
  }

  // Interpolate position along waypoints at normalized time t (0-1)
  private interpolateWaypoints(waypoints: GlobePoint[], t: number): GlobePoint {
    if (waypoints.length < 2) return waypoints[0] ?? { lat: 0, lon: 0, alt: 0 };
    const clampedT = clamp(t, 0, 1);
    const segmentCount = waypoints.length - 1;
    const segmentIndex = Math.min(Math.floor(clampedT * segmentCount), segmentCount - 1);
    const segmentT = (clampedT * segmentCount) - segmentIndex;
    const a = waypoints[segmentIndex];
    const b = waypoints[segmentIndex + 1];
    return {
      lat: a.lat + (b.lat - a.lat) * segmentT,
      lon: a.lon + (b.lon - a.lon) * segmentT,
      alt: (a.alt ?? 0) + ((b.alt ?? 0) - (a.alt ?? 0)) * segmentT,
    };
  }

  draw(camera: GlobeCamera, scene: GlobeScene, currentTime: number = performance.now()) {
    const gl = this.gl; gl.clearColor(.012, .028, .042, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); if (!this.mesh || this.r.indexCount === 0) return;
    const vp = cameraVP(camera, this.canvas.width, this.canvas.height); this.drawTerrain(vp);

    // Update animation state
    this.updateEngagementAnimation(currentTime);

    const routeLines: number[] = [];
    const addRouteSegment = (a: GlobePoint, b: GlobePoint, offsetMeters: number, color: Color) => { const qa = geoWorld({ ...a, alt: this.elevationAt(a) + offsetMeters }, this.center), qb = geoWorld({ ...b, alt: this.elevationAt(b) + offsetMeters }, this.center); appendLineVertices(routeLines, qa, qb, color); };
    for (let i = 1; i < scene.waypoints.length; i++) addRouteSegment(scene.waypoints[i - 1], scene.waypoints[i], 55, [.86, .76, .66, .78]);
    if (scene.origin && scene.target) addRouteSegment(scene.origin, scene.target, 80, [.93, .69, .58, .72]);
    if (scene.observer && scene.losTarget) addRouteSegment(scene.observer, scene.losTarget, 110, [.43, .74, .99, .84]);
    this.drawLineLayer(vp, routeLines);

    const shapeData: number[] = [], stemLines: number[] = [];
    const addNode = (point: GlobePoint, color: Color, radiusMeters: number) => {
      const terrain = this.elevationAt(point), nodeAlt = Math.max(point.alt ?? terrain, terrain) + 18;
      const base = geoWorld({ ...point, alt: terrain + 10 }, this.center), head = geoWorld({ ...point, alt: nodeAlt }, this.center);
      appendLineVertices(stemLines, base, head, [color[0], color[1], color[2], .62]); appendSphere(shapeData, head, radiusMeters / 1000, color, 12, 8);
      appendSphere(shapeData, geoWorld({ ...point, alt: terrain + 26 }, this.center), Math.max(.045, radiusMeters / 1000 * .62), [color[0], color[1], color[2], .22], 10, 6);
    };
    if (scene.origin) addNode(scene.origin, [.94, .31, .27, 1], 105);
    if (scene.target) addNode(scene.target, [.98, .74, .34, 1], 112);
    if (scene.observer) addNode(scene.observer, [.35, .73, 1, 1], 98);
    if (scene.losTarget) addNode(scene.losTarget, [.63, .86, 1, 1], 92);
    scene.waypoints.forEach(p => addNode(p, [.52, .86, .67, 1], 78));
    this.drawLineLayer(vp, stemLines); this.drawSolid(vp, shapeData);

    // Draw static trajectory arcs (faded)
    if (scene.origin && scene.target) {
      const a = scene.origin, b = scene.target;
      const distance = Math.hypot((b.lat - a.lat) * DEG_KM, (b.lon - a.lon) * DEG_KM * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180));
      const visualLift = clamp(500 + distance * 18, 500, 2200), samples: V3[] = [];
      for (let i = 0; i < 48; i++) { const t = i / 47; samples.push(geoWorld(interpolatedPoint(a, b, t, visualLift), this.center)); }
      const trajData: number[] = []; appendTube(trajData, samples, .045, [.98, .58, .34, .35], 8); this.drawSolid(vp, trajData);
      const breadcrumbData: number[] = []; for (let i = 4; i < samples.length - 1; i += 5) appendSphere(breadcrumbData, samples[i], .095, [1, .76, .46, .50], 8, 5); this.drawSolid(vp, breadcrumbData);
    }

    // Draw engagement events (animated projectiles + impact VFX)
    this.drawEngagements(vp, currentTime);
  }

  private drawEngagements(vp: Float32Array, currentTime: number): void {
    // Draw projectile markers for in-flight engagements
    for (const evt of this.engagementEvents) {
      if (evt.status !== 'in-flight' && evt.status !== 'pending') continue;

      const progress = evt.impactTime > evt.launchTime
        ? clamp((currentTime - evt.launchTime) / (evt.impactTime - evt.launchTime), 0, 1)
        : 1;

      if (progress <= 0) continue; // not launched yet

      const pos = this.interpolateWaypoints(evt.waypoints, progress);
      const pos3d = geoWorld(pos, this.center);
      const color = factionColorBright(evt.faction);

      // Draw projectile as a small sphere
      const projData: number[] = [];
      appendSphere(projData, pos3d, 0.12, color, 10, 6);
      this.drawSolid(vp, projData);

      // Draw trail behind projectile (last 20% of path)
      if (progress > 0.1) {
        const trailPoints: V3[] = [];
        const trailSteps = 12;
        for (let i = 0; i <= trailSteps; i++) {
          const t = progress - (progress * 0.2) * (i / trailSteps);
          if (t <= 0) break;
          const tp = this.interpolateWaypoints(evt.waypoints, t);
          trailPoints.push(geoWorld(tp, this.center));
        }
        if (trailPoints.length >= 2) {
          const trailData: number[] = [];
          const trailColor = [...factionColorDim(evt.faction)] as Color;
          appendTube(trailData, trailPoints, 0.035, trailColor, 6);
          this.drawSolid(vp, trailData);
        }
      }
    }

    // Draw impact effects (expanding ring + particle burst)
    for (const eff of this.impactEffects) {
      const age = currentTime - eff.startTime;
      const progress = age / eff.duration;
      if (progress >= 1) continue;

      const color = factionColorBright(eff.faction);
      const baseRadius = 0.3 + progress * 2.5; // km
      const opacity = 1 - progress;

      // Expanding ring
      const ringData: number[] = [];
      const ringColor: Color = [color[0], color[1], color[2], opacity * 0.6];
      const ringRadius = baseRadius / 1000; // convert km to world units
      appendSphere(ringData, eff.position, ringRadius, ringColor, 24, 1);
      this.drawSolid(vp, ringData);

      // Particle burst (fading points)
      const particleCount = 24;
      const particleData: number[] = [];
      for (let i = 0; i < particleCount; i++) {
        const angle = (i / particleCount) * Math.PI * 2;
        const radius = baseRadius * 0.5 * progress;
        const px = eff.position.x + (radius / 1000) * Math.cos(angle);
        const pz = eff.position.z + (radius / 1000) * Math.sin(angle);
        const py = eff.position.y + (Math.random() - 0.5) * 0.002;
        const pColor: Color = [color[0], color[1], color[2], opacity * 0.8];
        appendSphere(particleData, { x: px, y: py, z: pz }, 0.06, pColor, 6, 4);
      }
      this.drawSolid(vp, particleData);
    }
  }
}