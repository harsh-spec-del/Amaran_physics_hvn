import React, { useEffect, useState } from 'react';
import App from './App';
import Interactive3DLayer from './Interactive3DLayer';
import './styles/app-shell.css';

type RecordItem = { id: string; type: string; label: string; lat: number; lon: number; alt?: number; notes?: string };
type Section = 'application' | 'data';

// Login/credentials removed — this console now opens straight to the
// workspace, same as every other Amaran OS desktop app. Data Studio's
// local record store stays (it was never really an access-control
// boundary, just gated behind "are you logged in at all" like everything
// else used to be) but no longer requires a session to read or write.
function DataStudio() {
  const [records, setRecords] = useState<RecordItem[]>([]);
  const [draft, setDraft] = useState<RecordItem>({ id: '', type: 'ENTITY', label: '', lat: 34.11, lon: 77.61, alt: 0, notes: '' });
  const [message, setMessage] = useState('');

  useEffect(() => {
    void window.amaranData.readData().then((r) => {
      if (r.ok) setRecords((r.records ?? []) as RecordItem[]);
    });
  }, []);

  const persist = async (next: RecordItem[]) => {
    setRecords(next);
    const r = await window.amaranData.writeData(next);
    setMessage(r.ok ? 'Data saved.' : (r.error ?? 'Unable to save data.'));
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.id || !draft.label) return setMessage('ID and label are required.');
    await persist([...records, { ...draft }]);
    setDraft({ id: '', type: 'ENTITY', label: '', lat: draft.lat, lon: draft.lon, alt: draft.alt, notes: '' });
  };

  return (
    <div className="shell-page">
      <div className="shell-page-head">
        <div>
          <span className="section-label">DATA</span>
          <h2>Dynamic Data Studio</h2>
          <p>Create and maintain local scene entities without editing source code.</p>
        </div>
      </div>
      <div className="shell-card">
        <h3>New record</h3>
        <form className="data-form" onSubmit={add}>
          <label><span>ID</span><input value={draft.id} onChange={(e) => setDraft({ ...draft, id: e.target.value })} /></label>
          <label><span>TYPE</span><input value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })} /></label>
          <label><span>LABEL</span><input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} /></label>
          <label><span>LAT</span><input type="number" min="-90" max="90" step="any" value={draft.lat} onChange={(e) => setDraft({ ...draft, lat: Number(e.target.value) })} /></label>
          <label><span>LON</span><input type="number" min="-180" max="180" step="any" value={draft.lon} onChange={(e) => setDraft({ ...draft, lon: Number(e.target.value) })} /></label>
          <label><span>ALT M</span><input type="number" step="any" value={draft.alt ?? 0} onChange={(e) => setDraft({ ...draft, alt: Number(e.target.value) })} /></label>
          <label className="wide"><span>NOTES</span><textarea value={draft.notes ?? ''} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} /></label>
          <button className="action" type="submit">ADD RECORD</button>
        </form>
        {message && <div className="shell-message">{message}</div>}
      </div>
      <div className="shell-card">
        <div className="shell-card-head"><h3>Stored records</h3><span>{records.length}</span></div>
        <div className="record-table">
          {records.map((r) => (
            <div className="record-row" key={r.id}>
              <div><strong>{r.label}</strong><span>{r.id} · {r.type}</span></div>
              <span>{r.lat.toFixed(5)}, {r.lon.toFixed(5)} · {(r.alt ?? 0).toFixed(0)} m</span>
              <button className="table-action" onClick={() => void persist(records.filter((x) => x.id !== r.id))}>REMOVE</button>
            </div>
          ))}
          {records.length === 0 && <div className="empty-state">No dynamic records yet.</div>}
        </div>
      </div>
    </div>
  );
}

const NAV: { id: Section; label: string }[] = [
  { id: 'application', label: 'Unified Theater' },
  { id: 'data', label: 'Data Studio' },
];

export default function AppShell() {
  const [section, setSection] = useState<Section>('application');

  return (
    <div className="product-shell">
      <header className="product-topbar">
        <div>
          <span className="top-brand">AMARAN</span>
          <span className="top-context">LOCAL CONSOLE</span>
        </div>
      </header>
      <div className="product-body">
        <aside className="product-sidebar">
          <div className="shell-nav-title">WORKSPACE</div>
          {NAV.map((item) => (
            <button
              key={item.id}
              className={`shell-nav ${section === item.id ? 'active' : ''}`}
              onClick={() => setSection(item.id)}
            >
              {item.label}
            </button>
          ))}
        </aside>
        <main className="product-content">
          {section === 'application' ? <App /> : <DataStudio />}
        </main>
      </div>
      <Interactive3DLayer />
    </div>
  );
}
