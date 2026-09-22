# KAVACH — Build Intent & Sync Spec
**Scope:** UI design system + API contract for cross-team synchronization (L0 Ontology, L1 System Dynamics, L2 Digital Twins, L3 Physics — owned by Harshaa).

---

## 1. Design Principles (read before building any screen)

Do **not** default to the generic "AI-generated app" look: no purple-to-blue gradients, no Inter/system-ui font, no floating glassmorphism cards, no soft drop-shadows on everything, no centered hero + 3-icon-grid layout, no rounded-full pill buttons, no emoji in the UI.

Instead:
- Sharp or minimally-rounded corners (0–3px radius max). This is a command-console product, not a landing page.
- Flat surfaces separated by 1px borders, not shadows.
- High information density — tables and monospaced/tabular numerals over big empty cards.
- Uppercase, letter-spaced labels for module headers and nav (industrial/console feel).
- No stock icon packs used decoratively — icons only where they carry information (status, alerts).

---

## 2. Color Palette

Source: fixed palette, do not introduce new hues — only tints/shades of these four.

| Token | Hex | Use |
|---|---|---|
| `--bg-primary` | `#0F3040` | App background, primary surface (dark navy-teal) |
| `--bg-secondary` | `#464858` | Panels, sidebars, card backgrounds, borders (slate) |
| `--accent-primary` | `#A56F63` | Active states, primary buttons, selected nav item, highlighted graph node (muted terracotta) |
| `--accent-secondary` | `#D99B7F` | Warnings, secondary highlights, data emphasis, hover states (warm tan) |
| `--text-primary` | `#EDE3DC` | Body text on dark surfaces (derived light tint, not pure white) |
| `--text-muted` | `#9AA1AE` | Secondary text, labels, timestamps (tint of `#464858`) |
| `--status-critical` | `#D99B7F` at full saturation + bold weight | Threshold breach / simulation failure — do not add a new red; use the existing warm accent at higher weight/contrast instead |
| `--divider` | `#464858` at 40% opacity | 1px borders between panels/table rows |

No white backgrounds anywhere. Dark surface is the default; the palette has no neutral light color to build a light theme from, so don't build one.

---

## 3. Typography

Mix exactly these six, each with one job — never mix two of them on the same element.

| Role | Font | Weight/Style | Where |
|---|---|---|---|
| Display / big module titles | **Bebas Neue** | Regular, all caps, +2px letter-spacing | Page hero titles, top-level module names (e.g. "SCENARIO CONSOLE") |
| Section headers / nav | **DIN 1451** (fallback: Roboto Condensed if unavailable) | Regular, all caps, +1px letter-spacing | Sidebar nav items, section dividers, table headers |
| Data tables / numeric readouts | **Roboto Condensed** | Regular for labels, Medium for values, tabular-nums | Stock levels, readiness %, trajectory outputs, all numeric panels |
| Body copy | **Open Sans** | Regular, 14–15px | Descriptions, explanation panel text, tooltips |
| UI chrome | **Public Sans** | Medium | Buttons, form labels, dropdowns, tags/badges |
| Emphasis / callouts | **Montserrat** | SemiBold | Alert banners, pull-quotes, the "why this flagged" explanation headline |

Never use a generic system font stack as fallback — if a font fails to load, fall back within this list (e.g. Roboto Condensed → Roboto Condensed → DIN-style condensed alternative), not to Arial/system-ui.

---

## 4. Layout Grid

- 12-column grid, 24px gutter, max content width 1440px.
- Persistent left sidebar (240px) for module navigation — Bebas Neue module names, Roboto Condensed sub-items.
- Top bar reserved for: current scenario name, classification/status indicator, user role — not a search bar or logo-centric branding.
- No single screen should be a single centered card. Every screen is a working console: at minimum a nav rail + a data panel + a detail/explanation panel (3-pane minimum for Scenario Console and Entity Explorer).

---

## 5. API Contract (cross-team sync)

All services expose REST/JSON behind a single gateway. Base path: `/api/v1`. Every entity reference uses the **ontology node ID** (`ont_id`) as the join key across all four layers — this is the one field every teammate's payloads must include.

### 5.1 Gateway (orchestration)
```
GET  /api/v1/entities/{ont_id}
     → { ont_id, type, label, relations: [{ont_id, relation, label}] }

GET  /api/v1/entities/search?q=&type=
     → { results: [{ont_id, type, label}] }

POST /api/v1/scenarios/run
     body: { scenario_id, stressor_type, params: {...} }
     → { scenario_id, status: "running" }

GET  /api/v1/scenarios/{scenario_id}/result
     → { scenario_id, status, l1_result, l2_result, l3_result, flags: [...] }
```

### 5.2 L0 — Ontology (existing, extend only)
```
GET  /api/v1/ontology/node/{ont_id}
POST /api/v1/ontology/node          — create/enrich a node
POST /api/v1/ontology/relation      — add a relationship
POST /api/v1/ontology/query         — raw SPARQL/Cypher passthrough (internal use)
```

### 5.3 L1 — System Dynamics (teammate A)
```
GET  /api/v1/dynamics/stock/{ont_id}
     → { ont_id, stock_name, current_level, unit, history: [{t, level}] }

POST /api/v1/dynamics/simulate
     body: { ont_id, stressor: {type, magnitude, duration}, horizon_days }
     → { projection: [{t, level}], breach: {t, threshold} | null }
```

### 5.4 L2 — Digital Twins (teammate B)
```
GET  /api/v1/twin/{ont_id}
     → { ont_id, platform_type, status, health_score, components: [{name, wear_pct, rul_days}] }

GET  /api/v1/twin/{ont_id}/telemetry?since=
     → { ont_id, stream: [{t, metric, value}] }

GET  /api/v1/twin/fleet/{platform_class}
     → { platform_class, total, mission_capable, degraded, unavailable }
```

### 5.5 L3 — Physics Simulation (Harshaa)
```
POST /api/v1/physics/trajectory
     body: { origin: {lat, lon, alt}, target: {lat, lon, alt}, platform_ont_id }
     → { feasible: bool, time_of_flight_s, intercept_point, notes }

POST /api/v1/physics/line-of-sight
     body: { observer: {lat, lon, alt}, target: {lat, lon, alt} }
     → { visible: bool, obstruction_range_km | null }

POST /api/v1/physics/route-validate
     body: { waypoints: [{lat, lon}], vehicle_type, terrain_source: "srtm" }
     → { feasible: bool, eta_hours, constraints_violated: [...] }

GET  /api/v1/physics/health
     → { status: "ok", srtm_loaded: bool }
```

**Contract rule for all three teammates:** every response that references a physical entity must carry `ont_id`. Every response that produces a flag/alert must carry a `reason` string traceable to the ontology relation or simulation step that triggered it — this feeds the Explanation Panel and must not be skipped for the sake of shipping faster.

---

## 6. Sync Checklist (before demo integration)

- [ ] All three services agree on the same `ont_id` values for the demo scenario's entities (pull from a shared seed file, not generated independently)
- [ ] Gateway can call all three `/health`-equivalent endpoints and get a clean response before scenario run
- [ ] Every module's UI uses only the fonts/colors in Sections 2–3 — no ad-hoc hex values or fallback fonts introduced mid-build
