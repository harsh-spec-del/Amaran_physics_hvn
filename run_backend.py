"""
Entrypoint used for the PyInstaller-bundled backend, matching every other
Amaran OS layer's run_backend.py pattern. app.main defines the FastAPI app
object; this module is what actually gets frozen into a standalone
executable for the desktop build.

Deliberately does NOT use app.main's own `if __name__ == "__main__"` block
(which passes uvicorn.run("app.main:app", reload=True) as a module string) —
`reload=True` spawns a watcher subprocess that re-imports the app by module
path, which doesn't exist once frozen into a single executable. Import the
app object directly instead, same as the other four repos' run_backend.py.
"""
import os

import uvicorn

from app.main import app

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
