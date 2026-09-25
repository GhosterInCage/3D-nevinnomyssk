// Geographic helpers for the local world frame.
//
// World frame (shared with the Python pipeline, see pipeline/config.py):
//   Transverse Mercator centred on ORIGIN (metres, WGS84).
//   three.js world: X = east, Y = up (metres above sea level), Z = -north.
import proj4 from 'proj4';

export const ORIGIN = { lon: 41.94, lat: 44.64 };
export const LOCAL_PROJ =
  `+proj=tmerc +lat_0=${ORIGIN.lat} +lon_0=${ORIGIN.lon} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs`;

/** Half-size (m) of the detailed square region centred on the origin. */
export const REGION_HALF = 10240;
/** Local timezone of Nevinnomyssk (MSK, no DST). */
export const UTC_OFFSET_HOURS = 3;

const conv = proj4('EPSG:4326', LOCAL_PROJ);

/** lon/lat (degrees) -> world {x, z}. */
export function lonLatToWorld(lon: number, lat: number): { x: number; z: number } {
  const [e, n] = conv.forward([lon, lat]);
  return { x: e, z: -n };
}

/** world x/z -> lon/lat (degrees). */
export function worldToLonLat(x: number, z: number): { lon: number; lat: number } {
  const [lon, lat] = conv.inverse([x, -z]);
  return { lon, lat };
}

/** Heading in degrees clockwise from north for a world-space direction (dx, dz). */
export function headingOf(dx: number, dz: number): number {
  const h = (Math.atan2(dx, -dz) * 180) / Math.PI;
  return (h + 360) % 360;
}
