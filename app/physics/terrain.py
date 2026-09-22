"""Terrain loading, interpolation and geodesic profiling for Amaran L3."""

import math
import os
import re

import numpy as np

from .trajectory import haversine_distance

EARTH_RADIUS_M = 6371000.0
HGT_SAMPLES = {1201, 3601}
SRTM_NODATA = -32768


class TerrainLoadError(RuntimeError):
    """Raised when a DEM tile cannot be located or parsed."""


class TerrainDataError(TerrainLoadError):
    """Raised when requested terrain data is unavailable or invalid."""


def _tile_name_to_bounds(tile_name: str) -> tuple[float, float, float, float]:
    m = re.match(r"^([NS])(\d{2})([EW])(\d{3})$", tile_name.strip()[:7].upper())
    if not m:
        raise TerrainLoadError(f"Unrecognized SRTM tile name: {tile_name!r}")
    lat_abs = int(m.group(2))
    lon_abs = int(m.group(4))
    if m.group(1) == "N":
        lat_min, lat_max = lat_abs, lat_abs + 1
    else:
        lat_min, lat_max = -(lat_abs + 1), -lat_abs
    if m.group(3) == "E":
        lon_min, lon_max = lon_abs, lon_abs + 1
    else:
        lon_min, lon_max = -(lon_abs + 1), -lon_abs
    return lat_min, lat_max, lon_min, lon_max


def _parse_hgt(path: str) -> np.ndarray:
    size_bytes = os.path.getsize(path)
    if size_bytes % 2:
        raise TerrainLoadError(f"{path}: invalid .hgt byte size {size_bytes}")
    n = int(round(math.sqrt(size_bytes // 2)))
    if n not in HGT_SAMPLES or n * n * 2 != size_bytes:
        raise TerrainLoadError(
            f"{path}: expected 1201x1201 or 3601x3601 SRTM data, got {n} samples"
        )
    return np.fromfile(path, dtype=">i2", count=n * n).reshape(n, n)


class DEM:
    """Regular geographic DEM; row 0 is north and columns increase eastward."""

    def __init__(self, z: np.ndarray, lat_min: float, lat_max: float,
                 lon_min: float, lon_max: float, source: str = "synthetic",
                 nodata: int | float | None = SRTM_NODATA):
        self.z = np.asarray(z, dtype=np.float64)
        if self.z.ndim != 2 or min(self.z.shape) < 2:
            raise TerrainLoadError("DEM grid must be a 2D array with at least 2x2 samples")
        self.lat_min = float(lat_min)
        self.lat_max = float(lat_max)
        self.lon_min = float(lon_min)
        self.lon_max = float(lon_max)
        if self.lat_max <= self.lat_min or self.lon_max <= self.lon_min:
            raise TerrainLoadError("DEM bounds must have positive latitude/longitude span")
        self.source = source
        self.nodata = float(nodata) if nodata is not None else None
        n_rows, n_cols = self.z.shape
        self.res_lat_deg = (self.lat_max - self.lat_min) / (n_rows - 1)
        self.res_lon_deg = (self.lon_max - self.lon_min) / (n_cols - 1)

    @classmethod
    def from_srtm_tile(cls, path: str) -> "DEM":
        base = os.path.basename(path)
        tile_name = base.split(".")[0][:7].upper()
        bounds = _tile_name_to_bounds(tile_name)
        return cls(_parse_hgt(path), *bounds, source=base, nodata=SRTM_NODATA)

    @classmethod
    def from_raster(cls, path: str) -> "DEM":
        """Load a rasterio-readable DEM, reprojecting into EPSG:4326 when needed."""
        import rasterio
        from rasterio.transform import array_bounds
        from rasterio.warp import calculate_default_transform, reproject, Resampling

        with rasterio.open(path) as src:
            if src.crs is None:
                lon_min, lat_min, lon_max, lat_max = src.bounds
                z = src.read(1, masked=True).filled(np.nan).astype(np.float64)
                nodata = src.nodata
            elif src.crs.to_epsg() == 4326:
                lon_min, lat_min, lon_max, lat_max = src.bounds
                z = src.read(1, masked=True).filled(np.nan).astype(np.float64)
                nodata = src.nodata
            else:
                transform, width, height = calculate_default_transform(
                    src.crs, "EPSG:4326", src.width, src.height, *src.bounds
                )
                dst = np.full((height, width), np.nan, dtype=np.float64)
                reproject(
                    source=rasterio.band(src, 1),
                    destination=dst,
                    src_transform=src.transform,
                    src_crs=src.crs,
                    src_nodata=src.nodata,
                    dst_transform=transform,
                    dst_crs="EPSG:4326",
                    dst_nodata=np.nan,
                    resampling=Resampling.bilinear,
                )
                left, bottom, right, top = array_bounds(height, width, transform)
                lon_min, lat_min, lon_max, lat_max = left, bottom, right, top
                z = dst
                nodata = np.nan
        return cls(z, lat_min, lat_max, lon_min, lon_max,
                   source=os.path.basename(path), nodata=nodata)

    def contains(self, lat: float, lon: float) -> bool:
        return self.lat_min <= lat <= self.lat_max and self.lon_min <= lon <= self.lon_max

    def _fractional_index(self, lat: float, lon: float) -> tuple[float, float]:
        row = (self.lat_max - lat) / self.res_lat_deg
        col = (lon - self.lon_min) / self.res_lon_deg
        return row, col

    def _is_nodata(self, value: float) -> bool:
        if not math.isfinite(value):
            return True
        return self.nodata is not None and math.isfinite(self.nodata) and value == self.nodata

    def elevation_at(self, lat: float, lon: float, method: str = "bilinear") -> float:
        if not self.contains(lat, lon):
            raise TerrainDataError(f"Point ({lat:.4f}, {lon:.4f}) outside tile {self.source}")
        row, col = self._fractional_index(lat, lon)
        n_rows, n_cols = self.z.shape
        row = min(max(row, 0.0), n_rows - 1.0)
        col = min(max(col, 0.0), n_cols - 1.0)

        if method == "nearest":
            value = float(self.z[int(round(row)), int(round(col))])
            if self._is_nodata(value):
                raise TerrainDataError(f"Terrain void at ({lat:.4f}, {lon:.4f}) in {self.source}")
            return value
        if method != "bilinear":
            raise TerrainLoadError(f"Unknown interpolation method: {method!r}")

        r0 = min(int(math.floor(row)), n_rows - 2)
        c0 = min(int(math.floor(col)), n_cols - 2)
        dr = row - r0
        dc = col - c0
        values = [
            float(self.z[r0, c0]), float(self.z[r0 + 1, c0]),
            float(self.z[r0, c0 + 1]), float(self.z[r0 + 1, c0 + 1]),
        ]
        if any(self._is_nodata(v) for v in values):
            raise TerrainDataError(f"Terrain void near ({lat:.4f}, {lon:.4f}) in {self.source}")
        v00, v10, v01, v11 = values
        top = v00 + (v01 - v00) * dc
        bottom = v10 + (v11 - v10) * dc
        return float(top + (bottom - top) * dr)

    def profile(self, lat1: float, lon1: float, lat2: float, lon2: float,
                step_m: float = 90.0) -> list[tuple[float, float | None]]:
        """Sample a great-circle terrain profile; None marks unavailable terrain."""
        return _geodesic_profile(lat1, lon1, lat2, lon2, step_m, self.elevation_at)


def _latlon_to_vector(lat: float, lon: float) -> np.ndarray:
    phi, lam = math.radians(lat), math.radians(lon)
    return np.array([math.cos(phi) * math.cos(lam), math.cos(phi) * math.sin(lam), math.sin(phi)])


def _vector_to_latlon(v: np.ndarray) -> tuple[float, float]:
    v = v / np.linalg.norm(v)
    return math.degrees(math.asin(float(np.clip(v[2], -1.0, 1.0)))), math.degrees(math.atan2(float(v[1]), float(v[0])))


def _geodesic_samples(v0: np.ndarray, v1: np.ndarray, n: int) -> list[np.ndarray]:
    cos_a = float(np.clip(np.dot(v0, v1), -1.0, 1.0))
    a = math.acos(cos_a)
    if a < 1e-12:
        return [v0.copy() for _ in range(n)]
    sin_a = math.sin(a)
    return [
        (math.sin((1.0 - t) * a) / sin_a) * v0 + (math.sin(t * a) / sin_a) * v1
        for t in (i / (n - 1) for i in range(n))
    ]


def _geodesic_profile(lat1: float, lon1: float, lat2: float, lon2: float,
                       step_m: float, elevation_at) -> list[tuple[float, float | None]]:
    """Shared great-circle profiling routine used by both DEM.profile (single
    tile) and TileStore.profile (multi-tile); `elevation_at(lat, lon)` is the
    only thing that differs between the two callers."""
    if step_m <= 0:
        raise ValueError("step_m must be greater than zero")
    total = haversine_distance(lat1, lon1, lat2, lon2)
    n_steps = max(2, int(math.ceil(total / step_m)) + 1)
    points = _geodesic_samples(_latlon_to_vector(lat1, lon1),
                               _latlon_to_vector(lat2, lon2), n_steps)
    samples = []
    for i, v in enumerate(points):
        lat, lon = _vector_to_latlon(v)
        try:
            elev = elevation_at(lat, lon)
        except TerrainDataError:
            elev = None
        samples.append((float(total * i / (n_steps - 1)), elev))
    return samples


class TileStore:
    """Lazy-loading multi-tile SRTM store with cached DEMs."""

    def __init__(self, data_dir: str | None = None):
        self.data_dir = data_dir or os.getenv(
            "AMARAN_DATA_DIR", os.path.join(os.path.dirname(__file__), "..", "data")
        )
        self._dems: dict[str, DEM] = {}

    def tiles_available(self) -> list[str]:
        if not os.path.isdir(self.data_dir):
            return []
        return sorted(f for f in os.listdir(self.data_dir) if f.lower().endswith(".hgt"))

    def dem_for(self, lat: float, lon: float) -> DEM:
        tile_name = srtm_tile_name(lat, lon)
        if tile_name in self._dems:
            return self._dems[tile_name]
        base = os.path.join(self.data_dir, tile_name)
        candidates = [base + suffix for suffix in (".hgt", ".SRTM3.hgt", ".HGT")]
        for path in candidates:
            if not os.path.exists(path):
                continue
            try:
                dem = DEM.from_srtm_tile(path)
                if dem.contains(lat, lon):
                    self._dems[tile_name] = dem
                    return dem
            except TerrainLoadError:
                continue
        raise TerrainDataError(f"No valid SRTM tile {tile_name} available in {self.data_dir}")

    def elevation_at(self, lat: float, lon: float, method: str = "bilinear") -> float:
        return self.dem_for(lat, lon).elevation_at(lat, lon, method=method)

    def profile(self, lat1: float, lon1: float, lat2: float, lon2: float,
                step_m: float = 90.0) -> list[tuple[float, float | None]]:
        return _geodesic_profile(lat1, lon1, lat2, lon2, step_m, self.elevation_at)

    def is_loaded(self) -> bool:
        return bool(self.tiles_available())


def srtm_tile_name(lat: float, lon: float) -> str:
    if not math.isfinite(lat) or not math.isfinite(lon):
        raise TerrainLoadError("Latitude and longitude must be finite")
    if not (-90.0 <= lat < 90.0):
        raise TerrainLoadError(f"Latitude {lat} outside SRTM coverage of [-90, 90).")
    if not (-180.0 <= lon <= 180.0):
        raise TerrainLoadError(f"Longitude {lon} outside SRTM coverage.")
    # Normalize the dateline endpoint to the western side of the final tile.
    if lon == 180.0:
        lon = math.nextafter(180.0, 0.0)
    ns = "N" if lat >= 0 else "S"
    ew = "E" if lon >= 0 else "W"
    lat_deg = math.floor(lat) if lat >= 0 else math.ceil(lat)
    lon_deg = math.floor(lon) if lon >= 0 else math.ceil(lon)
    return f"{ns}{abs(int(lat_deg)):02d}{ew}{abs(int(lon_deg)):03d}"