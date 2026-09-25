// World <-> ECEF frame for the precomputed-atmosphere shaders.
//
// Our world frame (docs/ARCHITECTURE.md): X = east, Y = up (metres above sea
// level), Z = -north, a local tangent frame at ORIGIN (lon 41.94, lat 44.64).
// The Bruneton/takram atmosphere works in Earth-centred Earth-fixed metres, so
// we build a rigid world->ECEF matrix from the ENU basis at the origin:
//   world X -> east, world Y -> up, world Z -> -north, translation = ECEF(origin, h=0).
import * as THREE from 'three';
import { Ellipsoid, Geodetic } from '@takram/three-geospatial';
import { ORIGIN } from '../../core/geo';

export class WorldFrame {
  readonly originECEF = new THREE.Vector3();
  readonly east = new THREE.Vector3();
  readonly north = new THREE.Vector3();
  readonly up = new THREE.Vector3();
  /** world -> ECEF (rigid). */
  readonly worldToECEF = new THREE.Matrix4();
  /** ECEF -> world (rigid). */
  readonly ecefToWorld = new THREE.Matrix4();
  /** rotation part of ecefToWorld */
  readonly ecefToWorldRot = new THREE.Matrix3();
  /** rotation part of worldToECEF */
  readonly worldToECEFRot = new THREE.Matrix3();

  constructor(lon = ORIGIN.lon, lat = ORIGIN.lat) {
    const g = new Geodetic(THREE.MathUtils.degToRad(lon), THREE.MathUtils.degToRad(lat), 0);
    g.toECEF(this.originECEF);
    Ellipsoid.WGS84.getEastNorthUpVectors(this.originECEF, this.east, this.north, this.up);
    const negNorth = this.north.clone().negate();
    this.worldToECEF.makeBasis(this.east, this.up, negNorth).setPosition(this.originECEF);
    this.ecefToWorld.copy(this.worldToECEF).invert();
    this.ecefToWorldRot.setFromMatrix4(this.ecefToWorld);
    this.worldToECEFRot.setFromMatrix4(this.worldToECEF);
  }

  dirToECEF(v: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(v).applyMatrix3(this.worldToECEFRot).normalize();
  }

  dirToWorld(v: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(v).applyMatrix3(this.ecefToWorldRot).normalize();
  }

  posToECEF(v: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(v).applyMatrix4(this.worldToECEF);
  }
}
