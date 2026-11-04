/**
 * ADHD focus noise — Client half.
 *
 * Synthesises brown / pink / white noise plus rain and fan soundscapes with the
 * Web Audio API and renders a compact player in the composer dock, so the sound
 * keeps running while the user works in DSH. Nothing is downloaded: every sound
 * is generated from a looped, seam-blended noise buffer.
 *
 * Signal path: buffer -> preset biquads -> trim -> fade -> master -> limiter.
 * The trim constants are measured loudness corrections, so switching presets
 * does not feel like a volume jump.
 */
window.__ModuleLoader__.load({
  id: 'dsh-adhd-noise',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NAMESPACE = 'adhd-noise';
    const STORAGE_KEY = 'dsh.adhd-noise.v1';
    const SOUND_IDS = ['brown', 'pink', 'white', 'rain', 'fan'];
    const TIMER_OPTIONS = [0, 15, 25, 50, 90];
    const SOUND_LABEL_KEYS = {
      brown: 'soundBrown',
      pink: 'soundPink',
      white: 'soundWhite',
      rain: 'soundRain',
      fan: 'soundFan',
    };
    const MAX_MASTER_GAIN = 1;
    const VOLUME_EXPONENT = 1.8;
    const FADE_IN_SECONDS = 1.5;
    const FADE_OUT_SECONDS = 2;
    const CROSSFADE_SECONDS = 1.2;
    const TIMER_FADE_OUT_SECONDS = 8;
    const LOOP_SECONDS = 8;
    const LOOP_FADE_SECONDS = 0.4;
    const TARGET_RMS = 0.2;
    const LOUD_VOLUME_THRESHOLD = 0.6;

    /**
     * Per-preset trims are loudness corrections applied on top of an equal-RMS
     * buffer: white noise is the reference (1.0) and the darker or more
     * low-end-heavy presets are scaled down so a preset change keeps the
     * perceived level. Brown also needs a mandatory 50 Hz high-pass — most of
     * its 1/f^2 energy sits below that and would only cost headroom.
     */
    const SOUND_PRESETS = {
      white: {
        trim: 1,
        chain: [
          { type: 'highpass', frequency: 30, q: 0.707 },
          { type: 'lowpass', frequency: 16000, q: 0.5 },
          { type: 'highshelf', frequency: 8000, q: 0.707, gain: -2 },
        ],
      },
      pink: {
        trim: 0.891,
        chain: [
          { type: 'highpass', frequency: 40, q: 0.707 },
          { type: 'lowpass', frequency: 12000, q: 0.5 },
          { type: 'highshelf', frequency: 6000, q: 0.707, gain: -1.5 },
        ],
      },
      brown: {
        trim: 0.398,
        chain: [
          { type: 'highpass', frequency: 50, q: 0.707 },
          { type: 'lowpass', frequency: 2500, q: 0.5 },
        ],
      },
      rain: {
        trim: 0.708,
        chain: [
          { type: 'highpass', frequency: 350, q: 0.707 },
          { type: 'lowpass', frequency: 9000, q: 0.707 },
          { type: 'peaking', frequency: 2500, q: 1, gain: 2 },
        ],
      },
      fan: {
        trim: 0.562,
        chain: [
          { type: 'highpass', frequency: 40, q: 0.707 },
          { type: 'lowpass', frequency: 350, q: 0.707 },
          { type: 'peaking', frequency: 180, q: 1.2, gain: 3 },
          { type: 'lowpass', frequency: 1200, q: 0.5 },
        ],
      },
    };

    const DICT_ZH = {
      title: 'ADHD 专注白噪音',
      play: '播放',
      pause: '暂停',
      standby: '专注白噪音',
      openSettings: '环境音设置',
      panelTitle: '环境音设置',
      close: '关闭',
      sound: '声音',
      volume: '音量',
      timer: '定时',
      timerOff: '不限时',
      timer15: '15 分钟',
      timer25: '25 分钟',
      timer50: '50 分钟',
      timer90: '90 分钟',
      soundBrown: '棕色噪声',
      soundPink: '粉红噪声',
      soundWhite: '白噪声',
      soundRain: '雨声',
      soundFan: '风扇',
      soundBrownNote: '棕色噪声暂无对照研究，更多是个人偏好',
      hint: '音量以刚好盖住环境杂音为宜；白/粉噪声有少量研究支持，棕色更多是个人偏好。',
      loudHint: '音量偏高，长时间大音量可能损伤听力，建议调低一些。',
      timerDone: '本次专注时间已结束，休息一下；需要时再点播放即可继续。',
      unsupported: '当前环境不支持 Web Audio API，无法播放环境音。',
      blockedHint: '浏览器暂时没有允许播放，请再点一次播放按钮。',
    };

    const DICT_EN = {
      title: 'ADHD Focus Noise',
      play: 'Play',
      pause: 'Pause',
      standby: 'Focus noise',
      openSettings: 'Focus noise options',
      panelTitle: 'Focus noise options',
      close: 'Close',
      sound: 'Sound',
      volume: 'Volume',
      timer: 'Timer',
      timerOff: 'No limit',
      timer15: '15 min',
      timer25: '25 min',
      timer50: '50 min',
      timer90: '90 min',
      soundBrown: 'Brown noise',
      soundPink: 'Pink noise',
      soundWhite: 'White noise',
      soundRain: 'Rain',
      soundFan: 'Fan',
      soundBrownNote: 'Brown noise has no controlled ADHD trials yet; it is a personal preference',
      hint: 'Set the volume just loud enough to mask distractions; white and pink noise have modest research support, brown is a personal preference.',
      loudHint: 'This is quite loud. Long sessions at high volume can damage hearing; consider turning it down.',
      timerDone: 'This focus block ended. Take a break, and press play whenever you want to continue.',
      unsupported: 'This environment does not support the Web Audio API, so the focus noise cannot play.',
      blockedHint: 'The browser did not allow playback yet. Press play once more.',
    };

    // ---------------------------------------------------------------- helpers

    function clamp(value, min, max) {
      if (!Number.isFinite(value)) return min;
      return value < min ? min : value > max ? max : value;
    }

    function formatClock(milliseconds) {
      const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      return (minutes < 10 ? '0' : '') + minutes + ':' + (seconds < 10 ? '0' : '') + seconds;
    }

    function safeGainValue(parameter) {
      const current = parameter && parameter.value;
      return typeof current === 'number' && Number.isFinite(current) ? current : 0;
    }

    function readStoredSettings() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch (error) {
        return {};
      }
    }

    function writeStoredSettings(settings) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
      } catch (error) {
        // A browser that refuses storage must not break playback.
      }
    }

    // --------------------------------------------------------- noise synthesis

    /** Uniform white noise over [-1, 1]. */
    function fillWhite(out) {
      for (let i = 0; i < out.length; i += 1) out[i] = Math.random() * 2 - 1;
    }

    /** Paul Kellet's economy pink filter: ~ -3 dB/octave with little phase smear. */
    function fillPink(out) {
      let b0 = 0;
      let b1 = 0;
      let b2 = 0;
      let b3 = 0;
      let b4 = 0;
      let b5 = 0;
      let b6 = 0;
      for (let i = 0; i < out.length; i += 1) {
        const white = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.969 * b2 + white * 0.153852;
        b3 = 0.8665 * b3 + white * 0.3104856;
        b4 = 0.55 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.016898;
        out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
        b6 = white * 0.115926;
      }
    }

    /** Leaky integrator: b'[n] = (b'[n-1] + 0.02 * white) / 1.02, ~ -6 dB/octave. */
    function fillBrown(out) {
      let last = 0;
      for (let i = 0; i < out.length; i += 1) {
        const white = Math.random() * 2 - 1;
        last = (last + 0.02 * white) / 1.02;
        out[i] = last * 3.5;
      }
    }

    /**
     * Layered rain: pink bed, one-pole body (distant rumble), a high shimmer
     * layer, and droplets whose density follows a slow swell. All modulators use
     * whole cycles per loop so the seam stays clean.
     */
    function fillRain(out, sampleRate) {
      fillPink(out);
      const bodyAlpha = 1 - Math.exp((-2 * Math.PI * 400) / sampleRate);
      const shimmerAlpha = 1 - Math.exp((-2 * Math.PI * 6200) / sampleRate);
      const swellOmega = 2 * Math.PI * 0.125;
      let body = 0;
      let shimmer = 0;
      for (let i = 0; i < out.length; i += 1) {
        const source = out[i];
        body += bodyAlpha * (source - body);
        shimmer += shimmerAlpha * (source - shimmer);
        const swell = 0.8 + 0.2 * Math.sin(swellOmega * (i / sampleRate) + 0.4);
        out[i] = source * 0.8 + body * 0.24 + shimmer * 0.07 * swell;
      }

      let cursor = Math.floor(sampleRate * 0.05);
      while (cursor < out.length - 1) {
        // Droplet density rises and falls over the loop, like real shower bursts.
        const density = 0.72 + 0.28 * Math.sin(swellOmega * 2 * (cursor / sampleRate) + 1.1);
        const duration = Math.max(2, Math.floor(sampleRate * (0.01 + Math.random() * 0.045)));
        const heavy = Math.random() < 0.02 ? 1.9 : 1;
        const amplitude = (0.06 + Math.random() * 0.22) * density * heavy;
        const decay = heavy > 1 ? 3.5 + Math.random() * 4 : 5 + Math.random() * 7;
        let previous = 0;
        for (let i = 0; i < duration && cursor + i < out.length; i += 1) {
          const progress = i / duration;
          const white = Math.random() * 2 - 1;
          const high = white - previous;
          previous = white;
          out[cursor + i] += high * amplitude * Math.exp(-decay * progress);
        }
        cursor += duration + Math.floor((sampleRate * (0.01 + Math.random() * 0.14)) / Math.max(0.55, density));
      }
    }

    /**
     * Fan: brown noise bed + a slow blade swell, plus low harmonics of the blade
     * rate (55/110/165 Hz, whole cycles per loop) and a breath of air noise.
     */
    function fillFan(out, sampleRate) {
      fillBrown(out);
      const swell = 2 * Math.PI * 0.25;
      const drift = 2 * Math.PI * 0.125;
      const hum1 = 2 * Math.PI * 55;
      const hum2 = 2 * Math.PI * 110;
      const hum3 = 2 * Math.PI * 165;
      for (let i = 0; i < out.length; i += 1) {
        const t = i / sampleRate;
        const wobble = 0.5 + 0.5 * Math.sin(drift * t + 0.3);
        const hum =
          Math.sin(hum1 * t + wobble * 0.4) * 0.018 + Math.sin(hum2 * t) * 0.011 + Math.sin(hum3 * t) * 0.005;
        out[i] = out[i] * (1 + 0.16 * Math.sin(swell * t + 0.7)) + hum * (0.6 + 0.4 * wobble);
        out[i] += (Math.random() * 2 - 1) * 0.012;
      }
    }

    /**
     * Normalise to a target RMS. Buffers may briefly exceed 1.0 on the tallest
     * crests; the per-preset trim and the output limiter keep that safe, and the
     * exact RMS keeps the loudness calibration independent of random peaks.
     */
    function normalizeRms(samples, targetRms) {
      let sum = 0;
      for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
      const rms = Math.sqrt(sum / samples.length) || 1;
      const scale = targetRms / rms;
      for (let i = 0; i < samples.length; i += 1) samples[i] *= scale;
    }

    /** Rain and fan are rendered as decorrelated stereo; the noise colours stay mono. */
    const STEREO_SOUNDS = { rain: true, fan: true };

    function renderNoiseChannel(id, length, fadeLength, sampleRate) {
      const raw = new Float32Array(length + fadeLength);
      if (id === 'white') fillWhite(raw);
      else if (id === 'brown') fillBrown(raw);
      else if (id === 'rain') fillRain(raw, sampleRate);
      else if (id === 'fan') fillFan(raw, sampleRate);
      else fillPink(raw);

      // Equal-power wrap of the tail into the head keeps the loop point
      // continuous; a raw noise buffer that ends mid-wave clicks once per loop.
      const output = new Float32Array(length);
      output.set(raw.subarray(0, length));
      for (let i = 0; i < fadeLength; i += 1) {
        const position = i / fadeLength;
        const head = Math.sin((position * Math.PI) / 2);
        const tail = Math.cos((position * Math.PI) / 2);
        output[i] = raw[i] * head + raw[length + i] * tail;
      }
      return output;
    }

    function buildNoiseBuffer(audioContext, id) {
      const sampleRate = audioContext.sampleRate;
      const length = Math.floor(sampleRate * LOOP_SECONDS);
      const fadeLength = Math.max(1, Math.floor(sampleRate * LOOP_FADE_SECONDS));
      const channels = STEREO_SOUNDS[id] ? 2 : 1;
      const rendered = [];
      for (let channel = 0; channel < channels; channel += 1) {
        rendered.push(renderNoiseChannel(id, length, fadeLength, sampleRate));
      }

      // Joint normalisation keeps the stereo image intact instead of flattening
      // each channel to its own loudness.
      let sum = 0;
      let count = 0;
      for (const data of rendered) {
        for (let i = 0; i < data.length; i += 1) {
          sum += data[i] * data[i];
          count += 1;
        }
      }
      const rms = Math.sqrt(sum / Math.max(1, count)) || 1;
      const scale = TARGET_RMS / rms;

      const buffer = audioContext.createBuffer(channels, length, sampleRate);
      for (let channel = 0; channel < channels; channel += 1) {
        const data = rendered[channel];
        for (let i = 0; i < data.length; i += 1) data[i] *= scale;
        buffer.copyToChannel(data, channel);
      }
      return buffer;
    }

    /**
     * The Host half can inject defaults into the page index from the plugin row's
     * `config`; localStorage (the user's own choices) always wins over them.
     */
    function readHostDefaults() {
      try {
        const raw = window.__ADHD_NOISE_DEFAULTS__;
        return raw && typeof raw === 'object' ? raw : {};
      } catch (error) {
        return {};
      }
    }

    // ----------------------------------------------------------------- engine

    function createEngine() {
      const hostDefaults = readHostDefaults();
      const stored = readStoredSettings();
      let sound =
        SOUND_IDS.indexOf(stored.sound) >= 0
          ? stored.sound
          : SOUND_IDS.indexOf(hostDefaults.sound) >= 0
            ? hostDefaults.sound
            : 'pink';
      let volume = clamp(
        typeof stored.volume === 'number'
          ? stored.volume
          : typeof hostDefaults.volume === 'number'
            ? hostDefaults.volume
            : 0.3,
        0,
        1,
      );
      let timerMinutes =
        TIMER_OPTIONS.indexOf(stored.timerMinutes) >= 0
          ? stored.timerMinutes
          : TIMER_OPTIONS.indexOf(hostDefaults.timerMinutes) >= 0
            ? hostDefaults.timerMinutes
            : 25;
      let status = 'idle';
      let ended = false;
      let blocked = false;
      let audioContext = null;
      let master = null;
      let analyser = null;
      let graph = null;
      const buffers = new Map();
      const listeners = new Set();
      let snapshot = null;
      let pendingTeardown = null;
      let tick = null;
      let endsAt = 0;
      let disposed = false;

      function computeSnapshot() {
        return {
          status,
          sound,
          volume,
          timerMinutes,
          remainingMs: status === 'playing' && endsAt > 0 ? Math.max(0, endsAt - Date.now()) : 0,
          ended,
          blocked,
        };
      }

      function publish() {
        const next = computeSnapshot();
        const previous = snapshot;
        snapshot = next;
        if (
          previous &&
          previous.status === next.status &&
          previous.sound === next.sound &&
          previous.volume === next.volume &&
          previous.timerMinutes === next.timerMinutes &&
          previous.ended === next.ended &&
          previous.blocked === next.blocked &&
          Math.ceil(previous.remainingMs / 1000) === Math.ceil(next.remainingMs / 1000)
        ) {
          return;
        }
        for (const listener of listeners) {
          try {
            listener();
          } catch (error) {
            // A broken subscriber must not stop the player.
          }
        }
      }

      function getSnapshot() {
        if (!snapshot) snapshot = computeSnapshot();
        return snapshot;
      }

      function subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      }

      function persist() {
        writeStoredSettings({ sound, volume, timerMinutes });
      }

      function masterTarget() {
        return Math.pow(volume, VOLUME_EXPONENT) * MAX_MASTER_GAIN;
      }

      function ensureContext() {
        if (audioContext) return true;
        const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextCtor) {
          status = 'unsupported';
          publish();
          return false;
        }
        try {
          audioContext = new AudioContextCtor({ latencyHint: 'playback' });
        } catch (error) {
          audioContext = null;
          status = 'unsupported';
          publish();
          return false;
        }
        master = audioContext.createGain();
        master.gain.value = masterTarget();
        try {
          // The analyser feeds the visualiser with the real output signal.
          analyser = audioContext.createAnalyser();
          analyser.fftSize = 1024;
          analyser.smoothingTimeConstant = 0.8;
        } catch (error) {
          analyser = null;
        }
        const tap = (node) => {
          if (analyser) {
            node.connect(analyser);
            analyser.connect(audioContext.destination);
          } else {
            node.connect(audioContext.destination);
          }
        };
        try {
          // Peak guard only: the presets sit well below the threshold at normal
          // volume, so the limiter stays inactive and never colours the noise.
          const limiter = audioContext.createDynamicsCompressor();
          limiter.threshold.value = -3;
          limiter.knee.value = 3;
          limiter.ratio.value = 20;
          limiter.attack.value = 0.003;
          limiter.release.value = 0.25;
          master.connect(limiter);
          tap(limiter);
        } catch (error) {
          tap(master);
        }
        return true;
      }

      function getAnalyser() {
        return analyser;
      }

      function readWaveform(out) {
        if (!analyser || !out || typeof analyser.getFloatTimeDomainData !== 'function') return false;
        try {
          analyser.getFloatTimeDomainData(out);
          return true;
        } catch (error) {
          return false;
        }
      }

      function bufferFor(id) {
        if (!audioContext) return null;
        const cached = buffers.get(id);
        if (cached) return cached;
        const buffer = buildNoiseBuffer(audioContext, id);
        buffers.set(id, buffer);
        return buffer;
      }

      function setMasterGain(target, seconds) {
        if (!audioContext || !master) return;
        const now = audioContext.currentTime;
        master.gain.cancelScheduledValues(now);
        master.gain.setValueAtTime(safeGainValue(master.gain), now);
        master.gain.linearRampToValueAtTime(target, now + seconds);
      }

      function disposeGraph(target) {
        if (!target) return;
        try {
          target.source.stop();
        } catch (error) {
          // Already stopped.
        }
        try {
          target.source.disconnect();
        } catch (error) {
          // Already detached.
        }
        for (const filter of target.filters) {
          try {
            filter.disconnect();
          } catch (error) {
            // Already detached.
          }
        }
        try {
          target.trim.disconnect();
          target.fade.disconnect();
        } catch (error) {
          // Already detached.
        }
      }

      function teardownGraph() {
        const current = graph;
        graph = null;
        disposeGraph(current);
      }

      function startGraph(id, fadeInSeconds) {
        const buffer = bufferFor(id);
        if (!buffer || !audioContext || !master) return null;
        const preset = SOUND_PRESETS[id] || SOUND_PRESETS.white;
        const now = audioContext.currentTime;
        const source = audioContext.createBufferSource();
        source.buffer = buffer;
        source.loop = true;

        let node = source;
        const filters = [];
        for (const setting of preset.chain) {
          const filter = audioContext.createBiquadFilter();
          filter.type = setting.type;
          filter.frequency.value = setting.frequency;
          filter.Q.value = typeof setting.q === 'number' ? setting.q : 1;
          if (typeof setting.gain === 'number') filter.gain.value = setting.gain;
          node.connect(filter);
          node = filter;
          filters.push(filter);
        }

        const trim = audioContext.createGain();
        trim.gain.value = preset.trim;
        const fade = audioContext.createGain();
        fade.gain.value = 0;
        node.connect(trim);
        trim.connect(fade);
        fade.connect(master);

        source.start(now);
        fade.gain.setValueAtTime(0, now);
        fade.gain.linearRampToValueAtTime(1, now + fadeInSeconds);

        graph = { source, filters, trim, fade };
        return graph;
      }

      function cancelTeardown() {
        if (pendingTeardown !== null) {
          clearTimeout(pendingTeardown);
          pendingTeardown = null;
        }
      }

      function scheduleTeardown(seconds) {
        cancelTeardown();
        pendingTeardown = window.setTimeout(() => {
          pendingTeardown = null;
          teardownGraph();
          // Suspend while silent: a running AudioContext costs CPU and battery.
          if (audioContext && audioContext.state === 'running' && typeof audioContext.suspend === 'function') {
            audioContext.suspend().catch(() => {});
          }
        }, Math.max(0, seconds * 1000));
      }

      function stopTick() {
        if (tick !== null) {
          clearInterval(tick);
          tick = null;
        }
      }

      function startTick() {
        stopTick();
        if (status !== 'playing' || timerMinutes <= 0) return;
        tick = window.setInterval(() => {
          if (disposed) {
            stopTick();
            return;
          }
          if (endsAt > 0 && Date.now() >= endsAt) {
            stopTick();
            endsAt = 0;
            ended = true;
            pause(TIMER_FADE_OUT_SECONDS);
            return;
          }
          publish();
        }, 400);
      }

      function reportBlocked() {
        blocked = true;
        status = 'idle';
        stopTick();
        endsAt = 0;
        teardownGraph();
        publish();
      }

      /**
       * Web Audio may keep the context suspended until the browser accepts the
       * gesture. Watch the state briefly and surface a retry instead of showing
       * "playing" for a silent context.
       */
      function watchResume() {
        if (!audioContext || audioContext.state !== 'suspended') return;
        try {
          const result = audioContext.resume();
          if (result && typeof result.then === 'function') {
            result.then(onResumeChecked).catch(() => {
              if (!disposed) reportBlocked();
            });
          }
        } catch (error) {
          // Best effort: a still-suspended context stays silent.
        }
        window.setTimeout(onResumeChecked, 400);
      }

      function onResumeChecked() {
        if (disposed || !audioContext) return;
        if (audioContext.state !== 'running' && status === 'playing') reportBlocked();
      }

      function play() {
        if (disposed) return;
        if (!ensureContext()) return;
        blocked = false;
        if (audioContext.state === 'suspended') watchResume();
        ended = false;
        if (status === 'playing') {
          publish();
          return;
        }
        if (graph) {
          // Resuming inside the fade-out window: bring the existing graph back.
          cancelTeardown();
          const now = audioContext.currentTime;
          graph.fade.gain.cancelScheduledValues(now);
          graph.fade.gain.setValueAtTime(safeGainValue(graph.fade.gain), now);
          graph.fade.gain.linearRampToValueAtTime(1, now + 0.5);
        } else {
          startGraph(sound, FADE_IN_SECONDS);
        }
        if (master) setMasterGain(masterTarget(), 0.3);
        status = 'playing';
        if (timerMinutes > 0) {
          endsAt = Date.now() + timerMinutes * 60000;
          startTick();
        } else {
          endsAt = 0;
        }
        publish();
      }

      function pause(fadeSeconds) {
        blocked = false;
        if (status !== 'playing') {
          publish();
          return;
        }
        const fade = typeof fadeSeconds === 'number' && fadeSeconds > 0 ? fadeSeconds : FADE_OUT_SECONDS;
        stopTick();
        endsAt = 0;
        status = 'idle';
        if (audioContext && graph) {
          const now = audioContext.currentTime;
          graph.fade.gain.cancelScheduledValues(now);
          graph.fade.gain.setValueAtTime(safeGainValue(graph.fade.gain), now);
          graph.fade.gain.linearRampToValueAtTime(0, now + fade);
          scheduleTeardown(fade + 0.3);
        } else {
          teardownGraph();
        }
        publish();
      }

      function toggle() {
        if (status === 'playing') pause();
        else play();
      }

      function setSound(id) {
        if (SOUND_IDS.indexOf(id) < 0 || id === sound) return;
        sound = id;
        persist();
        if (status === 'playing' && audioContext && graph) {
          const previous = graph;
          graph = null;
          startGraph(id, CROSSFADE_SECONDS);
          const now = audioContext.currentTime;
          previous.fade.gain.cancelScheduledValues(now);
          previous.fade.gain.setValueAtTime(safeGainValue(previous.fade.gain), now);
          previous.fade.gain.linearRampToValueAtTime(0, now + CROSSFADE_SECONDS);
          window.setTimeout(() => disposeGraph(previous), CROSSFADE_SECONDS * 1000 + 150);
        }
        publish();
      }

      function setVolume(value) {
        const next = clamp(Number(value), 0, 1);
        if (next === volume) return;
        volume = next;
        persist();
        if (status === 'playing') setMasterGain(masterTarget(), 0.12);
        publish();
      }

      function setTimer(minutes) {
        const next = TIMER_OPTIONS.indexOf(minutes) >= 0 ? minutes : 0;
        timerMinutes = next;
        ended = false;
        persist();
        if (status === 'playing') {
          endsAt = next > 0 ? Date.now() + next * 60000 : 0;
          startTick();
        }
        publish();
      }

      function dispose() {
        disposed = true;
        stopTick();
        cancelTeardown();
        teardownGraph();
        buffers.clear();
        listeners.clear();
        if (audioContext) {
          try {
            audioContext.close();
          } catch (error) {
            // Already closed.
          }
          audioContext = null;
          master = null;
          analyser = null;
        }
        status = 'idle';
      }

      return {
        getSnapshot,
        subscribe,
        play,
        pause,
        toggle,
        setSound,
        setVolume,
        setTimer,
        getAnalyser,
        readWaveform,
        dispose,
      };
    }

    // -------------------------------------------------------------- rendering

    const STYLES = `
.adn-root { display:inline-flex; align-items:center; min-width:0; font-size:12px; line-height:1.4; color:var(--dsw-alias-label-secondary); }
.adn-pill { display:inline-flex; align-items:center; gap:4px; min-width:0; }
.adn-pillbtn { display:inline-flex; align-items:center; gap:6px; height:24px; padding:0 7px; border:1px solid transparent; border-radius:999px; background:transparent; color:inherit; font:inherit; cursor:pointer; white-space:nowrap; transition:background .16s ease, border-color .16s ease, color .16s ease, transform .16s cubic-bezier(.2,.8,.3,1); }
.adn-pillbtn:hover { color:var(--dsw-alias-label-primary); }
.adn-root[data-tone="light"] .adn-pillbtn:hover { background:rgba(255,255,255,.62); border-color:rgba(255,255,255,.9); box-shadow:inset 0 1px 0 rgba(255,255,255,.95); }
.adn-root[data-tone="dark"] .adn-pillbtn:hover { background:rgba(255,255,255,.1); border-color:rgba(255,255,255,.16); box-shadow:inset 0 1px 0 rgba(255,255,255,.22); }
.adn-pillbtn:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px; }
.adn-pillbtn[data-on="true"] { color:var(--dsw-alias-label-primary); }
.adn-pillbtn[disabled] { opacity:.45; cursor:default; }
.adn-play { width:24px; padding:0; justify-content:center; }
.adn-toggle { min-width:0; max-width:230px; }
.adn-label { overflow:hidden; text-overflow:ellipsis; color:var(--dsw-alias-label-secondary); }
.adn-pill[data-playing="true"] .adn-label { color:var(--dsw-alias-label-primary); }
.adn-orbdot { display:block; flex:0 0 auto; width:20px; height:20px; }
.adn-clock { flex:0 0 auto; font-variant-numeric:tabular-nums; font-size:11px; color:var(--dsw-alias-label-secondary); }
.adn-chevron { color:var(--dsw-alias-label-secondary); transition:transform .18s ease; }
.adn-chevron[data-open="false"] { transform:rotate(180deg); }
.adn-probe { width:100%; height:0; }
.adn-overlay { display:flex; justify-content:flex-end; pointer-events:auto; z-index:30; }
.adn-panel { position:relative; display:flex; flex-direction:column; gap:18px; width:100%; max-height:100%; padding:20px 20px 18px; border-radius:24px; overflow:hidden auto; color:var(--dsw-alias-label-primary); background:radial-gradient(120% 56% at 50% 0%, var(--adn-tint, transparent), transparent 70%), linear-gradient(158deg, rgba(255,255,255,.3), rgba(255,255,255,.07) 46%, rgba(255,255,255,.02)); border:1px solid rgba(255,255,255,.3); box-shadow:0 28px 60px -24px rgba(8,12,24,.45), inset 0 1px 0 rgba(255,255,255,.62), inset 0 -1px 0 rgba(255,255,255,.1); -webkit-backdrop-filter:blur(30px) saturate(180%); backdrop-filter:blur(30px) saturate(180%); animation:adn-glass-in .22s cubic-bezier(.2,.8,.3,1); }
.adn-panel::before { content:''; position:absolute; inset:0; border-radius:inherit; padding:1px; background:conic-gradient(from 200deg, rgba(255,255,255,.8), rgba(255,255,255,.08) 28%, rgba(255,255,255,.03) 52%, rgba(255,255,255,.55) 78%, rgba(255,255,255,.8)); -webkit-mask:linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); mask:linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite:xor; mask-composite:exclude; pointer-events:none; opacity:.9; }
.adn-panel.adn-refract { -webkit-backdrop-filter:blur(7px) saturate(180%); backdrop-filter:blur(7px) saturate(180%) url(#adn-noise-refraction); }
.adn-refraction { position:absolute; width:0; height:0; overflow:hidden; pointer-events:none; }
.adn-panel::after { content:''; position:absolute; inset:0; border-radius:inherit; background:radial-gradient(260px circle at var(--adn-mx, 34%) var(--adn-my, 0%), rgba(255,255,255,.24), transparent 62%); pointer-events:none; mix-blend-mode:screen; }
.adn-overlay[data-tone="dark"] .adn-panel { background:radial-gradient(120% 56% at 50% 0%, var(--adn-tint, transparent), transparent 70%), linear-gradient(158deg, rgba(255,255,255,.1), rgba(255,255,255,.03) 46%, rgba(255,255,255,.015)); border-color:rgba(255,255,255,.16); box-shadow:0 28px 60px -24px rgba(0,0,0,.68), inset 0 1px 0 rgba(255,255,255,.26), inset 0 -1px 0 rgba(255,255,255,.05); }
.adn-overlay[data-tone="light"] .adn-panel { border-color:rgba(255,255,255,.7); box-shadow:0 28px 60px -24px rgba(15,20,30,.26), inset 0 1px 0 rgba(255,255,255,.95), inset 0 -1px 0 rgba(0,0,0,.05); }
@keyframes adn-glass-in { from { opacity:0; transform:translateY(8px) scale(.985); } to { opacity:1; transform:none; } }
.adn-hero { display:flex; align-items:center; gap:14px; padding-right:24px; }
.adn-orb { display:block; flex:0 0 auto; width:132px; height:132px; margin-left:-10px; filter:drop-shadow(0 14px 22px rgba(0,0,0,.18)); }
.adn-herotext { display:flex; flex-direction:column; gap:12px; min-width:0; }
.adn-eyebrow { font-size:9px; letter-spacing:.24em; text-transform:uppercase; color:var(--dsw-alias-label-secondary); }
.adn-display { margin:0; font-family:ui-serif, "Iowan Old Style", "Palatino Linotype", "Songti SC", "Noto Serif SC", serif; font-size:20px; font-weight:600; letter-spacing:.08em; line-height:1.15; color:var(--dsw-alias-label-primary); }
.adn-now { display:flex; align-items:center; gap:8px; min-width:0; }
/* The sound name is the title now; no secondary text line under it. */
.adn-playbtn { display:inline-flex; flex:0 0 auto; align-items:center; justify-content:center; width:28px; height:28px; padding:0; border-radius:50%; background:rgba(255,255,255,.12); border:1px solid rgba(255,255,255,.26); box-shadow:inset 0 1px 0 rgba(255,255,255,.4); -webkit-backdrop-filter:blur(10px); backdrop-filter:blur(10px); color:var(--dsw-alias-label-primary); cursor:pointer; transition:transform .16s cubic-bezier(.2,.8,.3,1), background .16s ease, border-color .16s ease; }
.adn-playbtn:hover { border-color:rgba(255,255,255,.45); background:rgba(255,255,255,.2); }
.adn-playbtn:active { transform:scale(.94); }
.adn-playbtn:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px; }
.adn-playbtn[disabled] { opacity:.45; cursor:default; }
.adn-overlay[data-tone="light"] .adn-playbtn { background:rgba(255,255,255,.55); border-color:rgba(255,255,255,.85); box-shadow:inset 0 1px 0 rgba(255,255,255,.95); }
.adn-close { position:absolute; top:12px; right:12px; display:inline-flex; align-items:center; justify-content:center; width:24px; height:24px; padding:0; border-radius:50%; background:rgba(255,255,255,.1); border:1px solid rgba(255,255,255,.2); box-shadow:inset 0 1px 0 rgba(255,255,255,.35); -webkit-backdrop-filter:blur(10px); backdrop-filter:blur(10px); color:var(--dsw-alias-label-secondary); cursor:pointer; transition:transform .16s cubic-bezier(.2,.8,.3,1), background .16s ease, color .16s ease; }
.adn-close:hover { color:var(--dsw-alias-label-primary); background:rgba(255,255,255,.2); }
.adn-close:active { transform:scale(.92); }
.adn-close:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px; }
.adn-overlay:focus { outline:none; }
.adn-sr { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; border:0; }
.adn-overlay[data-tone="light"] .adn-close { background:rgba(255,255,255,.5); border-color:rgba(255,255,255,.85); box-shadow:inset 0 1px 0 rgba(255,255,255,.95); }
.adn-sounds { display:flex; align-items:flex-start; justify-content:space-between; gap:2px; }
.adn-sound { display:flex; flex-direction:column; align-items:center; gap:7px; padding:0; border:none; background:transparent; font:inherit; cursor:pointer; }
.adn-sounddot { display:block; width:46px; height:46px; border-radius:50%; box-shadow:inset 0 1px 1px rgba(255,255,255,.9), inset 0 -4px 10px rgba(255,255,255,.16), 0 10px 20px -10px rgba(0,0,0,.4); transition:transform .2s cubic-bezier(.2,.8,.3,1), box-shadow .2s ease; }
.adn-sound[data-active="true"] .adn-sounddot { transform:scale(1.1); box-shadow:inset 0 1px 1px rgba(255,255,255,.95), inset 0 -5px 12px rgba(255,255,255,.2), 0 12px 26px -8px rgba(0,0,0,.35); }
.adn-sound:active .adn-sounddot { transform:scale(.95); }
.adn-soundlabel { font-size:10.5px; color:var(--dsw-alias-label-secondary); white-space:nowrap; }
.adn-sound[data-active="true"] .adn-soundlabel { color:var(--dsw-alias-label-primary); }
.adn-sound:focus-visible { outline:none; }
.adn-sound:focus-visible .adn-sounddot { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:3px; }
.adn-volume { display:flex; align-items:center; gap:10px; }
.adn-volicon { display:flex; flex:0 0 auto; color:var(--dsw-alias-label-secondary); }
.adn-range { flex:1 1 auto; min-width:0; height:14px; margin:0; -webkit-appearance:none; appearance:none; background:transparent; cursor:pointer; }
.adn-range:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px; border-radius:999px; }
.adn-range::-webkit-slider-runnable-track { height:2px; border-radius:999px; background:linear-gradient(to right, var(--dsw-alias-label-secondary) var(--adn-fill,0%), var(--dsw-alias-border-l2) var(--adn-fill,0%)); }
.adn-range::-webkit-slider-thumb { -webkit-appearance:none; appearance:none; width:11px; height:11px; margin-top:-4.5px; border-radius:50%; background:rgba(255,255,255,.92); border:1px solid rgba(255,255,255,.7); box-shadow:0 1px 3px rgba(0,0,0,.28), inset 0 1px 0 rgba(255,255,255,.95); }
.adn-range::-moz-range-track { height:2px; border-radius:999px; background:var(--dsw-alias-border-l2); }
.adn-range::-moz-range-progress { height:2px; border-radius:999px; background:var(--dsw-alias-label-secondary); }
.adn-range::-moz-range-thumb { width:11px; height:11px; border-radius:50%; background:rgba(255,255,255,.92); border:1px solid rgba(255,255,255,.7); }
.adn-value { flex:0 0 auto; min-width:2.6em; text-align:right; font-size:11px; font-variant-numeric:tabular-nums; color:var(--dsw-alias-label-secondary); }
.adn-times { display:flex; align-items:center; gap:2px; flex-wrap:wrap; }
.adn-times .adn-eyebrow { margin-right:6px; }
.adn-time { padding:3px 9px; border:1px solid transparent; border-radius:8px; background:transparent; color:var(--dsw-alias-label-secondary); font:inherit; font-size:11px; cursor:pointer; transition:background .16s ease, border-color .16s ease, color .16s ease, transform .16s cubic-bezier(.2,.8,.3,1), box-shadow .16s ease; }
.adn-time:hover { color:var(--dsw-alias-label-primary); }
.adn-time:active { transform:scale(.96); }
.adn-time[aria-pressed="true"] { color:var(--dsw-alias-label-primary); background:rgba(255,255,255,.18); border-color:rgba(255,255,255,.28); box-shadow:inset 0 1px 0 rgba(255,255,255,.45); -webkit-backdrop-filter:blur(8px); backdrop-filter:blur(8px); }
.adn-overlay[data-tone="light"] .adn-time[aria-pressed="true"] { background:rgba(255,255,255,.56); border-color:rgba(255,255,255,.9); }
.adn-time:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:1px; }
.adn-hint { margin:0; font-size:10.5px; line-height:1.6; color:var(--dsw-alias-label-secondary); }
.adn-note { margin:0; font-size:10.5px; line-height:1.6; color:var(--dsw-alias-state-warn-primary); }
@media (prefers-reduced-motion: reduce) {
  .adn-panel { animation:none; }
  .adn-playbtn, .adn-close, .adn-time, .adn-sounddot, .adn-pillbtn { transition:none; }
  .adn-playbtn:active, .adn-close:active, .adn-time:active, .adn-sound:active .adn-sounddot { transform:none; }
}
@media (prefers-reduced-transparency: reduce) {
  .adn-panel { background:var(--dsw-alias-bg-overlay); -webkit-backdrop-filter:none !important; backdrop-filter:none !important; }
  .adn-panel::before, .adn-panel::after { display:none; }
  .adn-playbtn, .adn-close, .adn-time[aria-pressed="true"] { -webkit-backdrop-filter:none; backdrop-filter:none; background:var(--dsw-alias-bg-layer-2); }
}
@media (forced-colors: active) {
  .adn-panel { background:Canvas; border:1px solid CanvasText; }
  .adn-panel::before, .adn-panel::after { display:none; }
  .adn-playbtn, .adn-close, .adn-time, .adn-time[aria-pressed="true"] { border:1px solid CanvasText; }
  .adn-sounddot { border:1px solid CanvasText; }
  .adn-sound[data-active="true"] .adn-soundlabel { font-weight:600; }
}
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .adn-panel { background:var(--dsw-alias-bg-overlay); }
  .adn-panel::before { display:none; }
}
`;

    // One client module instance per page, so one stable id avoids duplicates.
    const PANEL_ID = 'adn-noise-' + Math.random().toString(36).slice(2, 8);

    // ------------------------------------------------------------- sound orbs

    /** Pastel artwork palette per sound (independent of the UI theme tokens). */
    const SOUND_TINTS = {
      brown: { main: [206, 168, 112], glow: [243, 226, 197] },
      pink: { main: [238, 158, 172], glow: [252, 219, 224] },
      white: { main: [176, 194, 214], glow: [230, 238, 247] },
      rain: { main: [134, 174, 222], glow: [206, 226, 246] },
      fan: { main: [142, 198, 182], glow: [210, 236, 228] },
    };

    function tint(rgb, alpha) {
      return 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + alpha + ')';
    }

    /** Parse a computed token value such as '#10151c' or 'rgb(16, 21, 28)'. */
    function parseRgbString(value) {
      if (!value) return null;
      const text = String(value).trim();
      if (text.charAt(0) === '#') {
        const hex = text.slice(1);
        if (hex.length === 3) {
          return [
            parseInt(hex.charAt(0) + hex.charAt(0), 16),
            parseInt(hex.charAt(1) + hex.charAt(1), 16),
            parseInt(hex.charAt(2) + hex.charAt(2), 16),
          ];
        }
        if (hex.length === 6) {
          return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
        }
        return null;
      }
      const match = text.match(/rgba?\(([^)]+)\)/i);
      if (match) {
        const parts = match[1].split(',').map((part) => Number(part.trim()));
        if (parts.length >= 3 && parts.slice(0, 3).every((part) => Number.isFinite(part))) return parts.slice(0, 3);
      }
      return null;
    }

    /**
     * Glass tint follows the host theme: the panel's border, specular and shadow
     * alphas are tuned for a light or a dark backdrop. Reading the base token
     * keeps this working with custom themes instead of relying on a fixed mode.
     */
    function applyGlassTone(element) {
      if (!element || !window.getComputedStyle) return;
      let value = '';
      try {
        value = window.getComputedStyle(element).getPropertyValue('--dsw-alias-bg-base').trim();
      } catch (error) {
        value = '';
      }
      const rgb = parseRgbString(value);
      const luminance = rgb ? (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255 : 0.4;
      element.dataset.tone = luminance > 0.55 ? 'light' : 'dark';
    }

    function useGlassTone(ref, active) {
      React.useEffect(() => {
        if (!active) return undefined;
        const apply = () => applyGlassTone(ref.current);
        apply();
        let observer = null;
        try {
          observer = new MutationObserver(apply);
          observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['class', 'style', 'data-theme', 'data-mode'],
          });
        } catch (error) {
          observer = null;
        }
        return () => {
          if (observer) observer.disconnect();
        };
      }, [ref, active]);
    }

    /** Quadratic midpoint smoothing, so the sampled signal reads as a curve. */
    function smoothCurve(context, points) {
      if (!points.length) return;
      context.beginPath();
      context.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length - 1; i += 1) {
        const current = points[i];
        const next = points[i + 1];
        context.quadraticCurveTo(current.x, current.y, (current.x + next.x) / 2, (current.y + next.y) / 2);
      }
      const last = points[points.length - 1];
      context.lineTo(last.x, last.y);
    }

    /**
     * The sound orb: a soft radial gradient sphere that breathes with the live
     * audio level, with the real time-domain signal drawn as a horizon line
     * inside it. Two sizes share one implementation (panel orb and pill dot).
     */
    function installOrb(canvas, engine, variant) {
      const context = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
      if (!context) return () => {};
      const dot = variant === 'dot';
      const reducedMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      const samples = new Float32Array(1024);
      const fallbackSize = dot ? 20 : 132;
      let width = fallbackSize;
      let height = fallbackSize;
      let running = true;
      let frameId = null;
      let drift = 0;
      let energy = 0;
      let lastFrame = -1000;
      let surface = null;
      let observer = null;

      function measure() {
        let nextWidth = width;
        let nextHeight = height;
        try {
          const rect = typeof canvas.getBoundingClientRect === 'function' ? canvas.getBoundingClientRect() : null;
          if (rect && rect.width > 0 && rect.height > 0) {
            nextWidth = Math.round(rect.width);
            nextHeight = Math.round(rect.height);
          }
        } catch (error) {
          // Keep the previous geometry.
        }
        if (nextWidth <= 1 || nextHeight <= 1) {
          nextWidth = fallbackSize;
          nextHeight = fallbackSize;
        }
        if (nextWidth === width && nextHeight === height && canvas.width > 1) return false;
        width = Math.max(1, nextWidth);
        height = Math.max(1, nextHeight);
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.max(1, Math.round(width * dpr));
        canvas.height = Math.max(1, Math.round(height * dpr));
        if (typeof context.setTransform === 'function') context.setTransform(dpr, 0, 0, dpr, 0, 0);
        return true;
      }

      function readAudio() {
        let ok = false;
        try {
          if (engine && typeof engine.readWaveform === 'function') ok = engine.readWaveform(samples);
        } catch (error) {
          ok = false;
        }
        if (!ok) samples.fill(0);
        let sum = 0;
        for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
        const level = Math.min(1, Math.sqrt(sum / samples.length) * 8);
        energy += (level - energy) * 0.12;
      }

      function horizonPoints(radius, cx, cy) {
        const count = dot ? 12 : 64;
        const averages = [];
        const step = Math.max(1, Math.floor(samples.length / count));
        for (let i = 0; i < count; i += 1) {
          let sum = 0;
          let used = 0;
          for (let j = 0; j < step; j += 1) {
            const index = i * step + j;
            if (index < samples.length) {
              sum += samples[index];
              used += 1;
            }
          }
          averages.push(used ? sum / used : 0);
        }
        if (!surface || surface.length !== averages.length) surface = new Float32Array(averages.length);
        let peak = 0;
        for (let i = 0; i < averages.length; i += 1) {
          surface[i] += (averages[i] - surface[i]) * 0.16;
          const magnitude = surface[i] < 0 ? -surface[i] : surface[i];
          if (magnitude > peak) peak = magnitude;
        }
        const gain = peak > 0.0005 ? 1 / peak : 0;
        const amplitude = radius * (0.1 + energy * 0.16);
        const baseY = cy + radius * 0.26;
        const points = [];
        for (let i = 0; i < count; i += 1) {
          const nx = i / (count - 1);
          points.push({
            x: cx - radius + nx * radius * 2,
            y: baseY + surface[i] * gain * amplitude + Math.sin(nx * 5.6 + drift * 0.8) * radius * 0.02,
          });
        }
        return { points, baseY, amplitude };
      }

      function draw(timestamp) {
        if (!width || !height) return;
        drift = (typeof timestamp === 'number' ? timestamp : 0) / 1000;
        readAudio();
        const snapshot = engine && typeof engine.getSnapshot === 'function' ? engine.getSnapshot() : null;
        const pair = SOUND_TINTS[snapshot && snapshot.sound] || SOUND_TINTS.pink;
        const size = Math.min(width, height);
        const cx = width / 2;
        const cy = height / 2;
        const breathe = 1 + energy * 0.05 + Math.sin(drift * 0.8) * 0.012;
        context.clearRect(0, 0, width, height);

        if (!dot) {
          // Wide soft halo, the "glow in the air" of the reference design.
          const halo = context.createRadialGradient(cx, cy, size * 0.08, cx, cy, size * 0.5);
          halo.addColorStop(0, tint(pair.glow, 0.34));
          halo.addColorStop(0.55, tint(pair.main, 0.12));
          halo.addColorStop(1, tint(pair.main, 0));
          context.fillStyle = halo;
          context.fillRect(0, 0, width, height);
        }

        const radius = size * (dot ? 0.44 : 0.34) * breathe;
        const orb = context.createRadialGradient(
          cx - radius * 0.3,
          cy - radius * 0.36,
          radius * 0.06,
          cx,
          cy,
          radius * 1.02,
        );
        orb.addColorStop(0, tint(pair.glow, 0.98));
        orb.addColorStop(0.42, tint(pair.main, 0.6));
        orb.addColorStop(0.8, tint(pair.main, 0.28));
        orb.addColorStop(1, tint(pair.main, 0));
        context.fillStyle = orb;
        context.beginPath();
        context.arc(cx, cy, radius, 0, Math.PI * 2);
        context.fill();

        if (!dot) {
          const horizon = horizonPoints(radius, cx, cy);
          context.save();
          context.beginPath();
          context.arc(cx, cy, radius * 0.96, 0, Math.PI * 2);
          context.clip();
          smoothCurve(context, horizon.points);
          context.lineWidth = 1.2;
          context.lineJoin = 'round';
          context.strokeStyle = tint(pair.glow, 0.85);
          context.stroke();
          const tipY = horizon.baseY + horizon.amplitude * 1.6;
          context.lineTo(cx + radius, tipY);
          context.lineTo(cx - radius, tipY);
          context.closePath();
          const wash = context.createLinearGradient(0, horizon.baseY - horizon.amplitude, 0, tipY);
          wash.addColorStop(0, tint(pair.glow, 0.28));
          wash.addColorStop(1, tint(pair.glow, 0));
          context.fillStyle = wash;
          context.fill();
          context.restore();

          // Specular rim: brighter at the top-left, like light caught in glass.
          const rim = context.createLinearGradient(cx - radius, cy - radius, cx + radius, cy + radius);
          rim.addColorStop(0, 'rgba(255,255,255,0.9)');
          rim.addColorStop(0.32, 'rgba(255,255,255,0.16)');
          rim.addColorStop(0.66, 'rgba(255,255,255,0)');
          rim.addColorStop(1, 'rgba(255,255,255,0.32)');
          context.beginPath();
          context.arc(cx, cy, radius * 1.005, 0, Math.PI * 2);
          context.lineWidth = 1.1;
          context.strokeStyle = rim;
          context.stroke();

          // Soft sheen inside the upper-left of the orb.
          context.save();
          context.beginPath();
          if (typeof context.ellipse === 'function') {
            context.ellipse(cx - radius * 0.32, cy - radius * 0.4, radius * 0.34, radius * 0.18, -0.5, 0, Math.PI * 2);
          } else {
            context.arc(cx - radius * 0.32, cy - radius * 0.4, radius * 0.26, 0, Math.PI * 2);
          }
          const sheen = context.createRadialGradient(
            cx - radius * 0.32,
            cy - radius * 0.4,
            0,
            cx - radius * 0.32,
            cy - radius * 0.4,
            radius * 0.5,
          );
          sheen.addColorStop(0, 'rgba(255,255,255,0.5)');
          sheen.addColorStop(1, 'rgba(255,255,255,0)');
          context.fillStyle = sheen;
          context.fill();
          context.restore();
        }
      }

      function loop(timestamp) {
        if (!running) return;
        const time = typeof timestamp === 'number' ? timestamp : 0;
        const interval = energy < 0.01 ? 66 : 33;
        if (time - lastFrame >= interval) {
          lastFrame = time;
          draw(time);
        }
        if (running) frameId = window.requestAnimationFrame(loop);
      }

      measure();
      draw(0);
      if (!reducedMotion) frameId = window.requestAnimationFrame(loop);

      if (typeof window.ResizeObserver === 'function') {
        try {
          observer = new window.ResizeObserver(() => {
            if (measure() && !reducedMotion) draw(0);
          });
          observer.observe(canvas);
        } catch (error) {
          observer = null;
        }
      }
      const onResize = () => {
        if (measure() && reducedMotion) draw(0);
      };
      if (window.addEventListener) window.addEventListener('resize', onResize);

      return function stopOrb() {
        running = false;
        if (frameId !== null && window.cancelAnimationFrame) window.cancelAnimationFrame(frameId);
        frameId = null;
        if (observer) {
          try {
            observer.disconnect();
          } catch (error) {
            // Already disconnected.
          }
          observer = null;
        }
        if (window.removeEventListener) window.removeEventListener('resize', onResize);
      };
    }

    function Orb(props) {
      const canvasRef = React.useRef(null);
      React.useEffect(() => installOrb(canvasRef.current, props.engine, 'orb'), [props.engine]);
      return h('canvas', { ref: canvasRef, className: 'adn-orb', width: 132, height: 132, 'aria-hidden': 'true' });
    }

    function OrbDot(props) {
      const canvasRef = React.useRef(null);
      React.useEffect(() => installOrb(canvasRef.current, props.engine, 'dot'), [props.engine]);
      return h('canvas', { ref: canvasRef, className: 'adn-orbdot', width: 20, height: 20, 'aria-hidden': 'true' });
    }

    // -------------------------------------------------------------- UI pieces

    function PlayIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 13, height: 13, 'aria-hidden': 'true', focusable: 'false' },
        h('path', {
          d: 'M5.4 3.3c0-.55.6-.87 1.06-.58l6.6 4.7c.4.28.4.88 0 1.16l-6.6 4.7c-.46.3-1.06-.02-1.06-.57V3.3Z',
          fill: 'currentColor',
        }),
      );
    }

    function PauseIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 13, height: 13, 'aria-hidden': 'true', focusable: 'false' },
        h('rect', { x: 4.7, y: 3.5, width: 2.4, height: 9, rx: 1.1, fill: 'currentColor' }),
        h('rect', { x: 8.9, y: 3.5, width: 2.4, height: 9, rx: 1.1, fill: 'currentColor' }),
      );
    }

    function ChevronIcon(props) {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 12,
          height: 12,
          className: 'adn-chevron',
          'data-open': props.open ? 'true' : 'false',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', {
          d: 'M3.6 6.1a.85.85 0 0 1 1.2 0L8 9.3l3.2-3.2a.85.85 0 1 1 1.2 1.2l-3.8 3.8a.85.85 0 0 1-1.2 0L3.6 7.3a.85.85 0 0 1 0-1.2Z',
          fill: 'currentColor',
        }),
      );
    }

    function VolumeIcon(props) {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 13, height: 13, 'aria-hidden': 'true', focusable: 'false' },
        h('path', {
          d: 'M3 6.2h2.1L8 3.6c.4-.3.9 0 .9.5v7.8c0 .5-.5.8-.9.5L5.1 9.8H3c-.3 0-.5-.2-.5-.5V6.7c0-.3.2-.5.5-.5Z',
          fill: 'currentColor',
        }),
        props.loud
          ? h('path', {
              d: 'M10.9 5.7c.9.6 1.4 1.4 1.4 2.3s-.5 1.7-1.4 2.3',
              stroke: 'currentColor',
              strokeWidth: 1.3,
              strokeLinecap: 'round',
              fill: 'none',
            })
          : h('path', {
              d: 'M10.8 6.2l2.4 2.4m0-2.4-2.4 2.4',
              stroke: 'currentColor',
              strokeWidth: 1.3,
              strokeLinecap: 'round',
              fill: 'none',
            }),
      );
    }

    function CloseIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 11, height: 11, 'aria-hidden': 'true', focusable: 'false' },
        h('path', {
          d: 'M4.2 4.2a.9.9 0 0 1 1.27 0L8 6.73l2.53-2.53a.9.9 0 1 1 1.27 1.27L9.27 8l2.53 2.53a.9.9 0 0 1-1.27 1.27L8 9.27l-2.53 2.53a.9.9 0 0 1-1.27-1.27L6.73 8 4.2 5.47a.9.9 0 0 1 0-1.27Z',
          fill: 'currentColor',
        }),
      );
    }

    function useEngineSnapshot(engine) {
      const [snapshot, setSnapshot] = React.useState(() => engine.getSnapshot());
      React.useEffect(() => engine.subscribe(() => setSnapshot(engine.getSnapshot())), [engine]);
      return snapshot;
    }

    function useUiOpen(ui) {
      const [open, setOpen] = React.useState(() => ui.isOpen());
      React.useEffect(() => ui.subscribe(() => setOpen(ui.isOpen())), [ui]);
      return open;
    }

    function soundDotStyle(id) {
      const pair = SOUND_TINTS[id] || SOUND_TINTS.pink;
      return {
        background:
          'radial-gradient(circle at 34% 28%, ' +
          tint(pair.glow, 0.95) +
          ', ' +
          tint(pair.main, 0.62) +
          ' 58%, ' +
          tint(pair.main, 0.2) +
          ' 88%, ' +
          tint(pair.main, 0) +
          ' 100%)',
      };
    }

    /** Collapsed player: play/pause, tinted mini orb, label, countdown, expand. */
    function renderPill(snapshot, translate, engine, open, onToggle, toggleRef) {
      const playing = snapshot.status === 'playing';
      const unsupported = snapshot.status === 'unsupported';
      const soundLabel = translate(SOUND_LABEL_KEYS[snapshot.sound] || 'soundPink');
      const countdown = snapshot.remainingMs > 0 ? formatClock(snapshot.remainingMs) : '';

      return h(
        'div',
        { className: 'adn-pill', 'data-playing': playing ? 'true' : 'false' },
        h(
          'button',
          {
            type: 'button',
            className: 'adn-pillbtn adn-play',
            'data-on': playing ? 'true' : 'false',
            'aria-label': translate(playing ? 'pause' : 'play'),
            title: translate(playing ? 'pause' : 'play'),
            disabled: unsupported,
            onClick: () => engine.toggle(),
          },
          playing ? h(PauseIcon) : h(PlayIcon),
        ),
        playing ? h(OrbDot, { engine }) : null,
        h(
          'button',
          {
            ref: toggleRef,
            type: 'button',
            className: 'adn-pillbtn adn-toggle',
            'aria-expanded': open,
            'aria-controls': open ? PANEL_ID : undefined,
            'aria-label': translate('openSettings'),
            title: translate('openSettings'),
            onClick: onToggle,
          },
          h('span', { className: 'adn-label' }, playing ? soundLabel : translate('standby')),
          countdown ? h('span', { className: 'adn-clock' }, countdown) : null,
          h(ChevronIcon, { open }),
        ),
      );
    }

    /** Expanded popover: sound orb, tinted sound orbs, volume and timer. */
    function renderPanel(snapshot, translate, engine, onClose) {
      const volumePercent = Math.round(snapshot.volume * 100);
      const countdown = snapshot.remainingMs > 0 ? formatClock(snapshot.remainingMs) : '';
      const unsupported = snapshot.status === 'unsupported';
      const playing = snapshot.status === 'playing';
      const soundLabel = translate(SOUND_LABEL_KEYS[snapshot.sound] || 'soundPink');
      const pair = SOUND_TINTS[snapshot.sound] || SOUND_TINTS.pink;
      const wash = { '--adn-tint': tint(pair.glow, 0.24) };

      const controls = unsupported
        ? h('p', { className: 'adn-note' }, translate('unsupported'))
        : h(
            'div',
            { className: 'adn-controls' },
            h(
              'div',
              { className: 'adn-sounds', role: 'group', 'aria-label': translate('sound') },
              SOUND_IDS.map((id) =>
                h(
                  'button',
                  {
                    key: id,
                    type: 'button',
                    className: 'adn-sound',
                    'data-active': snapshot.sound === id ? 'true' : 'false',
                    'aria-pressed': snapshot.sound === id ? 'true' : 'false',
                    title: id === 'brown' ? translate('soundBrownNote') : translate(SOUND_LABEL_KEYS[id]),
                    onClick: () => engine.setSound(id),
                  },
                  h('span', { className: 'adn-sounddot', style: soundDotStyle(id), 'aria-hidden': 'true' }),
                  h('span', { className: 'adn-soundlabel' }, translate(SOUND_LABEL_KEYS[id])),
                ),
              ),
            ),
            h(
              'div',
              { className: 'adn-volume' },
              h('span', { className: 'adn-volicon', 'aria-hidden': 'true' }, h(VolumeIcon, { loud: false })),
              h('input', {
                type: 'range',
                className: 'adn-range',
                min: 0,
                max: 100,
                step: 1,
                value: volumePercent,
                'aria-label': translate('volume'),
                style: { '--adn-fill': volumePercent + '%' },
                onChange: (event) => engine.setVolume(Number(event.target.value) / 100),
              }),
              h('span', { className: 'adn-volicon', 'aria-hidden': 'true' }, h(VolumeIcon, { loud: true })),
              h('span', { className: 'adn-value' }, volumePercent + '%'),
            ),
            h(
              'div',
              { className: 'adn-times', role: 'group', 'aria-label': translate('timer') },
              h('span', { className: 'adn-eyebrow' }, translate('timer')),
              TIMER_OPTIONS.map((minutes) =>
                h(
                  'button',
                  {
                    key: minutes,
                    type: 'button',
                    className: 'adn-time',
                    'aria-pressed': snapshot.timerMinutes === minutes ? 'true' : 'false',
                    onClick: () => engine.setTimer(minutes),
                  },
                  translate(minutes === 0 ? 'timerOff' : 'timer' + minutes),
                ),
              ),
            ),
            snapshot.blocked ? h('p', { className: 'adn-note' }, translate('blockedHint')) : null,
            snapshot.volume > LOUD_VOLUME_THRESHOLD ? h('p', { className: 'adn-note' }, translate('loudHint')) : null,
            h('p', { className: 'adn-hint' }, translate(snapshot.ended ? 'timerDone' : 'hint')),
            h(
              'span',
              { className: 'adn-sr', role: 'status', 'aria-live': 'polite' },
              snapshot.blocked ? translate('blockedHint') : playing ? soundLabel : translate('standby'),
            ),
          );

      return h(
        'div',
        {
          className: 'adn-panel adn-refract',
          id: PANEL_ID,
          role: 'group',
          'aria-label': translate('panelTitle'),
          style: wash,
        },
        h(RefractionFilter),
        h(
          'button',
          {
            type: 'button',
            className: 'adn-close',
            'aria-label': translate('close'),
            title: translate('close'),
            onClick: onClose,
          },
          h(CloseIcon),
        ),
        h(
          'div',
          { className: 'adn-hero' },
          h(Orb, { engine }),
          h(
            'div',
            { className: 'adn-herotext' },
            h('h2', { className: 'adn-display' }, soundLabel),
            h(
              'div',
              { className: 'adn-now' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'adn-playbtn',
                  'aria-label': translate(playing ? 'pause' : 'play'),
                  title: translate(playing ? 'pause' : 'play'),
                  disabled: unsupported,
                  onClick: () => engine.toggle(),
                },
                playing ? h(PauseIcon) : h(PlayIcon),
              ),
              countdown ? h('span', { className: 'adn-clock' }, countdown) : null,
            ),
          ),
        ),
        controls,
      );
    }

    const REFRACTION_ID = 'adn-noise-refraction';

    /**
     * A background-only displacement map: the glass edge bends what is behind it
     * instead of just blurring it. Browsers that cannot use a URL filter in
     * backdrop-filter simply ignore the declaration and keep the plain blur.
     */
    function RefractionFilter() {
      return h(
        'svg',
        { className: 'adn-refraction', 'aria-hidden': 'true', width: 0, height: 0 },
        h(
          'defs',
          null,
          h(
            'filter',
            {
              id: REFRACTION_ID,
              x: '-12%',
              y: '-12%',
              width: '124%',
              height: '124%',
              colorInterpolationFilters: 'sRGB',
            },
            h('feTurbulence', {
              type: 'fractalNoise',
              baseFrequency: '0.006 0.01',
              numOctaves: 2,
              seed: 6,
              result: 'noise',
            }),
            h('feGaussianBlur', { in: 'noise', stdDeviation: '5', result: 'soft' }),
            h('feDisplacementMap', {
              in: 'SourceGraphic',
              in2: 'soft',
              scale: 18,
              xChannelSelector: 'R',
              yChannelSelector: 'G',
            }),
          ),
        ),
      );
    }

    /** Fixed geometry for the popover, anchored to the composer's top-right. */
    function overlayStyle(anchor) {
      const margin = 8;
      const viewportWidth = Math.max(320, window.innerWidth || 1024);
      const viewportHeight = Math.max(320, window.innerHeight || 768);
      const width = Math.min(400, Math.max(300, viewportWidth - 32));
      const anchored = !!(anchor && Number.isFinite(anchor.top) && Number.isFinite(anchor.right) && anchor.top > 0);
      const composerBottom =
        anchor && Number.isFinite(anchor.composerBottom) && anchor.composerBottom > 0 ? anchor.composerBottom : null;
      let right = anchored
        ? Math.min(Math.max(16, viewportWidth - anchor.right), viewportWidth - width - 16)
        : Math.max(16, viewportWidth - width - 24);
      // Align the panel's bottom edge with the composer's bottom edge; fall back
      // to hovering just above the composer when its card cannot be measured.
      let bottom = composerBottom !== null
        ? Math.max(16, Math.min(viewportHeight - 120, viewportHeight - composerBottom))
        : anchored
          ? Math.max(16, Math.min(viewportHeight - 160, viewportHeight - anchor.top + margin))
          : Math.min(viewportHeight - 160, 128);

      // Narrow windows: if the card would sit on top of the composer, move it to
      // whichever side has room, and only then fall back to hovering above it.
      const composer = anchor && anchor.composer && Number.isFinite(anchor.composer.left) ? anchor.composer : null;
      if (composer) {
        const panelLeft = viewportWidth - right - width;
        const overlaps = panelLeft < composer.right - 4 && panelLeft + width > composer.left + 4;
        if (overlaps) {
          const leftSpace = composer.left - 16;
          const rightSpace = viewportWidth - composer.right - 16;
          if (leftSpace >= width) {
            right = viewportWidth - (composer.left - 8);
          } else if (rightSpace >= width) {
            right = viewportWidth - (composer.right + 8);
          } else {
            bottom = Math.max(16, Math.min(viewportHeight - 120, viewportHeight - composer.top + 8));
            right = Math.min(Math.max(16, viewportWidth - composer.right), viewportWidth - width - 16);
          }
        }
      }
      return {
        position: 'fixed',
        right: right + 'px',
        bottom: Math.max(16, bottom) + 'px',
        width: width + 'px',
        maxHeight: Math.max(260, viewportHeight - Math.max(16, bottom) - 16) + 'px',
      };
    }

    function readElementRect(element) {
      try {
        if (!element || typeof element.getBoundingClientRect !== 'function') return null;
        return element.getBoundingClientRect();
      } catch (error) {
        return null;
      }
    }

    /**
     * The composer card is the next substantial sibling after the dock entry (or
     * after one of its ancestors). Walking outward avoids a host-specific
     * selector while still giving an exact bottom edge to align against.
     */
    function findComposerCard(element) {
      let node = element;
      for (let depth = 0; node && depth < 6; depth += 1) {
        // At the probe's own level the siblings are other dock rows (short); only
        // the composer card is tall enough there.
        const minHeight = depth === 0 ? 60 : 36;
        let sibling = node.nextElementSibling;
        while (sibling) {
          const rect = readElementRect(sibling);
          if (rect && rect.height >= minHeight && rect.width >= 180) return { element: sibling, rect };
          sibling = sibling.nextElementSibling;
        }
        node = node.parentElement;
      }
      return null;
    }

    /**
     * Zero-height probe above the composer: it measures the composer's top and
     * bottom edges so the floating panel can align to them without taking layout
     * space (a full-width flow entry would squeeze the conversation).
     */
    function AnchorProbe(props) {
      const probeRef = React.useRef(null);
      const { ui } = props;
      React.useEffect(() => {
        let composerObserver = null;
        let watched = null;
        const update = () => {
          const element = probeRef.current;
          if (!element || typeof element.getBoundingClientRect !== 'function') return;
          const rect = element.getBoundingClientRect();
          const composer = findComposerCard(element);
          const composerRect = composer ? composer.rect : null;
          ui.setAnchorRect({
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            left: rect.left,
            width: rect.width,
            height: rect.height,
            composerBottom: composerRect ? composerRect.bottom : null,
            composer: composerRect
              ? {
                  left: composerRect.left,
                  right: composerRect.right,
                  top: composerRect.top,
                  bottom: composerRect.bottom,
                  width: composerRect.width,
                  height: composerRect.height,
                }
              : null,
          });
          if (composer && composer.element !== watched) {
            watched = composer.element;
            if (composerObserver) composerObserver.disconnect();
            if (typeof window.ResizeObserver === 'function') {
              try {
                composerObserver = new window.ResizeObserver(update);
                composerObserver.observe(watched);
              } catch (error) {
                composerObserver = null;
              }
            }
          }
        };
        update();
        window.addEventListener('resize', update);
        window.addEventListener('scroll', update, true);
        return () => {
          window.removeEventListener('resize', update);
          window.removeEventListener('scroll', update, true);
          if (composerObserver) composerObserver.disconnect();
        };
      }, [ui]);
      return h('div', { ref: probeRef, className: 'adn-probe', 'aria-hidden': 'true' });
    }

    /** The popover itself, rendered in the frame overlay so nothing reflows. */
    function OverlayPanel(props) {
      const { engine, ui } = props;
      const translate = typeof props.t === 'function' ? props.t : (key) => key;
      const snapshot = useEngineSnapshot(engine);
      const open = useUiOpen(ui);
      const panelRef = React.useRef(null);
      const [, setRevision] = React.useState(0);

      // Re-render on language switches and on dictionaries that register late.
      React.useSyncExternalStore(props.subscribeLocale, props.localeSnapshot, props.localeSnapshot);
      useGlassTone(panelRef, open);

      const openerRef = React.useRef(null);

      React.useEffect(() => {
        if (!open) return undefined;
        openerRef.current = ui.getAnchorElement() || null;
        const node = panelRef.current;
        if (node && typeof node.focus === 'function') {
          try {
            node.focus({ preventScroll: true });
          } catch (error) {
            node.focus();
          }
        }
        return () => {
          const opener = openerRef.current;
          openerRef.current = null;
          if (!opener || typeof opener.focus !== 'function') return;
          const active = document.activeElement;
          const insidePanel = panelRef.current && active && panelRef.current.contains(active);
          const outside = !active || active === document.body;
          if (insidePanel || outside) {
            try {
              opener.focus({ preventScroll: true });
            } catch (error) {
              opener.focus();
            }
          }
        };
      }, [open, ui]);

      const onPointerMove = (event) => {
        const node = panelRef.current;
        if (!node || typeof node.getBoundingClientRect !== 'function') return;
        const rect = node.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        node.style.setProperty('--adn-mx', (((event.clientX - rect.left) / rect.width) * 100).toFixed(1) + '%');
        node.style.setProperty('--adn-my', (((event.clientY - rect.top) / rect.height) * 100).toFixed(1) + '%');
      };

      React.useEffect(() => {
        if (!open) return undefined;
        const bump = () => setRevision((value) => value + 1);
        const onPointerDown = (event) => {
          const target = event.target;
          if (panelRef.current && target && typeof panelRef.current.contains === 'function' && panelRef.current.contains(target)) return;
          const toggle = ui.getAnchorElement();
          if (toggle && target && typeof toggle.contains === 'function' && toggle.contains(target)) return;
          ui.close();
        };
        const onKeyDown = (event) => {
          if (event.key === 'Escape') ui.close();
        };
        window.addEventListener('resize', bump);
        window.addEventListener('scroll', bump, true);
        document.addEventListener('mousedown', onPointerDown, true);
        window.addEventListener('keydown', onKeyDown);
        return () => {
          window.removeEventListener('resize', bump);
          window.removeEventListener('scroll', bump, true);
          document.removeEventListener('mousedown', onPointerDown, true);
          window.removeEventListener('keydown', onKeyDown);
        };
      }, [open, ui]);

      if (!open) return null;
      return h(
        'div',
        {
          className: 'adn-overlay',
          ref: panelRef,
          tabIndex: -1,
          style: overlayStyle(ui.getAnchorRect()),
          onMouseMove: onPointerMove,
        },
        renderPanel(snapshot, translate, engine, () => ui.close()),
      );
    }

    function PillEntry(props) {
      const { engine, ui } = props;
      const translate = typeof props.t === 'function' ? props.t : (key) => key;
      const snapshot = useEngineSnapshot(engine);
      const open = useUiOpen(ui);
      const toggleRef = React.useRef(null);
      const rootRef = React.useRef(null);

      // Re-render on language switches and on dictionaries that register late.
      React.useSyncExternalStore(props.subscribeLocale, props.localeSnapshot, props.localeSnapshot);
      useGlassTone(rootRef, true);

      // A stranded popover must not survive the composer it was opened from.
      React.useEffect(() => () => ui.close(), [ui]);

      return h(
        'div',
        { className: 'adn-root', ref: rootRef },
        props.inlineStyles ? h('style', null, STYLES) : null,
        renderPill(snapshot, translate, engine, open, () => ui.toggle(toggleRef.current), toggleRef),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const engine = createEngine();
        ctx.effect(() => () => engine.dispose(), 'adhd-noise: audio engine');

        ctx.effect(
          () => ctx.locale.register(NAMESPACE, { zh: DICT_ZH, en: DICT_EN }),
          'adhd-noise: locale dictionaries',
        );

        let stylesInstalled = false;
        try {
          if (typeof styles !== 'undefined' && styles && typeof styles.insert === 'function') {
            const disposeStyles = styles.insert(STYLES);
            stylesInstalled = true;
            ctx.effect(() => disposeStyles, 'adhd-noise: stylesheet');
          }
        } catch (error) {
          stylesInstalled = false;
        }

        // Panel visibility plus the anchor the popover positions itself against.
        let open = false;
        let anchorRect = null;
        let anchorElement = null;
        const openListeners = new Set();
        function notifyOpen() {
          for (const listener of openListeners) {
            try {
              listener();
            } catch (error) {
              // A broken subscriber must not block the toggle.
            }
          }
        }
        const ui = {
          isOpen: () => open,
          toggle(element) {
            open = !open;
            anchorElement = open ? element || null : null;
            notifyOpen();
          },
          close() {
            if (!open) return;
            open = false;
            anchorElement = null;
            notifyOpen();
          },
          getAnchorElement: () => anchorElement,
          getAnchorRect: () => anchorRect,
          setAnchorRect(rect) {
            anchorRect = rect;
          },
          subscribe(listener) {
            openListeners.add(listener);
            return () => {
              openListeners.delete(listener);
            };
          },
        };

        const subscribeLocale = (listener) => {
          if (ctx.locale && typeof ctx.locale.subscribe === 'function') return ctx.locale.subscribe(listener);
          return () => {};
        };
        const localeSnapshot = () => {
          if (!ctx.locale) return '';
          const current = typeof ctx.locale.getSnapshot === 'function' ? ctx.locale.getSnapshot() : null;
          if (current && typeof current.revision === 'number') return current.revision;
          const locale = typeof ctx.locale.getLocale === 'function' ? ctx.locale.getLocale() : null;
          return locale && typeof locale.active === 'string' ? locale.active : '';
        };

        const injectFace = () => ({
          engine,
          ui,
          subscribeLocale,
          localeSnapshot,
          inlineStyles: !stylesInstalled,
        });

        // Compact player under the composer.
        ctx.effect(
          () =>
            ctx.slots.inject('conversation.composer.dock', () =>
              ctx.slots.register(
                {
                  name: 'conversation.composer.dock',
                  id: 'adhd-noise',
                  order: 2,
                  locale: NAMESPACE,
                  inject: injectFace,
                },
                PillEntry,
              ),
            ),
          'adhd-noise: composer dock pill',
        );

        // Zero-height anchor at the composer's top edge.
        ctx.effect(
          () =>
            ctx.slots.inject('conversation.input.dock', () =>
              ctx.slots.register(
                {
                  name: 'conversation.input.dock',
                  id: 'adhd-noise-anchor',
                  order: 31,
                  locale: NAMESPACE,
                  inject: injectFace,
                },
                AnchorProbe,
              ),
            ),
          'adhd-noise: composer top anchor',
        );

        // Floating panel in the frame overlay: no layout shift, no squeeze.
        ctx.effect(
          () =>
            ctx.slots.inject('shell.overlay', () =>
              ctx.slots.register(
                {
                  name: 'shell.overlay',
                  id: 'adhd-noise-panel',
                  order: 20,
                  locale: NAMESPACE,
                  inject: injectFace,
                },
                OverlayPanel,
              ),
            ),
          'adhd-noise: floating panel',
        );
      },
    };
  },
});
