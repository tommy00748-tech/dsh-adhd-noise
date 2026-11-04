/**
 * Host half of the ADHD focus-noise bundle.
 *
 * The soundscape itself is synthesised in the browser; this half only turns the
 * plugin row's `config` into defaults the Client can read. Because the Client
 * cannot read the Loader patch, the defaults are injected into the page index as
 * `window.__ADHD_NOISE_DEFAULTS__` when the web server is available. Stored
 * user choices in localStorage always take precedence over these defaults.
 *
 * Patch example:
 *
 *   - id: adhd-noise
 *     config:
 *       defaultSound: brown
 *       defaultVolume: 0.35
 *       timerMinutes: 25
 */

const SOUNDS = ['brown', 'pink', 'white', 'rain', 'fan'];
const TIMERS = [0, 15, 25, 50, 90];

function clampNumber(value, min, max) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return null;
  if (number < min) return min;
  if (number > max) return max;
  return number;
}

/** Normalise the row config into the compact payload the Client consumes. */
export function normalizeDefaults(config) {
  const source = config && typeof config === 'object' ? config : {};
  let volume = clampNumber(source.defaultVolume, 0, 100);
  if (volume !== null && volume > 1) volume = volume / 100;
  return {
    sound: SOUNDS.indexOf(source.defaultSound) >= 0 ? source.defaultSound : 'pink',
    volume: volume === null ? 0.3 : volume,
    timerMinutes: TIMERS.indexOf(source.timerMinutes) >= 0 ? source.timerMinutes : 25,
  };
}

export function apply(ctx, config) {
  const defaults = normalizeDefaults(config);
  const payload = JSON.stringify(defaults).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028');

  // The web server is optional: without it the Client keeps its built-in defaults.
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.tapIndex((html) => {
          const tag = '<script>window.__ADHD_NOISE_DEFAULTS__=' + payload + ';</script>';
          const headEnd = html.indexOf('</head>');
          return headEnd >= 0 ? html.slice(0, headEnd) + tag + html.slice(headEnd) : tag + html;
        }),
      'adhd-noise: inject client defaults',
    );
  });
}
