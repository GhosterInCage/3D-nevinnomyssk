// Procedural audio (Web Audio, no samples): an inline-4 engine note that follows rpm and load,
// intake/exhaust noise, tyre squeal from wheel slip, wind and road rumble with speed, a thud
// on hard impacts, and surface-dependent footsteps while walking. Created lazily on the first user gesture (autoplay policy), silent in screenshot
// mode and outside of drive mode. Disable with ?audio=0 or physics.setAudio(false).

export interface CarSound {
  rpm: number;
  throttle: number;
  speed: number;     // m/s
  slip: number;      // 0..1
  submerged: number; // 0..1+
}

export class CarAudio {
  private ac: AudioContext | null = null;
  private master: GainNode | null = null;
  private engGain!: GainNode;
  private oscA!: OscillatorNode;
  private oscB!: OscillatorNode;
  private oscSub!: OscillatorNode;
  private engFilter!: BiquadFilterNode;
  private noiseGain!: GainNode;
  private noiseFilter!: BiquadFilterNode;
  private squealGain!: GainNode;
  private squealFilter!: BiquadFilterNode;
  private windGain!: GainNode;
  private windFilter!: BiquadFilterNode;
  private rumbleGain!: GainNode;
  private out: AudioNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private level = 0;
  /** keep the audio context running (walking: footsteps) even when the car is silent */
  keepAlive = false;
  enabled = true;
  private failed = false;

  constructor(allowed: boolean) {
    this.enabled = allowed;
    if (!allowed) return;
    const start = () => {
      if (!this.enabled) return;
      try { this.ensure(); void this.ac?.resume(); } catch { /* ignore */ }
    };
    window.addEventListener('keydown', start, { passive: true });
    window.addEventListener('pointerdown', start, { passive: true });
  }

  private ensure(): void {
    if (this.ac || this.failed) return;
    const AC: typeof AudioContext | undefined = (window as any).AudioContext ?? (window as any).webkitAudioContext;
    if (!AC) { this.failed = true; return; }
    try {
      const ac = new AC();
      this.ac = ac;
      const master = ac.createGain();
      master.gain.value = 0;
      const comp = ac.createDynamicsCompressor();
      comp.threshold.value = -14; comp.ratio.value = 4;
      master.connect(comp).connect(ac.destination);
      this.master = master;
      this.out = comp;

      // --- engine: two detuned harmonic-rich oscillators at the firing frequency + half-order sub
      const wave = (() => {
        const n = 24;
        const re = new Float32Array(n), im = new Float32Array(n);
        for (let k = 1; k < n; k++) {
          // odd/even mix typical of an inline-4 exhaust note, rolled off
          im[k] = (k % 2 ? 1 : 0.55) / Math.pow(k, 1.15) * (k === 2 ? 1.4 : 1);
        }
        return ac.createPeriodicWave(re, im);
      })();
      this.oscA = ac.createOscillator(); this.oscA.setPeriodicWave(wave);
      this.oscB = ac.createOscillator(); this.oscB.setPeriodicWave(wave); this.oscB.detune.value = 9;
      this.oscSub = ac.createOscillator(); this.oscSub.type = 'triangle';
      const shaper = ac.createWaveShaper();
      const curve = new Float32Array(1024);
      for (let i = 0; i < curve.length; i++) { const x = (i / (curve.length - 1)) * 2 - 1; curve[i] = Math.tanh(x * 2.2); }
      shaper.curve = curve;
      this.engFilter = ac.createBiquadFilter();
      this.engFilter.type = 'lowpass'; this.engFilter.Q.value = 2.5; this.engFilter.frequency.value = 400;
      this.engGain = ac.createGain(); this.engGain.gain.value = 0.25;
      const mixA = ac.createGain(); mixA.gain.value = 0.5;
      const mixS = ac.createGain(); mixS.gain.value = 0.35;
      this.oscA.connect(mixA); this.oscB.connect(mixA); this.oscSub.connect(mixS);
      mixA.connect(shaper); mixS.connect(shaper);
      shaper.connect(this.engFilter).connect(this.engGain).connect(master);

      // --- shared noise source
      const len = ac.sampleRate * 2;
      const buf = ac.createBuffer(1, len, ac.sampleRate);
      const d = buf.getChannelData(0);
      let b0 = 0;
      for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; b0 = 0.97 * b0 + 0.03 * w; d[i] = w * 0.6 + b0 * 3; }
      this.noiseBuf = buf;
      const noise = ac.createBufferSource();
      noise.buffer = buf; noise.loop = true;
      // intake / exhaust hiss following load
      this.noiseFilter = ac.createBiquadFilter(); this.noiseFilter.type = 'bandpass'; this.noiseFilter.Q.value = 1.2;
      this.noiseGain = ac.createGain(); this.noiseGain.gain.value = 0;
      noise.connect(this.noiseFilter).connect(this.noiseGain).connect(master);
      // tyre squeal: narrow resonant band
      this.squealFilter = ac.createBiquadFilter(); this.squealFilter.type = 'bandpass'; this.squealFilter.Q.value = 18; this.squealFilter.frequency.value = 950;
      this.squealGain = ac.createGain(); this.squealGain.gain.value = 0;
      noise.connect(this.squealFilter).connect(this.squealGain).connect(master);
      // wind
      this.windFilter = ac.createBiquadFilter(); this.windFilter.type = 'highpass'; this.windFilter.frequency.value = 700;
      this.windGain = ac.createGain(); this.windGain.gain.value = 0;
      noise.connect(this.windFilter).connect(this.windGain).connect(master);
      // road rumble
      const rumbleF = ac.createBiquadFilter(); rumbleF.type = 'lowpass'; rumbleF.frequency.value = 140;
      this.rumbleGain = ac.createGain(); this.rumbleGain.gain.value = 0;
      noise.connect(rumbleF).connect(this.rumbleGain).connect(master);

      for (const o of [this.oscA, this.oscB, this.oscSub]) o.start();
      noise.start();
    } catch (e) {
      console.warn('[physics] audio unavailable', e);
      this.failed = true;
      this.ac = null;
    }
  }

  /** Short low thump for impacts (strength 0..1). */
  impact(strength: number): void {
    const ac = this.ac, m = this.master;
    if (!ac || !m || !this.enabled || this.level < 0.05 || strength <= 0.02) return;
    try {
      const o = ac.createOscillator();
      o.type = 'sine';
      const g = ac.createGain();
      const t = ac.currentTime;
      o.frequency.setValueAtTime(90, t);
      o.frequency.exponentialRampToValueAtTime(38, t + 0.25);
      g.gain.setValueAtTime(Math.min(1, strength) * 0.9, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
      o.connect(g).connect(m);
      o.start(t); o.stop(t + 0.4);
    } catch { /* ignore */ }
  }

  /** One footstep: 'hard' (asphalt, paving, concrete), 'soft' (grass, soil) or 'water'. */
  footstep(surface: 'hard' | 'soft' | 'water', strength = 1): void {
    const ac = this.ac, out = this.out, buf = this.noiseBuf;
    if (!ac || !out || !buf || !this.enabled || ac.state !== 'running') return;
    try {
      const t = ac.currentTime;
      const src = ac.createBufferSource();
      src.buffer = buf;
      const f = ac.createBiquadFilter();
      const g = ac.createGain();
      const len = surface === 'water' ? 0.28 : surface === 'soft' ? 0.11 : 0.08;
      if (surface === 'hard') { f.type = 'bandpass'; f.frequency.value = 1700 + Math.random() * 900; f.Q.value = 0.8; }
      else if (surface === 'soft') { f.type = 'lowpass'; f.frequency.value = 520 + Math.random() * 200; f.Q.value = 0.7; }
      else { f.type = 'bandpass'; f.frequency.value = 700 + Math.random() * 300; f.Q.value = 0.6; }
      const v = Math.min(1, strength) * (surface === 'hard' ? 0.22 : surface === 'soft' ? 0.35 : 0.3);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(v, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0005, t + len);
      src.connect(f).connect(g).connect(out);
      src.start(t, Math.random() * (buf.duration - 0.5), len + 0.05);
    } catch { /* ignore */ }
  }

  update(dt: number, active: boolean, s: CarSound | null): void {
    const ac = this.ac;
    if (!ac || !this.master) return;
    const want = active && this.enabled && !document.hidden && s ? 1 : 0;
    this.level += (want - this.level) * Math.min(1, dt * (want ? 2.5 : 4));
    const t = ac.currentTime;
    const tc = 0.05;
    this.master.gain.setTargetAtTime(this.level * 0.55, t, tc);
    if (this.level < 0.002 || !s) {
      if (this.keepAlive && this.enabled) { if (ac.state === 'suspended') void ac.resume().catch(() => undefined); }
      else if (ac.state === 'running' && this.level < 0.002 && !want) void ac.suspend().catch(() => undefined);
      return;
    }
    if (ac.state === 'suspended') void ac.resume().catch(() => undefined);
    const rpm = Math.max(600, s.rpm);
    const fire = (rpm / 60) * 2; // 4-stroke inline-4: two firings per revolution
    this.oscA.frequency.setTargetAtTime(fire, t, tc);
    this.oscB.frequency.setTargetAtTime(fire, t, tc);
    this.oscSub.frequency.setTargetAtTime(fire / 2, t, tc);
    const load = Math.min(1, s.throttle);
    this.engFilter.frequency.setTargetAtTime(220 + rpm * 0.18 + load * 900, t, tc);
    const water = Math.min(1, s.submerged);
    this.engGain.gain.setTargetAtTime((0.16 + 0.22 * load + rpm / 6200 * 0.12) * (1 - 0.7 * water), t, tc);
    this.noiseFilter.frequency.setTargetAtTime(fire * 5, t, tc);
    this.noiseGain.gain.setTargetAtTime(0.015 + 0.05 * load * rpm / 6000, t, tc);
    this.squealGain.gain.setTargetAtTime(Math.min(1, s.slip) * 0.11, t, 0.03);
    this.squealFilter.frequency.setTargetAtTime(850 + Math.min(40, s.speed) * 6, t, 0.1);
    const v = Math.min(60, s.speed);
    this.windGain.gain.setTargetAtTime((v / 60) ** 2 * 0.09, t, 0.2);
    this.rumbleGain.gain.setTargetAtTime(Math.min(1, v / 20) * 0.10, t, 0.2);
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on && this.master && this.ac) this.master.gain.setTargetAtTime(0, this.ac.currentTime, 0.05);
  }
}
