// Shared environment state: time of day, sun, wind, weather.
// The core keeps the astronomical sun position up to date every frame; the sky
// module owns the actual lights/sky rendering and may refine colours/intensities.
import * as THREE from 'three';
import { ORIGIN, UTC_OFFSET_HOURS } from './geo';
import { solarPosition } from './sun';

export class Environment {
  /** Calendar date (local). */
  year = 2026;
  month = 7;   // 1..12
  day = 15;
  /** Local time of day in hours (MSK, UTC+3). */
  hours = 15.0;
  /** Speed of simulated time: game-hours per real second (0 = frozen). */
  timeScale = 0;

  /** Unit vector from ground towards the sun (world frame). */
  readonly sunDirection = new THREE.Vector3(0, 1, 0);
  /** Unit vector towards the moon (approximate: opposite-ish of the sun). */
  readonly moonDirection = new THREE.Vector3(0, 1, 0);
  sunElevation = 45; // degrees
  sunAzimuth = 180;  // degrees cw from north
  /** 0 = full day, 1 = full night (smooth across twilight). */
  night = 0;
  /** Sun light colour/intensity suggestion (linear), updated by the sky module. */
  readonly sunColor = new THREE.Color(1, 0.97, 0.92);
  sunIntensity = 3.0;

  /** Wind vector (m/s) in world XZ. */
  readonly wind = new THREE.Vector2(2.5, -1.2);
  /** Weather: 0..1 */
  cloudCover = 0.25;
  rain = 0;
  fog = 0;

  /** Seconds since start (for shader animation). */
  elapsed = 0;

  get date(): Date {
    const h = Math.floor(this.hours), m = (this.hours - h) * 60;
    // construct UTC instant for local time
    return new Date(Date.UTC(this.year, this.month - 1, this.day, h - UTC_OFFSET_HOURS, m, 0));
  }

  setDate(iso: string): void {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (!m) return;
    this.year = +m[1]; this.month = +m[2]; this.day = +m[3];
  }

  update(dt: number): void {
    this.elapsed += dt;
    if (this.timeScale) this.hours = (this.hours + dt * this.timeScale + 24) % 24;
    const p = solarPosition(this.date, ORIGIN.lat, ORIGIN.lon, this.sunDirection);
    this.sunElevation = p.elevation;
    this.sunAzimuth = p.azimuth;
    // civil twilight ramps between +2° and -8°
    const t = THREE.MathUtils.clamp((2 - p.elevation) / 10, 0, 1);
    this.night = t * t * (3 - 2 * t);
    this.moonDirection.set(-this.sunDirection.x, Math.abs(this.sunDirection.y) * 0.8 + 0.2, -this.sunDirection.z).normalize();
  }
}
