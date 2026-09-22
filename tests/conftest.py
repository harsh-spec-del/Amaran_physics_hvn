# Shared fixtures/helpers for Amaran L3 tests.

import numpy as np
import pytest

from app.physics.terrain import DEM

# All synthetic DEMs live in the Leh demo longitude window [77.0, 78.0] and a
# latitude window chosen per fixture, so profile/elevation calls stay inside
# the tile. Row 0 of a DEM grid is the NORTH edge (lat_max), matching SRTM.


def _lat_rows(lat_range, res, lat_max):
    """Return a top-down row slice covering lat_range=(lo, hi) given res/deg and lat_max."""
    r_hi = (lat_max - lat_range[1]) / res  # row at the higher (northerly) lat
    r_lo = (lat_max - lat_range[0]) / res
    return slice(int(round(r_hi)), int(round(r_lo)) + 1)


def make_flat_dem(lat_lo=34.0, lat_hi=35.0, lon_lo=77.0, lon_hi=78.0,
                  base_elev=3000.0, rows=201, cols=201) -> DEM:
    """A DEM with a constant elevation (bilinear-safe)."""
    return DEM(np.full((rows, cols), base_elev),
               lat_lo, lat_hi, lon_lo, lon_hi, source="test-flat")


def make_ridge_dem(lat_lo=34.0, lat_hi=35.0, lon_lo=77.0, lon_hi=78.0,
                   base_elev=3000.0, ridge_lat=(34.30, 34.40), ridge_elev=4500.0,
                   rows=201, cols=201) -> DEM:
    """
    A DEM with a tall east-west ridge band at ``ridge_lat`` (top-down rows).
    Base is ``base_elev``; the band is ``ridge_elev``.
    """
    z = np.full((rows, cols), base_elev)
    res = (lat_hi - lat_lo) / (rows - 1)
    z[_lat_rows(ridge_lat, res, lat_hi), :] = ridge_elev
    return DEM(z, lat_lo, lat_hi, lon_lo, lon_hi, source="test-ridge")


def make_ramp_dem(lat_lo=34.0, lat_hi=34.1, lon_lo=77.0, lon_hi=77.1,
                  rise_per_m=0.3, base_elev=3000.0, rows=121, cols=121) -> DEM:
    """
    A DEM whose elevation rises linearly with latitude at ``rise_per_m``
    m/m, constant in longitude. Over ~11 km of latitude this gives a known,
    hand-checkable slope. Row 0 is the north edge, matching the DEM/SRTM
    convention.
    """
    meters_per_deg = 111320.0
    row_lats = np.linspace(lat_hi, lat_lo, rows)  # north (row 0) -> south
    z_row = base_elev + rise_per_m * (row_lats - lat_lo) * meters_per_deg
    z = np.tile(z_row[:, None], (1, cols))
    return DEM(z, lat_lo, lat_hi, lon_lo, lon_hi, source="test-ramp")


@pytest.fixture
def flat_dem():
    return make_flat_dem()


@pytest.fixture
def ridge_dem():
    return make_ridge_dem()


@pytest.fixture
def ramp_dem():
    return make_ramp_dem()