// Headless smoke test: load the client module with mocked React + Web Audio +
// canvas 2D, run apply(), render the dock (panel forced open), and drive both
// the audio engine and the water renderer.
// Offline self-check for the plugin's Client half: loads client.js with a
// mocked React, Web Audio, canvas 2D and DOM, then drives the engine and the
// rendered tree. Run with: node tools/verify.cjs
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'client.js');

class Param {
  constructor(v) { this.value = v; }
  cancelScheduledValues() {}
  setValueAtTime(v) { this.value = v; }
  linearRampToValueAtTime(v) { this.value = v; }
}
class Node {
  constructor() { this.outputs = []; }
  connect(target) { this.outputs.push(target); return target; }
  disconnect() { this.outputs = []; }
}
class GainNode extends Node { constructor() { super(); this.gain = new Param(1); } }
class BiquadNode extends Node {
  constructor() { super(); this.type = 'lowpass'; this.frequency = new Param(350); this.Q = new Param(1); this.gain = new Param(0); }
}
class CompressorNode extends Node {
  constructor() { super(); for (const n of ['threshold', 'knee', 'ratio', 'attack', 'release']) this[n] = new Param(0); }
}
class AnalyserNode extends Node {
  constructor() { super(); this.fftSize = 2048; this.smoothingTimeConstant = 0; this.calls = 0; }
  getFloatTimeDomainData(out) {
    this.calls += 1;
    for (let i = 0; i < out.length; i += 1) out[i] = Math.sin(i * 0.13) * 0.02;
  }
}
class SourceNode extends Node {
  constructor() { super(); this.buffer = null; this.loop = false; this.started = false; this.stopped = false; }
  start() { this.started = true; }
  stop() { this.stopped = true; }
}
class AudioBufferMock {
  constructor(channels, length, sampleRate) {
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.channels = [];
    for (let channel = 0; channel < channels; channel += 1) this.channels.push(new Float32Array(length));
  }
  copyToChannel(source, channel = 0) { this.channels[channel].set(source.subarray(0, this.length)); }
  getChannelData(channel = 0) { return this.channels[channel]; }
}
const created = { contexts: 0, buffers: [], sources: [], nodes: [], analysers: [], gradients: 0, strokes: 0, fills: 0, raf: 0, cancelled: 0 };
class AudioContextMock {
  constructor() {
    created.contexts += 1;
    this.state = 'suspended';
    this.currentTime = 0;
    this.sampleRate = 48000;
    this.destination = new Node();
  }
  createGain() { const n = new GainNode(); created.nodes.push(n); return n; }
  createBiquadFilter() { const n = new BiquadNode(); created.nodes.push(n); return n; }
  createBufferSource() { const n = new SourceNode(); created.sources.push(n); return n; }
  createDynamicsCompressor() { const n = new CompressorNode(); created.nodes.push(n); return n; }
  createAnalyser() { const n = new AnalyserNode(); created.analysers.push(n); return n; }
  createBuffer(channels, length, sampleRate) { const b = new AudioBufferMock(channels, length, sampleRate); created.buffers.push(b); return b; }
  resume() { this.state = 'running'; return Promise.resolve(); }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
}

function makeGradient() { created.gradients += 1; return { addColorStop() {} }; }
function make2dContext() {
  const ctx = {
    fillStyle: '#000000', strokeStyle: '#000000', lineWidth: 1, globalAlpha: 1, lineJoin: 'miter', lineCap: 'butt',
    clearRect() {}, fillRect() {}, setTransform() {}, save() {}, restore() {},
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {}, arc() {}, clip() {},
    fill() { created.fills += 1; }, stroke() { created.strokes += 1; },
    createLinearGradient: makeGradient, createRadialGradient: makeGradient,
  };
  return ctx;
}
const canvases = [];
function makeCanvas(className) {
  const canvas = {
    className,
    width: 1,
    height: 1,
    style: {},
    getContext: () => make2dContext(),
    getBoundingClientRect: () => (
      className === 'adn-orb'
        ? { width: 132, height: 132 }
        : className === 'adn-orbdot'
          ? { width: 20, height: 20 }
          : { width: 46, height: 18 }
    ),
  };
  canvases.push(canvas);
  return canvas;
}

const storage = new Map();
let rafBudget = 0;
const realNow = Date.now;
let fakeNow = realNow();
Date.now = () => fakeNow;
const intervals = new Map();
let intervalSeq = 0;
global.window = {
  AudioContext: AudioContextMock,
  localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) },
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: (fn) => {
    intervalSeq += 1;
    intervals.set(intervalSeq, fn);
    return intervalSeq;
  },
  clearInterval: (id) => intervals.delete(id),
  __ADHD_NOISE_DEFAULTS__: { sound: 'brown', volume: 0.4, timerMinutes: 50 },
  addEventListener() {},
  removeEventListener() {},
  innerWidth: 1440,
  innerHeight: 900,
  devicePixelRatio: 2,
  matchMedia: () => ({ matches: false }),
  getComputedStyle: () => ({
    getPropertyValue: (name) => {
      if (name === '--dsw-alias-brand-primary') return 'rgb(79, 140, 255)';
      if (name === '--dsw-alias-bg-base') return '#0e1116';
      return '#9fb3d0';
    },
  }),
  requestAnimationFrame: (fn) => {
    if (rafBudget > 4) return 0;
    rafBudget += 1;
    created.raf += 1;
    fn(rafBudget * 16);
    return rafBudget;
  },
  cancelAnimationFrame: () => { created.cancelled += 1; },
  ResizeObserver: class { constructor() {} observe() {} disconnect() {} },
};

global.document = {
  documentElement: {},
  addEventListener() {},
  removeEventListener() {},
};
global.MutationObserver = class {
  observe() {}
  disconnect() {}
};

// React mock: refs are attached to fake canvases during render, effects run after.
const effects = [];
function makeMockNode(className) {
  return {
    className,
    dataset: {},
    style: { setProperty() {} },
    getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0 }),
    contains: () => false,
  };
}
function makeElement(type, props, children) {
  const elementProps = props || {};
  if (elementProps.ref) {
    elementProps.ref.current = type === 'canvas' ? makeCanvas(elementProps.className) : makeMockNode(elementProps.className);
  }
  return { type, props: elementProps, children: Array.isArray(children) ? children : [children] };
}
function createElement(type, props, ...children) {
  return makeElement(type, props, children);
}
const ReactMock = {
  createElement,
  useRef(initial) { return { current: initial === undefined ? null : initial }; },
  useState(initial) {
    if (initial === false) return [true, () => {}]; // force the settings panel open
    return [typeof initial === 'function' ? initial() : initial, () => {}];
  },
  useEffect(fn) { effects.push(fn); },
  useSyncExternalStore(getSnapshot) { return getSnapshot(); },
};

let moduleDefinition = null;
global.window.__ModuleLoader__ = { load(def) { moduleDefinition = def; } };
const requireMock = (id) => {
  if (id === 'react') return ReactMock;
  throw new Error('unexpected require: ' + id);
};
new Function('window', 'require', fs.readFileSync(SRC, 'utf8'))(global.window, requireMock);

if (!moduleDefinition) throw new Error('client module did not register');
if (moduleDefinition.id !== 'dsh-adhd-noise') throw new Error('module id mismatch: ' + moduleDefinition.id);

const plugin = moduleDefinition.factory(requireMock);
const registered = [];
const pluginEffects = [];
const ctx = {
  effect(fn, label) { const dispose = fn(); pluginEffects.push({ label, dispose }); return dispose; },
  slots: {
    inject(key, callback) { return callback(); },
    register(options, component) { registered.push({ options, component }); return () => {}; },
  },
  locale: {
    register(namespace, dicts) { registered.dicts = dicts; registered.namespace = namespace; return () => {}; },
    bind() { return (key) => key; },
    subscribe() { return () => {}; },
    getSnapshot() { return { revision: 3, active: 'zh' }; },
  },
  get() { return undefined; },
};
plugin.apply(ctx);
if (registered.length !== 3) throw new Error('expected three slot registrations, got ' + registered.length);
const pillEntry = registered.find((r) => r.options.name === 'conversation.composer.dock');
const probeEntry = registered.find((r) => r.options.name === 'conversation.input.dock');
const panelEntry = registered.find((r) => r.options.name === 'shell.overlay');
if (!pillEntry) throw new Error('missing composer dock pill registration');
if (!probeEntry) throw new Error('missing composer anchor registration');
if (!panelEntry) throw new Error('missing overlay panel registration');
if (pillEntry.options.id !== 'adhd-noise') throw new Error('wrong pill id: ' + pillEntry.options.id);
if (probeEntry.options.id !== 'adhd-noise-anchor') throw new Error('wrong anchor id: ' + probeEntry.options.id);
if (panelEntry.options.id !== 'adhd-noise-panel') throw new Error('wrong panel id: ' + panelEntry.options.id);
const dicts = registered.dicts;
if (!dicts || !dicts.zh || !dicts.en) throw new Error('locale dictionaries not registered');

const injected = pillEntry.options.inject();
const panelInjected = panelEntry.options.inject();
const probeInjected = probeEntry.options.inject();
const engine = injected.engine;
const initial = engine.getSnapshot();
if (initial.sound !== 'brown' || initial.volume !== 0.4 || initial.timerMinutes !== 50) {
  throw new Error('host-injected defaults were not applied: ' + JSON.stringify(initial));
}
if (panelInjected.engine !== engine) throw new Error('all entries must share one engine');
if (probeInjected.ui !== injected.ui) throw new Error('all entries must share one visibility state');
const usedKeys = new Set();
const t = (key) => { usedKeys.add(key); return dicts.zh[key] ?? ('MISSING:' + key); };
const props = { ...injected, t };

function render(element, out) {
  if (element === null || element === undefined || typeof element !== 'object') {
    if (element !== null && element !== undefined) out.text.push(String(element));
    return;
  }
  if (Array.isArray(element)) { element.forEach((child) => render(child, out)); return; }
  const elementProps = element.props || {};
  if (typeof element.type === 'function') { render(element.type({ ...props, ...elementProps, children: element.children }), out); return; }
  out.tags.push(element.type + ' ' + (elementProps.className || ''));
  if (element.type === 'input') out.inputs.push(elementProps);
  if (element.type === 'div' && elementProps.className === 'adn-overlay') out.overlayStyle = elementProps.style;
  (element.children || []).forEach((child) => render(child, out));
}

function renderAll(out) {
  render(pillEntry.component(props), out);
  render(probeEntry.component(props), out);
  render(panelEntry.component(props), out);
}

// Play once so the analyser exists, open the popover, then render everything.
engine.play();
if (created.contexts !== 1) throw new Error('AudioContext should be created on play');
injected.ui.toggle();
if (!injected.ui.isOpen()) throw new Error('ui.toggle did not open the popover');
const out = { tags: [], text: [], inputs: [] };
renderAll(out);

if (process.env.DUMP) console.log(out.tags.join('\n'));
if (!out.tags.some((tag) => tag.startsWith('div adn-pill'))) throw new Error('missing pill');
if (!out.tags.some((tag) => tag.startsWith('canvas adn-orbdot'))) throw new Error('missing pill orb dot canvas');
if (!out.tags.some((tag) => tag.startsWith('div adn-probe'))) throw new Error('missing zero-height anchor probe');
if (!out.tags.some((tag) => tag.startsWith('div adn-overlay'))) throw new Error('missing overlay wrapper');
if (!out.tags.some((tag) => tag.startsWith('div adn-panel'))) throw new Error('missing panel');
if (!out.tags.some((tag) => tag.startsWith('canvas adn-orb'))) throw new Error('missing panel sound orb canvas');
if (!out.tags.some((tag) => tag.startsWith('div adn-hero'))) throw new Error('missing panel hero row');
if (!out.tags.some((tag) => tag.startsWith('h2 adn-display'))) throw new Error('missing serif display title');
if (!out.tags.some((tag) => tag.startsWith('button adn-close'))) throw new Error('missing panel close button');
const overlayStyle = out.overlayStyle || {};
if (overlayStyle.position !== 'fixed') throw new Error('popover must be fixed-positioned, got ' + JSON.stringify(overlayStyle));
if (typeof overlayStyle.right !== 'string' || typeof overlayStyle.bottom !== 'string') throw new Error('popover lacks anchor geometry: ' + JSON.stringify(overlayStyle));
const volumeInput = out.inputs.find((input) => input.type === 'range');
if (!volumeInput) throw new Error('missing volume slider');
const soundCount = out.tags.filter((tag) => tag.startsWith('button adn-sound')).length;
if (soundCount !== 5) throw new Error('expected 5 tinted sound orbs, got ' + soundCount);
const timeCount = out.tags.filter((tag) => tag.startsWith('button adn-time')).length;
if (timeCount !== 5) throw new Error('expected 5 timer pills, got ' + timeCount);

// Closing drops the popover but keeps the pill and the hidden probe.
injected.ui.close();
const collapsed = { tags: [], text: [], inputs: [] };
renderAll(collapsed);
if (collapsed.tags.some((tag) => tag.startsWith('div adn-overlay'))) throw new Error('popover should be gone after close');
if (!collapsed.tags.some((tag) => tag.startsWith('div adn-pill'))) throw new Error('pill should stay after close');
if (!collapsed.tags.some((tag) => tag.startsWith('div adn-probe'))) throw new Error('anchor probe should stay mounted');

// Run the React effects (water renderers, subscriptions, listeners) while open.
injected.ui.toggle();
const effectsOut = { tags: [], text: [], inputs: [] };
renderAll(effectsOut);
let effectCursor = 0;
function runPendingEffects() {
  while (effectCursor < effects.length) {
    const cleanup = effects[effectCursor]();
    effectCursor += 1;
    if (typeof cleanup === 'function') effects.cleanup = (effects.cleanup || []).concat(cleanup);
  }
}
runPendingEffects();

// After effects the probe has published an anchor rect the popover can use.
injected.ui.setAnchorRect({ top: 640, right: 1180, left: 236, bottom: 640, width: 944, height: 0 });
const anchored = { tags: [], text: [], inputs: [] };
render(panelEntry.component(props), anchored);
const anchoredStyle = anchored.overlayStyle || {};
if (anchoredStyle.position !== 'fixed') throw new Error('anchored popover must stay fixed');
if (anchoredStyle.bottom !== '268px') throw new Error('expected bottom 268px above the composer, got ' + anchoredStyle.bottom);
if (anchoredStyle.right !== '260px') throw new Error('expected right 260px from the composer edge, got ' + anchoredStyle.right);

// With a measured composer bottom the panel bottom must align with it exactly.
injected.ui.setAnchorRect({ top: 640, right: 1180, composerBottom: 812 });
const aligned = { tags: [], text: [], inputs: [] };
render(panelEntry.component(props), aligned);
const alignedStyle = aligned.overlayStyle || {};
if (alignedStyle.bottom !== '88px') throw new Error('expected bottom-aligned 88px (900-812), got ' + alignedStyle.bottom);
if (alignedStyle.right !== '260px') throw new Error('bottom alignment must not change the right anchor, got ' + alignedStyle.right);

injected.ui.setAnchorRect({
  top: 640,
  right: 1180,
  composerBottom: 812,
  composer: { left: 600, right: 1180, top: 700, bottom: 812, width: 580, height: 112 },
});
const flipped = { tags: [], text: [], inputs: [] };
render(panelEntry.component(props), flipped);
if (flipped.overlayStyle.right !== '848px') {
  throw new Error('expected the card to flip left of the composer (848px), got ' + flipped.overlayStyle.right);
}

injected.ui.setAnchorRect({
  top: 640,
  right: 1200,
  composerBottom: 812,
  composer: { left: 200, right: 1200, top: 700, bottom: 812, width: 1000, height: 112 },
});
const stacked = { tags: [], text: [], inputs: [] };
render(panelEntry.component(props), stacked);
if (stacked.overlayStyle.bottom !== '208px') {
  throw new Error('expected the card above the composer when no side room (208px), got ' + stacked.overlayStyle.bottom);
}
runPendingEffects();

if (created.gradients < 2) throw new Error('water renderer did not build gradients');
if (created.strokes < 2) throw new Error('water renderer did not stroke the surface');
if (created.fills < 3) throw new Error('water renderer did not fill sheets');
if (canvases.length < 3) throw new Error('expected at least three canvases, got ' + canvases.length);
for (const canvas of canvases) {
  if (canvas.width <= 1 || canvas.height <= 1) throw new Error('canvas was never sized: ' + canvas.className);
}
const orbCanvas = canvases.find((canvas) => canvas.className === 'adn-orb');
const dotCanvas = canvases.find((canvas) => canvas.className === 'adn-orbdot');
if (!orbCanvas || orbCanvas.height !== 264 || orbCanvas.width !== 264) {
  throw new Error('orb canvas geometry wrong: ' + JSON.stringify(orbCanvas && { w: orbCanvas.width, h: orbCanvas.height }));
}
if (!dotCanvas || dotCanvas.height !== 40 || dotCanvas.width !== 40) {
  throw new Error('orb dot canvas geometry wrong: ' + JSON.stringify(dotCanvas && { w: dotCanvas.width, h: dotCanvas.height }));
}
if (created.analysers.length !== 1) throw new Error('expected one analyser');
if (created.analysers[0].calls === 0) throw new Error('analyser data was never read');
const waveform = new Float32Array(1024);
if (engine.readWaveform(waveform) !== true) throw new Error('engine.readWaveform failed');
if (!waveform.some((v) => v !== 0)) throw new Error('engine.readWaveform returned silence');

// Missing translation keys?
const missing = [...usedKeys].filter((key) => !(key in dicts.zh) || !(key in dicts.en));
if (missing.length) throw new Error('missing locale keys: ' + missing.join(', '));

// Engine behaviour: switch through every preset so each buffer is rendered.
for (const sound of ['brown', 'pink', 'white', 'rain', 'fan']) engine.setSound(sound);
engine.setVolume(0.75);
engine.setTimer(0);
engine.play();
engine.pause();
if (engine.getSnapshot().status !== 'idle') throw new Error('pause failed');

// Buffer quality.
const stats = created.buffers.map((buffer) => {
  let sum = 0;
  let peak = 0;
  let total = 0;
  for (const data of buffer.channels) {
    for (let i = 0; i < data.length; i += 1) {
      sum += data[i] * data[i];
      total += 1;
      const magnitude = Math.abs(data[i]);
      if (magnitude > peak) peak = magnitude;
    }
  }
  return {
    channels: buffer.channels.length,
    seconds: (buffer.length / buffer.sampleRate).toFixed(1),
    rms: Math.sqrt(sum / total),
    peak,
  };
});
if (stats.length !== 5) throw new Error('expected 5 generated buffers, got ' + stats.length);
for (const s of stats) {
  if (s.peak > 1.8) throw new Error('buffer peak absurdly high: ' + JSON.stringify(s));
  if (s.rms < 0.19 || s.rms > 0.21) throw new Error('buffer RMS out of range: ' + JSON.stringify(s));
}

const stereoCount = stats.filter((entry) => entry.channels === 2).length;
if (stereoCount !== 2) throw new Error('expected rain/fan stereo buffers, got ' + stereoCount + ' of ' + stats.length);

// Unmount: effect cleanups must not throw.
for (const cleanup of effects.cleanup || []) cleanup();
for (const effect of pluginEffects) { if (typeof effect.dispose === 'function') effect.dispose(); }

console.log('OK  pill=%s/%s  anchor=%s/%s  popover=%s/%s',
  pillEntry.options.name, pillEntry.options.id, probeEntry.options.name, probeEntry.options.id,
  panelEntry.options.name, panelEntry.options.id);
console.log('OK  canvases=%d sized=%s', canvases.length, canvases.map((c) => c.width + 'x' + c.height).join(', '));
console.log('OK  water draws: gradients=%d strokes=%d fills=%d raf=%d', created.gradients, created.strokes, created.fills, created.raf);
console.log('OK  analyser reads=%d  waveform non-zero=%s', created.analysers[0].calls, waveform.some((v) => v !== 0));
console.log('OK  sounds=%d timers=%d  locale keys used=%d  buffers=%s', soundCount, timeCount, usedKeys.size,
  stats.map((s) => `${s.seconds}s rms=${s.rms.toFixed(3)} peak=${s.peak.toFixed(2)}`).join(' | '));
