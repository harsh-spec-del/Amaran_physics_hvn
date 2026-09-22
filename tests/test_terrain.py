"""Elevation lookup + tile-name parsing tests."""

import numpy as np
import pytest

from app.physics.terrain import DEM, TerrainDataError, TerrainLoadError, srtm_tile_name


def test_bilinear_is_exact_for_linear_field():
    rows = cols = 11
    res = 0.1
    z = np.zeros((rows, cols))
    for i in range(rows):
        lat = 1.0 - i * res
        for j in range(cols):
            lon = j * res
            z[i, j] = 2.0 * lat + 3.0 * lon
    dem = DEM(z, 0.0, 1.0, 0.0, 1.0)
    assert dem.elevation_at(0.0, 0.0) == pytest.approx(0.0, abs=1e-9)
    assert dem.elevation_at(1.0, 1.0) == pytest.approx(5.0, abs=1e-9)
    assert dem.elevation_at(0.5, 0.5) == pytest.approx(2.5, abs=1e-9)


def test_rectangular_grid_uses_independent_axis_resolution():
    z = np.arange(12, dtype=float).reshape(3, 4)
    dem = DEM(z, 0.0, 2.0, 0.0, 3.0)
    assert dem.res_lat_deg == pytest.approx(1.0)
    assert dem.res_lon_deg == pytest.approx(1.0)


def test_nodata_is_not_treated_as_sea_level():
    z = np.full((11, 11), 3000.0)
    z[5, 5] = -32768
    dem = DEM(z, 0.0, 1.0, 0.0, 1.0)
    with pytest.raises(TerrainDataError):
        dem.elevation_at(0.5, 0.5)


def test_tile_name_lookup_demo_area():
    assert srtm_tile_name(34.1526, 77.5771) == "N34E077"
    assert srtm_tile_name(34.0500, 77.6500) == "N34E077"


def test_tile_name_southern_western_hemisphere():
    assert srtm_tile_name(-34.5, -77.5) == "S34W077"


def test_profile_distance_monotonic(ridge_dem):
    samples = ridge_dem.profile(34.05, 77.05, 34.10, 77.05, step_m=100.0)
    dists = [s[0] for s in samples]
    assert dists == sorted(dists)
    assert dists[-1] > 0
    assert dists[0] == pytest.approx(0.0, abs=1.0)


def test_out_of_tile_raises():
    dem = DEM(np.zeros((11, 11)), 0.0, 1.0, 0.0, 1.0)
    with pytest.raises(TerrainLoadError):
        dem.elevation_at(5.0, 5.0)