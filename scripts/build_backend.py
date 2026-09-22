"""
Builds the standalone Amaran Physics (L3) backend executable via
PyInstaller. Run from the repo root: python scripts/build_backend.py

Output: backend-dist/amaran-physics-backend (Linux/macOS)
        backend-dist/amaran-physics-backend.exe (Windows)

Matches the pattern used by the other four Amaran OS repos'
scripts/build_backend.py, with one addition: rasterio ships its own
bundled GDAL/PROJ shared libraries and data directories inside the wheel
(modern rasterio no longer depends on a system GDAL install), so
--collect-all rasterio pulls all of that in automatically rather than
needing a hand-written PyInstaller hook. rasterio itself is only used by
terrain.py's from_raster() classmethod, which nothing in the API
currently calls (the live demo path loads SRTM .hgt tiles directly, not
through rasterio) — but it's a real dependency in requirements.txt, so
it's bundled properly rather than silently left out.
"""
import os
from pathlib import Path

import PyInstaller.__main__

REPO_ROOT = Path(__file__).resolve().parent.parent

PyInstaller.__main__.run([
    str(REPO_ROOT / "run_backend.py"),
    "--name=amaran-physics-backend",
    "--onefile",
    "--paths=" + str(REPO_ROOT),
    "--collect-all=uvicorn",
    "--hidden-import=uvicorn.lifespan.on",
    "--hidden-import=uvicorn.lifespan.off",
    "--hidden-import=uvicorn.protocols.http.auto",
    "--hidden-import=uvicorn.protocols.websockets.auto",
    "--hidden-import=uvicorn.loops.auto",
    "--distpath=" + str(REPO_ROOT / "backend-dist"),
    "--workpath=" + str(REPO_ROOT / "build"),
    "--specpath=" + str(REPO_ROOT / "build"),
    "--noconfirm",
])
