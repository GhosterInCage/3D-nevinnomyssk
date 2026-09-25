"""Shared constants for the Nevinnomyssk data pipeline.

World frame used everywhere (pipeline + web app):
  * Transverse Mercator centred on LON0/LAT0 (metres, WGS84 ellipsoid).
  * Pipeline 2D coords: x = east, y = north (metres).
  * Three.js world: X = east, Y = up (metres above sea level), Z = -north.
"""
import os

LON0, LAT0 = 41.94, 44.64
LOCAL_PROJ = f"+proj=tmerc +lat_0={LAT0} +lon_0={LON0} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs"

# Main detailed region: square, centred on origin
REGION_HALF = 10240.0          # metres -> 20.48 km square
GRID_RES = 10.0                # metres per texel for rasters (imagery, landcover)
GRID_N = int(2 * REGION_HALF / GRID_RES)  # 2048
HEIGHT_N = GRID_N + 1          # heightmap samples (vertex-centred, 2049)

# Overture fetch bbox (lon/lat) - superset of region
BBOX_LL = (41.82, 44.54, 42.08, 44.74)

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
RAW = os.path.join(ROOT, "data", "raw")
PROC = os.path.join(ROOT, "data", "processed")
WEB_DATA = os.path.join(ROOT, "public", "data")
os.makedirs(RAW, exist_ok=True)
os.makedirs(PROC, exist_ok=True)
os.makedirs(WEB_DATA, exist_ok=True)

# rasterio/GDAL over the agent proxy
os.environ.setdefault("CURL_CA_BUNDLE", "/root/.ccr/ca-bundle.crt")
if os.environ.get("HTTPS_PROXY"):
    os.environ.setdefault("GDAL_HTTP_PROXY", os.environ["HTTPS_PROXY"])
os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
os.environ.setdefault("GDAL_HTTP_MULTIRANGE", "YES")
os.environ.setdefault("GDAL_HTTP_MERGE_CONSECUTIVE_RANGES", "YES")


def region_transform(res=GRID_RES, n=GRID_N):
    """Affine transform of the region raster (north-up, top-left origin)."""
    from affine import Affine
    return Affine(res, 0, -REGION_HALF, 0, -res, REGION_HALF)


def to_local():
    from pyproj import Transformer
    return Transformer.from_crs("EPSG:4326", LOCAL_PROJ, always_xy=True)


def to_lonlat():
    from pyproj import Transformer
    return Transformer.from_crs(LOCAL_PROJ, "EPSG:4326", always_xy=True)
