"""Download an SRTM 3-arc-second (.hgt) tile for the Amaran L3 demo.

Usage:
    python scripts/fetch_srtm.py N34E074 [--out dir]

Sources tried in order (public, no auth):
  1. https://srtm.kurviger.de/SRTM3/<continent>/<tile>.hgt.zip
  2. https://srtm.kurviger.de/SRTM3/<tile>.SRTM3.hgt  (flat historical layout)

The current KAVACH demo narrative ("Contact at Gurez Sector") uses an
incident at (34.632, 74.826) and a forward base at (34.650, 74.805) —
both fall in tile N34E074, downloaded into app/data/ by default. (An
earlier demo location, Leh at ~34.15N/77.57E, used N34E077 instead —
that tile is still what tests/conftest.py's synthetic DEM fixtures are
built around, since those test the terrain math and don't need to track
whichever location the live demo currently uses. N34E074 is what the
live demo actually needs loaded.)
"""

import argparse
import math
import os
import sys
import tempfile
import zipfile

import httpx

CONTINENTS = [
    "Eurasia",
    "Africa",
    "North_America",
    "South_America",
    "Australia",
    "Islands",
]

HGT_SAMPLE_COUNTS = {1201, 3601}  # 3-arcsec and 1-arcsec tiles


def _valid_hgt(path: str) -> bool:
    try:
        size = os.path.getsize(path)
    except OSError:
        return False
    n = int(math.sqrt(size // 2))
    return n * n * 2 == size and n in HGT_SAMPLE_COUNTS


def _probe_candidate(dest: str, url: str, client: httpx.Client) -> bool:
    """Download candidate URL to dest; return True if it validates as an .hgt."""
    tmp = dest + ".part"
    try:
        if os.path.exists(tmp):
            os.remove(tmp)
        with client.stream("GET", url, follow_redirects=True, timeout=90.0) as resp:
            if resp.status_code != 200:
                return False
            with open(tmp, "wb") as fh:
                for chunk in resp.iter_bytes():
                    fh.write(chunk)
    except (httpx.HTTPError, OSError):
        if os.path.exists(tmp):
            os.remove(tmp)
        return False

    if _valid_hgt(tmp):
        os.replace(tmp, dest)
        print(f"Downloaded {url}")
        return True

    # Maybe a real .zip containing the .hgt.
    try:
        with zipfile.ZipFile(tmp) as zf:
            names = [n for n in zf.namelist() if n.lower().endswith(".hgt")]
            if not names:
                raise zipfile.BadZipFile("no .hgt inside")
            with open(dest, "wb") as out:
                out.write(zf.read(names[0]))
    except (zipfile.BadZipFile, OSError):
        if os.path.exists(tmp):
            os.remove(tmp)
        return False
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)

    if _valid_hgt(dest):
        print(f"Downloaded + unzipped {url}")
        return True
    if os.path.exists(dest):
        os.remove(dest)
    return False


def fetch_tile(tile: str, out_dir: str, client: httpx.Client) -> str:
    os.makedirs(out_dir, exist_ok=True)
    dest = os.path.join(out_dir, f"{tile}.hgt")
    if os.path.exists(dest) and _valid_hgt(dest):
        print(f"Already present: {dest}")
        return dest

    for continent in CONTINENTS:
        url = f"https://srtm.kurviger.de/SRTM3/{continent}/{tile}.hgt.zip"
        if _probe_candidate(dest, url, client):
            return dest

    url = f"https://srtm.kurviger.de/SRTM3/{tile}.SRTM3.hgt"
    if _probe_candidate(dest, url, client):
        return dest

    url = f"https://srtm.kurviger.de/SRTM3/{tile}.hgt"
    if _probe_candidate(dest, url, client):
        return dest

    raise SystemExit(
        f"Could not download SRTM tile {tile}. Manual step: place "
        f"{tile}.hgt into {out_dir} (e.g. from SRTM data providers)."
    )


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tile", help="SRTM tile name, e.g. N34E074 for the current Gurez Sector demo")
    parser.add_argument(
        "--out",
        default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app", "data"),
        help="Output directory (default: app/data)",
    )
    args = parser.parse_args(argv)

    out = os.path.abspath(args.out)
    with httpx.Client(headers={"User-Agent": "amaran-l3/1.0"}) as client:
        fetch_tile(args.tile.upper(), out, client)


if __name__ == "__main__":
    main(sys.argv[1:])