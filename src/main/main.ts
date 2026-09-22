import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import fs from 'fs';
import http from 'http';
import { spawn, ChildProcess } from 'child_process';

const BACKEND_PORT = Number(process.env.AMARAN_BACKEND_PORT ?? 8000);
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
const HEALTH_PATH = '/api/v1/physics/health';
const DATA_FILE = 'dynamic-data.json';

type StoredRecord = { id: string; type: string; label: string; lat: number; lon: number; alt?: number; notes?: string };
let backend: ChildProcess | null = null;
let backendOwnedByElectron = false;

function isPackaged(): boolean {
  return app.isPackaged;
}

function backendRoot(): string {
  return isPackaged()
    ? path.join(process.resourcesPath, 'backend')
    : path.resolve(__dirname, '..', '..');
}

function packagedBackendExecutable(): string | null {
  if (!isPackaged()) return null;
  const exeName = process.platform === 'win32' ? 'amaran-physics-backend.exe' : 'amaran-physics-backend';
  const candidate = path.join(process.resourcesPath, 'backend', exeName);
  return fs.existsSync(candidate) ? candidate : null;
}

function persistentDemDir(): string {
  // The bundled PyInstaller executable's own file location (what
  // terrain.py's TileStore falls back to for its default data dir) is a
  // temp extraction path recreated on every launch when frozen — same
  // lesson already learned for the other four Amaran OS apps' PyInstaller
  // builds (state must live under a persistent userData path, never the
  // temporary extraction directory). AMARAN_DATA_DIR overrides that
  // default, so point it here instead: SRTM tiles placed in this folder
  // survive restarts and reinstalls, the dev-mode `app/data/` folder does
  // not apply to a packaged install.
  const dir = path.join(app.getPath('userData'), 'dem-data');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function pythonExecutable(): string {
  const root = backendRoot();
  const attempts = [
    path.join(root, '.venv', 'Scripts', 'python.exe'),
    path.join(root, '.venv', 'bin', 'python'),
    process.env.AMARAN_PYTHON ?? '',
    'python3',
    'python',
  ].filter(Boolean);
  for (const candidate of attempts) {
    if (candidate.includes(path.sep) && fs.existsSync(candidate)) return candidate;
  }
  return attempts[attempts.length - 1];
}

function pollHealth(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      if (Date.now() > deadline) return resolve(false);
      const req = http.get(`${BACKEND_URL}${HEALTH_PATH}`, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve(true);
        else setTimeout(tick, 400);
      });
      req.on('error', () => setTimeout(tick, 400));
      req.setTimeout(1200, () => req.destroy());
    };
    tick();
  });
}

function startBackend(): void {
  if (backend) return;
  const packagedExe = packagedBackendExecutable();
  const dataDir = { ...process.env, PYTHONUNBUFFERED: '1', AMARAN_DATA_DIR: persistentDemDir() };

  if (packagedExe) {
    // Standalone build: spawn the PyInstaller-bundled executable directly,
    // exactly like the other four Amaran OS desktop apps — no system
    // Python required on the target machine.
    backend = spawn(packagedExe, [], {
      cwd: path.dirname(packagedExe),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...dataDir, PORT: String(BACKEND_PORT) },
    });
  } else {
    // Dev mode (or a packaged build missing the bundled exe, which
    // shouldn't happen but fails toward the previous behavior rather than
    // refusing to start at all): fall back to spawning system/venv Python.
    const py = pythonExecutable();
    backend = spawn(
      py,
      ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(BACKEND_PORT)],
      {
        cwd: backendRoot(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: dataDir,
      },
    );
  }
  backendOwnedByElectron = true;
  backend.stdout?.on('data', (d) => console.log(`[backend] ${d.toString().trimEnd()}`));
  backend.stderr?.on('data', (d) => console.log(`[backend] ${d.toString().trimEnd()}`));
  backend.on('exit', (code) => {
    console.log(`[backend] exited with code ${code}`);
    backend = null;
    backendOwnedByElectron = false;
  });
  backend.on('error', (err) => console.error(`[backend] failed to start: ${err.message}`));
}

async function ensureBackendReady(timeoutMs = 15000): Promise<boolean> {
  if (await pollHealth(600)) {
    backendOwnedByElectron = false;
    return true;
  }
  startBackend();
  return pollHealth(timeoutMs);
}

function stopBackend(): void {
  if (!backend || !backendOwnedByElectron) return;
  const pid = backend.pid;
  if (pid && process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
  else backend.kill();
  backend = null;
  backendOwnedByElectron = false;
}

function dataPath(file: string) {
  return path.join(app.getPath('userData'), file);
}

function ensureParent(file: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

// Login/credentials removed — the console opens straight to the app now.
// Data Studio's local record store is unauthenticated local storage, same
// as any other file this app writes under userData; nothing here used to
// be a real access-control boundary beyond "did you type the password."
function setupIpc(): void {
  ipcMain.handle('data:read', () => {
    try {
      const file = dataPath(DATA_FILE);
      return { ok: true, records: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [] };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  });

  ipcMain.handle('data:write', (_event, records: StoredRecord[]) => {
    try {
      const file = dataPath(DATA_FILE);
      ensureParent(file);
      fs.writeFileSync(file, JSON.stringify(records ?? [], null, 2), { mode: 0o600 });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  });
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0F3040',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) void win.loadURL(devServerUrl);
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(async () => {
  setupIpc();
  const ready = await ensureBackendReady();
  if (!ready) console.error('[backend] health check timed out; UI will continue to retry.');
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    await ensureBackendReady();
    createWindow();
  }
});

app.on('will-quit', stopBackend);
