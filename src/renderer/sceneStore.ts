// Shared scene store between App (owns the real scenario state) and
// Interactive3DLayer (a DOM-portal overlay mounted once at the AppShell
// level, outside App's component tree, alongside it as a sibling).
//
// Previously Interactive3DLayer had no direct access to App's React state,
// so it scraped the DOM: it looked up '.panel' elements by matching their
// title text ("Trajectory / Geometry", "Line-of-Sight") and read raw
// <input> values out of them, then wrote marker-drag edits back by faking
// native input/change events on those same elements to trigger React's
// onChange handlers.
//
// That only worked while the specific panels being scraped were actually
// mounted — but those panels only render in one of the app's three views
// (Scenario Console). In Entity Explorer and Physics Sandbox, the globe
// stayed mounted (UnifiedTheater renders in all three views) but the scrape
// silently returned nulls, so the 3D globe showed no trajectory, no LOS
// line and no waypoints there, and dragging a marker did nothing — even
// though the same state was visibly present in the 2D theater and side
// panels. This store replaces the DOM scrape with real state, published by
// App on every change regardless of which view is active.

import type { GlobePoint, GlobeScene } from './GlobeEngine';

export type SceneEditTarget = 'origin' | 'target' | 'observer' | 'losTarget' | 'waypoint';
export type SceneEdit = { target: SceneEditTarget; index: number; point: GlobePoint };

type SceneListener = (scene: GlobeScene) => void;
type EditHandler = (edit: SceneEdit) => void;

const EMPTY_SCENE: GlobeScene = { origin: null, target: null, observer: null, losTarget: null, waypoints: [] };

let currentScene: GlobeScene = EMPTY_SCENE;
const listeners = new Set<SceneListener>();
let editHandler: EditHandler | null = null;

export function publishScene(scene: GlobeScene): void {
  currentScene = scene;
  listeners.forEach((fn) => fn(currentScene));
}

export function getScene(): GlobeScene {
  return currentScene;
}

/** Subscribe to scene updates; fires immediately with the current scene, returns an unsubscribe function. */
export function subscribeScene(fn: SceneListener): () => void {
  listeners.add(fn);
  fn(currentScene);
  return () => listeners.delete(fn);
}

/** App registers the single active handler that maps an edit onto its real setters. */
export function registerSceneEditHandler(fn: EditHandler): () => void {
  editHandler = fn;
  return () => {
    if (editHandler === fn) editHandler = null;
  };
}

/** Interactive3DLayer calls this when the user drags a marker or applies the coordinate editor. */
export function editScene(edit: SceneEdit): void {
  editHandler?.(edit);
}

// ============================================================================
// ENGAGEMENT ANIMATION STATE (Phase 1)
// ============================================================================

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

type EngagementListener = (state: EngagementState) => void;

export type EngagementState = {
  events: EngagementEvent[];
  clock: number; // monotonic time in seconds since epoch (or relative start)
  playing: boolean;
  speed: number; // playback speed multiplier
};

const EMPTY_ENGAGEMENT_STATE: EngagementState = {
  events: [],
  clock: 0,
  playing: false,
  speed: 1.0,
};

let engagementState: EngagementState = EMPTY_ENGAGEMENT_STATE;
const engagementListeners = new Set<EngagementListener>();

function notifyEngagementListeners(): void {
  engagementListeners.forEach((fn) => fn(engagementState));
}

export function getEngagementState(): EngagementState {
  return engagementState;
}

/** Subscribe to engagement state updates; fires immediately, returns unsubscribe. */
export function subscribeEngagement(fn: EngagementListener): () => void {
  engagementListeners.add(fn);
  fn(engagementState);
  return () => engagementListeners.delete(fn);
}

/** Add a new engagement event (or replace if same id). */
export function addEngagementEvent(event: EngagementEvent): void {
  const idx = engagementState.events.findIndex((e) => e.id === event.id);
  if (idx >= 0) {
    engagementState.events[idx] = event;
  } else {
    engagementState.events.push(event);
  }
  notifyEngagementListeners();
}

/** Remove an engagement event by id. */
export function removeEngagementEvent(id: string): void {
  engagementState.events = engagementState.events.filter((e) => e.id !== id);
  notifyEngagementListeners();
}

/** Clear all engagement events. */
export function clearEngagementEvents(): void {
  engagementState.events = [];
  notifyEngagementListeners();
}

/** Update a specific event's status (e.g., pending -> in-flight -> impact -> done). */
export function updateEngagementStatus(id: string, status: EngagementEvent['status']): void {
  const evt = engagementState.events.find((e) => e.id === id);
  if (evt) {
    evt.status = status;
    notifyEngagementListeners();
  }
}

/** Set the global engagement clock (seconds). */
export function setEngagementClock(clock: number): void {
  engagementState.clock = clock;
  notifyEngagementListeners();
}

/** Advance the engagement clock by dt seconds (respecting playback speed). */
export function advanceEngagementClock(dt: number): void {
  if (engagementState.playing) {
    engagementState.clock += dt * engagementState.speed;
    notifyEngagementListeners();
  }
}

/** Toggle playback. */
export function setEngagementPlaying(playing: boolean): void {
  engagementState.playing = playing;
  notifyEngagementListeners();
}

/** Set playback speed multiplier. */
export function setEngagementSpeed(speed: number): void {
  engagementState.speed = speed;
  notifyEngagementListeners();
}

/** Reset clock to zero and stop. */
export function resetEngagementClock(): void {
  engagementState.clock = 0;
  engagementState.playing = false;
  notifyEngagementListeners();
}

/** Convenience: create an engagement event from a trajectory solver result. */
export function createEngagementFromTrajectory(
  id: string,
  faction: Faction,
  origin: GlobePoint,
  target: GlobePoint,
  timeOfFlightSec: number,
  launchOffsetSec: number = 0
): EngagementEvent {
  const now = engagementState.clock || Date.now() / 1000;
  const launchTime = now + launchOffsetSec;
  const impactTime = launchTime + timeOfFlightSec;

  // Generate waypoints along the arc for interpolation (reuse existing logic)
  const waypoints: GlobePoint[] = [];
  const steps = 48;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const arc = 4 * t * (1 - t);
    waypoints.push({
      lat: origin.lat + (target.lat - origin.lat) * t,
      lon: origin.lon + (target.lon - origin.lon) * t,
      alt: (origin.alt ?? 0) + ((target.alt ?? 0) - (origin.alt ?? 0)) * t + arc * 2500,
    });
  }

  return {
    id,
    faction,
    originLatLon: { lat: origin.lat, lon: origin.lon, alt: origin.alt ?? 0 },
    targetLatLon: { lat: target.lat, lon: target.lon, alt: target.alt ?? 0 },
    waypoints,
    launchTime,
    impactTime,
    status: 'pending',
  };
}