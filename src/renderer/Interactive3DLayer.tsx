import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { GlobeCamera, GlobeEngine, GlobePoint, GlobeScene, clamp, EngagementEvent, Faction } from './GlobeEngine';
import { editScene, getScene, subscribeScene, getEngagementState, subscribeEngagement, addEngagementEvent, createEngagementFromTrajectory, setEngagementPlaying, setEngagementClock, resetEngagementClock, type EngagementState } from './sceneStore';
import './styles/interactive-inputs.css';

type Scene = GlobeScene;
type DragMode = 'orbit' | 'pan' | 'marker';
type Drag = { mode: DragMode; index: number; lastX: number; lastY: number; pointType?: 'origin' | 'target' | 'observer' | 'losTarget' | 'waypoint' };

type TrajectoryEditorState = {
  origin: GlobePoint;
  target: GlobePoint;
};

const baseBtn: React.CSSProperties = { width: 42, height: 38, border: '1px solid rgba(217,155,127,.4)', background: 'rgba(8,25,35,.96)', color: '#ead8cf', font: '14px Roboto Condensed,Arial,sans-serif', cursor: 'pointer', boxShadow: '0 5px 16px rgba(0,0,0,.3)' };
const smallBtn: React.CSSProperties = { ...baseBtn, height: 32, fontSize: 10, letterSpacing: '1px' };
const editorInput: React.CSSProperties = { width: '100%', boxSizing: 'border-box', border: '1px solid rgba(217,155,127,.25)', background: 'rgba(5,17,24,.94)', color: '#e8dfda', padding: '7px 8px', font: '11px Roboto Mono,Consolas,monospace', outline: 'none' };

function sceneCenter(s: Scene): GlobePoint { const pts = [s.origin, s.target, s.observer, s.losTarget, ...s.waypoints].filter((p): p is GlobePoint => !!p); return pts.length ? { lat: pts.reduce((a, p) => a + p.lat, 0) / pts.length, lon: pts.reduce((a, p) => a + p.lon, 0) / pts.length } : { lat: 34.11, lon: 77.61 }; }
function lodBand(distance:number) { return distance < 24 ? 3 : distance < 70 ? 2 : distance < 150 ? 1 : 0; }
function nearestMarker(engine: GlobeEngine, camera: GlobeCamera, canvas: HTMLCanvasElement, scene: Scene, x:number, y:number) { const all: Array<{point:GlobePoint,type:Drag['pointType'],index:number}> = []; if(scene.origin)all.push({point:scene.origin,type:'origin',index:0}); if(scene.target)all.push({point:scene.target,type:'target',index:0}); if(scene.observer)all.push({point:scene.observer,type:'observer',index:0}); if(scene.losTarget)all.push({point:scene.losTarget,type:'losTarget',index:0}); scene.waypoints.forEach((p,i)=>all.push({point:p,type:'waypoint',index:i})); let best:null|{point:GlobePoint,type:Drag['pointType'],index:number,d:number}=null; for(const m of all){const q=engine.project(camera,m.point,canvas.width,canvas.height);if(!q||q.behind)continue;const d=Math.hypot(q.x-x,q.y-y);if(d<28&&(!best||d<best.d))best={...m,d};} return best; }


function CoordinateEditor({ scene, onApply }: { scene: Scene; onApply: (next: TrajectoryEditorState) => void }) {
  const [draft, setDraft] = useState<TrajectoryEditorState>({
    origin: scene.origin ?? { lat: 34.1526, lon: 77.5771, alt: 3500 },
    target: scene.target ?? { lat: 34.05, lon: 77.65, alt: 4500 },
  });

  useEffect(() => {
    if (scene.origin && scene.target) setDraft({ origin: scene.origin, target: scene.target });
  }, [scene.origin?.lat, scene.origin?.lon, scene.origin?.alt, scene.target?.lat, scene.target?.lon, scene.target?.alt]);

  const update = (kind: 'origin' | 'target', field: keyof GlobePoint, value: number) => {
    setDraft(prev => ({ ...prev, [kind]: { ...prev[kind], [field]: value } }));
  };
  const finite = (v: number) => Number.isFinite(v);
  const valid = finite(draft.origin.lat) && finite(draft.origin.lon) && finite(draft.origin.alt ?? 0) && finite(draft.target.lat) && finite(draft.target.lon) && finite(draft.target.alt ?? 0) && Math.abs(draft.origin.lat) <= 90 && Math.abs(draft.target.lat) <= 90 && Math.abs(draft.origin.lon) <= 180 && Math.abs(draft.target.lon) <= 180;

  return <div style={{ position: 'absolute', left: 12, top: 58, width: 314, zIndex: 110, padding: '11px 12px 12px', background: 'rgba(8,25,35,.95)', border: '1px solid rgba(217,155,127,.30)', boxShadow: '0 10px 28px rgba(0,0,0,.38)', color: '#e8dfda', fontFamily: 'Roboto Condensed,Arial,sans-serif' }} onPointerDown={e => e.stopPropagation()} onWheel={e => e.stopPropagation()}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
      <div style={{ fontSize: 11, letterSpacing: '1.4px' }}>TRAJECTORY COORDINATES</div>
      <div style={{ fontSize: 8, letterSpacing: '1px', opacity: .62 }}>3D VISUALIZATION</div>
    </div>
    <div style={{ fontSize: 8, lineHeight: 1.4, opacity: .65, marginBottom: 10 }}>Enter the endpoints used by the theater visualization. Altitude is metres above the local reference surface.</div>
    {(['origin','target'] as const).map(kind => {
      const p = draft[kind];
      const title = kind === 'origin' ? 'ORIGIN' : 'TARGET';
      return <div key={kind} style={{ marginBottom: 9 }}>
        <div style={{ fontSize: 9, letterSpacing: '1px', marginBottom: 5, opacity: .8 }}>{title}</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 5 }}>
          <label><span style={{ display: 'block', fontSize: 7, opacity: .5, marginBottom: 3 }}>LAT</span><input aria-label={`${title} latitude`} style={editorInput} type="number" step="any" min="-90" max="90" value={Number.isFinite(p.lat) ? p.lat : ''} onChange={e => update(kind,'lat',Number(e.target.value))}/></label>
          <label><span style={{ display: 'block', fontSize: 7, opacity: .5, marginBottom: 3 }}>LON</span><input aria-label={`${title} longitude`} style={editorInput} type="number" step="any" min="-180" max="180" value={Number.isFinite(p.lon) ? p.lon : ''} onChange={e => update(kind,'lon',Number(e.target.value))}/></label>
          <label><span style={{ display: 'block', fontSize: 7, opacity: .5, marginBottom: 3 }}>ALT M</span><input aria-label={`${title} altitude`} style={editorInput} type="number" step="any" value={Number.isFinite(p.alt ?? 0) ? (p.alt ?? 0) : ''} onChange={e => update(kind,'alt',Number(e.target.value))}/></label>
        </div>
      </div>;
    })}
    <button type="button" disabled={!valid} onClick={() => onApply(draft)} style={{ width: '100%', height: 32, border: '1px solid rgba(217,155,127,.42)', background: valid ? 'rgba(122,73,55,.72)' : 'rgba(80,80,80,.35)', color: '#f3e8e1', cursor: valid ? 'pointer' : 'not-allowed', font: '10px Roboto Condensed,Arial,sans-serif', letterSpacing: '1.2px' }}>APPLY TO 3D SCENE</button>
  </div>;
}

function EngagementPlaybackControls({ state, onPlayPause, onStop, onScrub }: { 
  state: EngagementState; 
  onPlayPause: () => void; 
  onStop: () => void; 
  onScrub: (time: number) => void;
}) {
  const hasActive = state.events.some(e => e.status === 'in-flight' || e.status === 'pending');
  const maxTime = state.events.length > 0 ? Math.max(...state.events.map(e => e.impactTime)) : state.clock + 10;
  const minTime = state.events.length > 0 ? Math.min(...state.events.map(e => e.launchTime)) : state.clock;
  
  return <div style={{
    position: 'absolute', left: 12, bottom: 58, width: 314, zIndex: 110, 
    padding: '11px 12px 12px', background: 'rgba(8,25,35,.95)', 
    border: '1px solid rgba(217,155,127,.30)', boxShadow: '0 10px 28px rgba(0,0,0,.38)', 
    color: '#e8dfda', fontFamily: 'Roboto Condensed,Arial,sans-serif'
  }}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
      <div style={{ fontSize: 11, letterSpacing: '1.4px' }}>ENGAGEMENT PLAYBACK</div>
      <div style={{ fontSize: 8, letterSpacing: '1px', opacity: .62 }}>TIME: {state.clock.toFixed(1)}s</div>
    </div>
    <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
      <button onClick={onPlayPause} style={{...baseBtn, flex: 1}}>{state.playing ? 'PAUSE' : 'PLAY'}</button>
      <button onClick={onStop} style={{...smallBtn, flex: 1}}>STOP</button>
    </div>
    <div style={{ marginBottom: 8 }}>
      <label style={{ display: 'block', fontSize: 9, letterSpacing: '1px', marginBottom: 4, opacity: .8 }}>SCRUB TIMELINE</label>
      <input 
        type="range" 
        min={minTime.toFixed(1)} 
        max={maxTime.toFixed(1)} 
        step="0.1"
        value={state.clock.toFixed(1)}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => onScrub(Number(e.target.value))}
        style={{ width: '100%', accentColor: '#A56F63' }}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 8, opacity: .6, marginTop: 2 }}>
        <span>{minTime.toFixed(1)}s</span>
        <span>{maxTime.toFixed(1)}s</span>
      </div>
    </div>
    <div style={{ fontSize: 9, opacity: .7, lineHeight: 1.4 }}>
      {state.events.map(e => (
        <div key={e.id} style={{ marginBottom: 2, paddingLeft: 6, borderLeft: `2px solid ${e.faction === 'blue' ? '#A56F63' : '#D99B7F'}` }}>
          {e.faction.toUpperCase()} · {e.status.toUpperCase()} · T+{e.launchTime.toFixed(1)}s → T+{e.impactTime.toFixed(1)}s
        </div>
      ))}
      {!state.events.length && <span style={{ opacity: .4 }}>NO ENGAGEMENTS QUEUED</span>}
    </div>
  </div>;
}

function IllustrativeDisclaimer({ active }: { active: boolean }) {
  if (!active) return null;
  return <div style={{
    position: 'absolute', left: '50%', bottom: 12, transform: 'translateX(-50%)',
    zIndex: 100, padding: '6px 12px', background: 'rgba(8,25,35,.92)',
    border: '1px solid rgba(217,155,127,.28)', color: '#D99B7F',
    font: '9px Roboto Condensed,Arial,sans-serif', letterSpacing: '1.2px',
    textAlign: 'center', whiteSpace: 'nowrap'
  }}>
    ILLUSTRATIVE — REDUCED-FIDELITY TRAJECTORY, NOT PLATFORM-SPECIFIC
  </div>;
}

export default function Interactive3DLayer() {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [status, setStatus] = useState('GLOBE · INITIALIZING');
  const [mode, setMode] = useState<'3D'|'2D'>('3D');
  const [scene, setScene] = useState<Scene>(() => getScene());
  const [engagementState, setEngagementState] = useState<EngagementState>(() => getEngagementState());
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<GlobeEngine | null>(null);
  const cameraRef = useRef<GlobeCamera>({ yaw:0.25, pitch:0.72, distance:36, tx:0, ty:1, tz:0 });
  const goalRef = useRef<GlobeCamera>({ ...cameraRef.current });
  const velocityRef = useRef({x:0,z:0,yaw:0,pitch:0});
  const dragRef = useRef<Drag | null>(null);
  const centerRef = useRef<GlobePoint>(sceneCenter(getScene()));
  const sceneRef = useRef<Scene>(getScene());
  const lodRef = useRef(-1);
  const lastFrameRef = useRef<number>(0);

  useEffect(() => {
    const find = () => { const h = [...document.querySelectorAll<HTMLElement>('.unified-theater')].find(n => { const r=n.getBoundingClientRect(); return r.width>20&&r.height>20&&getComputedStyle(n).display!=='none'; }); if(h)setHost(h); };
    find(); const t=window.setInterval(find,300); return()=>window.clearInterval(t);
  }, []);

  // Subscribe to engagement state
  useEffect(() => {
    return subscribeEngagement(setEngagementState);
  }, []);

  useEffect(() => {
    if(!host)return;
    const canvas=canvasRef.current; if(!canvas)return;
    host.classList.add('three-d-overlay-active');
    host.querySelectorAll<HTMLElement>('.theater-controls,.theater-legend,.theater-hud,.map-attribution,.theater-svg,.theater-tiles').forEach(n=>n.style.visibility='hidden');
    let engine:GlobeEngine;
    try{engine=new GlobeEngine(canvas,centerRef.current);}catch{setStatus('GLOBE · WEBGL2 UNAVAILABLE');return;}
    engineRef.current=engine;
    engine.onState=s=>{ const zoom=s.zoom; const imagery = s.imageryLoaded ? 'OSM LIVE' : 'IMAGERY OFFLINE'; setStatus(`${s.loading?'GLOBE · STREAMING':'GLOBE · READY'} · DEM ${s.degraded?'DEGRADED':'LIVE'} · ${imagery} z${zoom} · ${Math.round(s.patchKm)} KM PATCH`); };
    engine.resize(); void engine.load(centerRef.current,cameraRef.current.distance);

    const resize=()=>engine.resize(); const ro=new ResizeObserver(resize); ro.observe(host);
    let meshTimer=0;
    const unsubscribe = subscribeScene((s) => {
      sceneRef.current = s; setScene(s);
      const c = sceneCenter(s);
      if (!engine.getMesh() || Math.hypot(c.lat - centerRef.current.lat, c.lon - centerRef.current.lon) > 0.08) {
        centerRef.current = c; cameraRef.current.tx = 0; cameraRef.current.tz = 0; goalRef.current.tx = 0; goalRef.current.tz = 0;
        window.clearTimeout(meshTimer); meshTimer = window.setTimeout(() => void engine.load(c, cameraRef.current.distance), 120);
      }
    });

    const updateMarker=(d:Drag,x:number,y:number)=>{ if(!d.pointType)return; const p=engine.screenToGeo(cameraRef.current,x,y,canvas.width,canvas.height); if(!p)return; editScene({ target: d.pointType, index: d.index, point: { lat: Number(p.lat.toFixed(6)), lon: Number(p.lon.toFixed(6)) } }); };
    const down=(e:PointerEvent)=>{if(e.target!==canvas)return;const rect=canvas.getBoundingClientRect(),x=(e.clientX-rect.left)*(canvas.width/Math.max(1,rect.width)),y=(e.clientY-rect.top)*(canvas.height/Math.max(1,rect.height)),hit=nearestMarker(engine,cameraRef.current,canvas,sceneRef.current,x,y);if(hit){dragRef.current={mode:'marker',index:hit.index,lastX:e.clientX,lastY:e.clientY,pointType:hit.type};canvas.style.cursor='grabbing';canvas.setPointerCapture(e.pointerId);e.preventDefault();return;}const pan=e.button===1||e.button===2||e.shiftKey;dragRef.current={mode:pan?'pan':'orbit',index:-1,lastX:e.clientX,lastY:e.clientY};canvas.setPointerCapture(e.pointerId);canvas.style.cursor='grabbing';e.preventDefault();};
    const move=(e:PointerEvent)=>{const d=dragRef.current;if(!d)return;const dx=e.clientX-d.lastX,dy=e.clientY-d.lastY;d.lastX=e.clientX;d.lastY=e.clientY;if(d.mode==='marker'){const r=canvas.getBoundingClientRect();updateMarker(d,(e.clientX-r.left)*(canvas.width/Math.max(1,r.width)),(e.clientY-r.top)*(canvas.height/Math.max(1,r.height)));return;}if(d.mode==='orbit'){velocityRef.current.yaw += -dx*0.0009; velocityRef.current.pitch += -dy*0.00065; goalRef.current.pitch=clamp(goalRef.current.pitch-dy*0.0032,0.08,1.55);}else{const speed=goalRef.current.distance/Math.max(260,canvas.clientHeight);const f={x:-Math.sin(goalRef.current.yaw)*Math.cos(goalRef.current.pitch),z:-Math.cos(goalRef.current.yaw)*Math.cos(goalRef.current.pitch)};const rr={x:f.z,z:-f.x};velocityRef.current.x += (-dx*speed)*rr.x+(dy*speed)*f.x;velocityRef.current.z += (-dx*speed)*rr.z+(dy*speed)*f.z;}};
    const up=(e:PointerEvent)=>{if(canvas.hasPointerCapture(e.pointerId))canvas.releasePointerCapture(e.pointerId);dragRef.current=null;canvas.style.cursor='grab';};
    const wheel=(e:WheelEvent)=>{e.preventDefault();const scale=Math.exp(e.deltaY*.0011);goalRef.current.distance=clamp(goalRef.current.distance*scale,engine.getMinDistance(),engine.getMaxDistance());};
    const key=(e:KeyboardEvent)=>{if(e.target instanceof HTMLInputElement)return;const s=goalRef.current.distance/80;let dx=0,dz=0;if(e.key==='ArrowLeft'||e.key.toLowerCase()==='a')dx=-s;if(e.key==='ArrowRight'||e.key.toLowerCase()==='d')dx=s;if(e.key==='ArrowUp'||e.key.toLowerCase()==='w')dz=-s;if(e.key==='ArrowDown'||e.key.toLowerCase()==='s')dz=s;if(dx||dz){e.preventDefault();velocityRef.current.x+=dx;velocityRef.current.z+=dz;}if(e.key.toLowerCase()==='n'){goalRef.current.yaw=0;}if(e.key==='+'||e.key==='=')goalRef.current.distance=clamp(goalRef.current.distance*.78,engine.getMinDistance(),engine.getMaxDistance());if(e.key==='-'||e.key==='_')goalRef.current.distance=clamp(goalRef.current.distance*1.28,engine.getMinDistance(),engine.getMaxDistance());};
    canvas.addEventListener('pointerdown',down);canvas.addEventListener('pointermove',move);canvas.addEventListener('pointerup',up);canvas.addEventListener('pointercancel',up);canvas.addEventListener('wheel',wheel,{passive:false});window.addEventListener('keydown',key);
    
    let raf=0,last=performance.now(); 
    const frame=(now:number)=>{
      const dt=Math.min(.05,Math.max(.001,(now-last)/1000));last=now;
      const c=cameraRef.current,g=goalRef.current,v=velocityRef.current;
      g.yaw+=v.yaw;g.pitch=clamp(g.pitch+v.pitch,.08,1.55);g.tx+=v.x;g.tz+=v.z;
      const damping=Math.exp(-7*dt);v.x*=damping;v.z*=damping;v.yaw*=damping;v.pitch*=damping;
      const t=1-Math.exp(-10*dt);
      c.yaw += ((g.yaw-c.yaw+Math.PI*3)%(Math.PI*2)-Math.PI)*t;
      c.pitch+=(g.pitch-c.pitch)*t;
      c.distance+=(g.distance-c.distance)*t;
      c.tx+=(g.tx-c.tx)*t;c.ty+=(g.ty-c.ty)*t;c.tz+=(g.tz-c.tz)*t;
      const recentered=engine.maybeRecenter(g);
      if(recentered){centerRef.current=engine.getCenter();c.tx=g.tx; c.tz=g.tz;}
      const band=lodBand(g.distance);
      if(band!==lodRef.current){lodRef.current=band;void engine.load(engine.getCenter(),g.distance);}
      
      // Pass engagement events to engine for rendering
      engine.setEngagementEvents(engagementState.events);
      engine.draw(c, sceneRef.current, now);
      
      lastFrameRef.current = now;
      raf=requestAnimationFrame(frame);
    };
    raf=requestAnimationFrame(frame);
    
    return()=>{cancelAnimationFrame(raf);unsubscribe();clearTimeout(meshTimer);ro.disconnect();canvas.removeEventListener('pointerdown',down);canvas.removeEventListener('pointermove',move);canvas.removeEventListener('pointerup',up);canvas.removeEventListener('pointercancel',up);canvas.removeEventListener('wheel',wheel);window.removeEventListener('keydown',key);engine.destroy();engineRef.current=null;host.querySelectorAll<HTMLElement>('.theater-controls,.theater-legend,.theater-hud,.map-attribution,.theater-svg,.theater-tiles').forEach(n=>n.style.visibility='');host.classList.remove('three-d-overlay-active');};
  },[host, engagementState.events]);

  const applyCoordinates = (next: TrajectoryEditorState) => {
    editScene({ target: 'origin', index: 0, point: { lat: Number(next.origin.lat.toFixed(6)), lon: Number(next.origin.lon.toFixed(6)), alt: Number((next.origin.alt ?? 0).toFixed(2)) } });
    editScene({ target: 'target', index: 0, point: { lat: Number(next.target.lat.toFixed(6)), lon: Number(next.target.lon.toFixed(6)), alt: Number((next.target.alt ?? 0).toFixed(2)) } });
  };

  // Demo: create a test engagement when trajectory result is available
  const createDemoEngagement = (faction: Faction) => {
    if (!scene.origin || !scene.target) return;
    const timeOfFlight = 18.5; // typical for demo pair
    const evt = createEngagementFromTrajectory(
      `${faction}-${Date.now()}`,
      faction,
      scene.origin,
      scene.target,
      timeOfFlight,
      faction === 'red' ? 2.0 : 0 // red launches 2s after blue
    );
    addEngagementEvent(evt);
    setEngagementPlaying(true);
  };

  const handlePlayPause = () => setEngagementPlaying(!engagementState.playing);
  const handleStop = () => { resetEngagementClock(); setEngagementPlaying(false); };
  const handleScrub = (time: number) => { setEngagementClock(time); };

  const hasActiveEngagement = engagementState.events.some(e => e.status !== 'done');
  const api={zoomIn:()=>{const e=engineRef.current;if(e)goalRef.current.distance=clamp(goalRef.current.distance*.76,e.getMinDistance(),e.getMaxDistance());},zoomOut:()=>{const e=engineRef.current;if(e)goalRef.current.distance=clamp(goalRef.current.distance*1.32,e.getMinDistance(),e.getMaxDistance());},fit:()=>{const e=engineRef.current,m=e?.getMesh();if(m){goalRef.current.tx=0;goalRef.current.tz=0;goalRef.current.yaw=.25;goalRef.current.pitch=mode==='3D'?.72:1.52;goalRef.current.distance=clamp(Math.max(m.width_km,m.height_km)*.96,20,180);}},north:()=>{goalRef.current.yaw=0;},three:()=>{setMode('3D');goalRef.current.pitch=.72;},two:()=>{setMode('2D');goalRef.current.pitch=1.52;goalRef.current.yaw=0;}};
  if(!host)return null;
  return createPortal(<div style={{position:'absolute',inset:0,zIndex:40,overflow:'hidden',background:'#081923',touchAction:'none',userSelect:'none'}}>
    <canvas ref={canvasRef} style={{position:'absolute',inset:0,width:'100%',height:'100%',display:'block',cursor:'grab'}}/>
    <div style={{position:'absolute',top:12,left:12,right:80,display:'flex',gap:8,pointerEvents:'none',font:'10px Roboto Condensed,Arial,sans-serif',letterSpacing:'1px'}}>
      <span style={{padding:'7px 10px',background:'rgba(8,25,35,.92)',border:'1px solid rgba(217,155,127,.28)',color:'#ead8cf'}}>{status}</span>
      <span style={{marginLeft:'auto',padding:'7px 10px',background:'rgba(8,25,35,.72)',border:'1px solid rgba(217,155,127,.15)',color:'#c9c7c5'}}>{mode==='3D'?'ORBIT · PAN · ZOOM':'TOP-DOWN · PAN · ZOOM'} · DRAG MARKERS · WASD/ARROWS</span>
    </div>
    <CoordinateEditor scene={scene} onApply={applyCoordinates}/>
    <EngagementPlaybackControls 
      state={engagementState} 
      onPlayPause={handlePlayPause}
      onStop={handleStop}
      onScrub={handleScrub}
    />
    <IllustrativeDisclaimer active={hasActiveEngagement} />
    <div style={{position:'absolute',right:10,top:58,zIndex:100,display:'flex',flexDirection:'column',gap:6}} onPointerDown={e=>e.stopPropagation()}>
      <button type='button' style={baseBtn} onClick={api.zoomIn}>+</button>
      <button type='button' style={baseBtn} onClick={api.zoomOut}>−</button>
      <button type='button' style={smallBtn} onClick={api.fit}>FIT</button>
      <button type='button' style={smallBtn} onClick={api.three}>3D</button>
      <button type='button' style={smallBtn} onClick={api.two}>2D</button>
      <button type='button' style={smallBtn} onClick={api.north}>N</button>
      <button type='button' style={{...smallBtn, background: 'rgba(165,111,99,.3)', borderColor: 'rgba(165,111,99,.6)'}} onClick={() => createDemoEngagement('blue')}>LAUNCH BLUE</button>
      <button type='button' style={{...smallBtn, background: 'rgba(217,155,127,.3)', borderColor: 'rgba(217,155,127,.6)'}} onClick={() => createDemoEngagement('red')}>LAUNCH RED</button>
    </div>
    <div style={{position:'absolute',left:10,bottom:10,padding:'6px 8px',background:'rgba(8,25,35,.78)',border:'1px solid rgba(217,155,127,.16)',color:'#ccc',font:'9px Roboto Condensed,Arial,sans-serif',letterSpacing:'1px',pointerEvents:'none'}}>CURVED EARTH · STREAMED DEM/OSM · ADAPTIVE LOD · © OpenStreetMap contributors</div>
  </div>,host);
}