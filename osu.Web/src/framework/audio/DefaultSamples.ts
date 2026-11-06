// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Procedurally synthesised default hitsounds. osu!'s own sample files are licensed CC-BY-NC and are not shipped,
// so every default sample is generated here with an OfflineAudioContext.

type Synth = (ctx: OfflineAudioContext, out: AudioNode) => void;

interface SampleDef {
  duration: number;
  synth: Synth;
}

function noiseBuffer(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
  const d = buf.getChannelData(0);
  let seed = 1234567;
  for (let i = 0; i < d.length; i++) {
    // xorshift for deterministic noise
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    d[i] = ((seed >>> 0) / 4294967295) * 2 - 1;
  }
  return buf;
}

function env(ctx: BaseAudioContext, peak: number, attack: number, decay: number, start = 0): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, start);
  g.gain.linearRampToValueAtTime(peak, start + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, start + attack + decay);
  return g;
}

function tone(ctx: OfflineAudioContext, out: AudioNode, type: OscillatorType, freq: number, peak: number, attack: number, decay: number, start = 0, endFreq?: number): void {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, start);
  if (endFreq) o.frequency.exponentialRampToValueAtTime(endFreq, start + attack + decay);
  const g = env(ctx, peak, attack, decay, start);
  o.connect(g).connect(out);
  o.start(start);
  o.stop(start + attack + decay + 0.01);
}

function noise(ctx: OfflineAudioContext, out: AudioNode, filterType: BiquadFilterType, freq: number, q: number, peak: number, attack: number, decay: number, start = 0): void {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, attack + decay + 0.05);
  const f = ctx.createBiquadFilter();
  f.type = filterType;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = env(ctx, peak, attack, decay, start);
  src.connect(f).connect(g).connect(out);
  src.start(start);
}

const banks: Record<string, Record<string, SampleDef>> = {
  normal: {
    hitnormal: {
      duration: 0.12,
      synth: (c, o) => {
        noise(c, o, 'highpass', 3000, 0.7, 0.55, 0.001, 0.03);
        tone(c, o, 'sine', 1900, 0.35, 0.001, 0.05, 0, 1500);
        tone(c, o, 'triangle', 420, 0.25, 0.001, 0.06);
      },
    },
    hitwhistle: {
      duration: 0.35,
      synth: (c, o) => {
        tone(c, o, 'sine', 2150, 0.28, 0.005, 0.28);
        tone(c, o, 'sine', 3220, 0.1, 0.005, 0.2);
      },
    },
    hitfinish: {
      duration: 1.2,
      synth: (c, o) => {
        noise(c, o, 'highpass', 5200, 0.5, 0.45, 0.002, 1.0);
        noise(c, o, 'bandpass', 8000, 1.5, 0.2, 0.002, 0.6);
        for (const f of [587, 845, 1203, 1517]) tone(c, o, 'square', f, 0.025, 0.002, 0.8);
      },
    },
    hitclap: {
      duration: 0.25,
      synth: (c, o) => {
        for (const t of [0, 0.011, 0.022]) noise(c, o, 'bandpass', 1500, 1.2, 0.6, 0.001, 0.012, t);
        noise(c, o, 'bandpass', 1300, 0.9, 0.45, 0.001, 0.16, 0.03);
      },
    },
    slidertick: {
      duration: 0.06,
      synth: (c, o) => {
        tone(c, o, 'sine', 3000, 0.25, 0.001, 0.035);
        noise(c, o, 'highpass', 6000, 0.7, 0.12, 0.001, 0.015);
      },
    },
    sliderslide: {
      duration: 1.0,
      synth: (c, o) => {
        const src = c.createBufferSource();
        src.buffer = noiseBuffer(c, 1.0);
        const f = c.createBiquadFilter();
        f.type = 'bandpass';
        f.frequency.value = 1800;
        f.Q.value = 0.8;
        const g = c.createGain();
        g.gain.value = 0.08;
        src.connect(f).connect(g).connect(o);
        src.start();
      },
    },
    sliderwhistle: {
      duration: 1.0,
      synth: (c, o) => {
        const osc = c.createOscillator();
        osc.frequency.value = 1600;
        const lfo = c.createOscillator();
        lfo.frequency.value = 6;
        const lfoGain = c.createGain();
        lfoGain.gain.value = 20;
        lfo.connect(lfoGain).connect(osc.frequency);
        const g = c.createGain();
        g.gain.value = 0.07;
        osc.connect(g).connect(o);
        osc.start();
        lfo.start();
      },
    },
  },
  soft: {
    hitnormal: {
      duration: 0.15,
      synth: (c, o) => {
        tone(c, o, 'sine', 900, 0.4, 0.002, 0.08, 0, 600);
        noise(c, o, 'lowpass', 2500, 0.7, 0.2, 0.002, 0.04);
      },
    },
    hitwhistle: {
      duration: 0.4,
      synth: (c, o) => {
        tone(c, o, 'triangle', 1400, 0.3, 0.01, 0.32);
        tone(c, o, 'sine', 2100, 0.08, 0.01, 0.25);
      },
    },
    hitfinish: {
      duration: 1.0,
      synth: (c, o) => {
        noise(c, o, 'bandpass', 4000, 0.6, 0.3, 0.005, 0.8);
        tone(c, o, 'sine', 523, 0.12, 0.005, 0.7);
        tone(c, o, 'sine', 784, 0.08, 0.005, 0.6);
      },
    },
    hitclap: {
      duration: 0.22,
      synth: (c, o) => {
        for (const t of [0, 0.012]) noise(c, o, 'bandpass', 1100, 1.0, 0.4, 0.001, 0.015, t);
        noise(c, o, 'lowpass', 1800, 0.7, 0.3, 0.002, 0.12, 0.02);
      },
    },
    slidertick: {
      duration: 0.07,
      synth: (c, o) => tone(c, o, 'sine', 2000, 0.22, 0.001, 0.045),
    },
    sliderslide: {
      duration: 1.0,
      synth: (c, o) => {
        const src = c.createBufferSource();
        src.buffer = noiseBuffer(c, 1.0);
        const f = c.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = 900;
        const g = c.createGain();
        g.gain.value = 0.1;
        src.connect(f).connect(g).connect(o);
        src.start();
      },
    },
    sliderwhistle: {
      duration: 1.0,
      synth: (c, o) => {
        const osc = c.createOscillator();
        osc.type = 'triangle';
        osc.frequency.value = 1200;
        const g = c.createGain();
        g.gain.value = 0.06;
        osc.connect(g).connect(o);
        osc.start();
      },
    },
  },
  drum: {
    hitnormal: {
      duration: 0.25,
      synth: (c, o) => {
        tone(c, o, 'sine', 190, 0.8, 0.001, 0.18, 0, 55);
        noise(c, o, 'lowpass', 3000, 0.7, 0.25, 0.001, 0.02);
      },
    },
    hitwhistle: {
      duration: 0.25,
      synth: (c, o) => {
        tone(c, o, 'triangle', 520, 0.4, 0.001, 0.15, 0, 380);
        noise(c, o, 'bandpass', 2500, 1, 0.15, 0.001, 0.05);
      },
    },
    hitfinish: {
      duration: 1.2,
      synth: (c, o) => {
        tone(c, o, 'sine', 110, 0.7, 0.002, 0.6, 0, 45);
        noise(c, o, 'highpass', 4000, 0.5, 0.35, 0.002, 1.0);
      },
    },
    hitclap: {
      duration: 0.3,
      synth: (c, o) => {
        noise(c, o, 'bandpass', 2000, 0.8, 0.6, 0.001, 0.18);
        tone(c, o, 'triangle', 240, 0.35, 0.001, 0.08, 0, 160);
      },
    },
    slidertick: {
      duration: 0.06,
      synth: (c, o) => noise(c, o, 'bandpass', 4500, 2, 0.4, 0.001, 0.03),
    },
    sliderslide: {
      duration: 1.0,
      synth: (c, o) => {
        const src = c.createBufferSource();
        src.buffer = noiseBuffer(c, 1.0);
        const f = c.createBiquadFilter();
        f.type = 'bandpass';
        f.frequency.value = 600;
        const g = c.createGain();
        g.gain.value = 0.1;
        src.connect(f).connect(g).connect(o);
        src.start();
      },
    },
    sliderwhistle: {
      duration: 1.0,
      synth: (c, o) => {
        const osc = c.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = 400;
        const f = c.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = 1200;
        const g = c.createGain();
        g.gain.value = 0.04;
        osc.connect(f).connect(g).connect(o);
        osc.start();
      },
    },
  },
};

const generic: Record<string, SampleDef> = {
  spinnerspin: {
    duration: 1.0,
    synth: (c, o) => {
      const osc = c.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = 220;
      const f = c.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 900;
      const g = c.createGain();
      g.gain.value = 0.06;
      osc.connect(f).connect(g).connect(o);
      osc.start();
    },
  },
  spinnerbonus: {
    duration: 0.6,
    synth: (c, o) => {
      tone(c, o, 'sine', 2637, 0.25, 0.002, 0.5);
      tone(c, o, 'sine', 3951, 0.12, 0.002, 0.35);
    },
  },
  combobreak: {
    duration: 0.5,
    synth: (c, o) => {
      tone(c, o, 'sawtooth', 440, 0.18, 0.005, 0.4, 0, 110);
      noise(c, o, 'lowpass', 1200, 0.7, 0.2, 0.002, 0.2);
    },
  },
  'catch-banana': {
    duration: 0.25,
    synth: (c, o) => {
      tone(c, o, 'sine', 1568, 0.22, 0.002, 0.18);
      tone(c, o, 'triangle', 2349, 0.08, 0.002, 0.12);
    },
  },
  metronomelow: {
    duration: 0.12,
    synth: (c, o) => tone(c, o, 'sine', 880, 0.25, 0.001, 0.08),
  },
  'menu-click': {
    duration: 0.08,
    synth: (c, o) => tone(c, o, 'sine', 1400, 0.2, 0.001, 0.05, 0, 900),
  },
  // UI/cursor-tap (MenuCursorContainer)
  'cursor-tap': {
    duration: 0.04,
    synth: (c, o) => tone(c, o, 'sine', 900, 0.1, 0.0005, 0.03, 0, 600),
  },
  // UI/notch-tick (VolumeMeter / slider notches): a short soft click.
  'notch-tick': {
    duration: 0.03,
    synth: (c, o) => tone(c, o, 'triangle', 1800, 0.12, 0.0005, 0.02),
  },
  'menu-hover': {
    duration: 0.05,
    synth: (c, o) => tone(c, o, 'sine', 2400, 0.06, 0.001, 0.03),
  },
  'menu-back': {
    duration: 0.15,
    synth: (c, o) => tone(c, o, 'triangle', 700, 0.2, 0.002, 0.1, 0, 400),
  },
  'menu-confirm': {
    duration: 0.3,
    synth: (c, o) => {
      tone(c, o, 'sine', 880, 0.18, 0.002, 0.2);
      tone(c, o, 'sine', 1320, 0.14, 0.05, 0.2, 0.05);
    },
  },
  'fail': {
    duration: 1.5,
    synth: (c, o) => {
      tone(c, o, 'sawtooth', 330, 0.15, 0.01, 1.3, 0, 60);
      tone(c, o, 'square', 220, 0.06, 0.01, 1.2, 0, 50);
    },
  },
};

async function render(sampleRate: number, def: SampleDef): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, Math.ceil(sampleRate * def.duration), sampleRate);
  const out = ctx.createGain();
  out.connect(ctx.destination);
  def.synth(ctx, out);
  return ctx.startRendering();
}

/** Returns a map of "bank-name" (and bare "name" for generic samples) to rendered buffers. */
export async function synthesiseDefaultSamples(sampleRate: number): Promise<Map<string, AudioBuffer>> {
  const out = new Map<string, AudioBuffer>();
  const jobs: Promise<void>[] = [];
  for (const [bank, defs] of Object.entries(banks)) {
    for (const [name, def] of Object.entries(defs)) {
      jobs.push(render(sampleRate, def).then(b => void out.set(`${bank}-${name}`, b)));
    }
  }
  for (const [name, def] of Object.entries(generic)) jobs.push(render(sampleRate, def).then(b => void out.set(name, b)));
  await Promise.all(jobs);
  // Bank-qualified fallbacks for generic samples.
  for (const bank of Object.keys(banks)) {
    for (const name of ['spinnerspin', 'spinnerbonus']) out.set(`${bank}-${name}`, out.get(name)!);
  }
  return out;
}
