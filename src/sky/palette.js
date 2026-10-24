// CPU palette engine: sun altitude + weather -> shader colors.
// Colors are linear-ish sRGB triplets in 0..1.

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t)
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x))
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t) }

// [altitude, zenith, horizon, cloudLit, sunColor]
const STOPS = [
  [-90, '#0a0f24', '#1b2349', '#262d52', '#000000'],
  [-18, '#0d1430', '#222b58', '#2b335c', '#000000'],
  [-12, '#141c40', '#323a6c', '#3a4270', '#3a2a50'],
  [-6, '#22305f', '#6b5b86', '#5a5a86', '#a0607a'],
  [-3, '#2f4579', '#b9808a', '#9a7f98', '#ff8a60'],
  [0, '#3f5c93', '#f0a77d', '#e5b3a0', '#ff9a55'],
  [4, '#4d6ea8', '#f6c9a0', '#f4d8c8', '#ffc078'],
  [10, '#4c72ad', '#dfe0dc', '#f6f1ec', '#fff0d0'],
  [25, '#4670ad', '#c9dbee', '#f5f7fb', '#ffffff'],
  [60, '#3b69ae', '#bcd5f0', '#f7f9fd', '#ffffff'],
  [90, '#3767ad', '#b8d3f0', '#f8fafd', '#ffffff'],
].map(([a, z, h, c, s]) => [a, hex(z), hex(h), hex(c), hex(s)])

function sample(alt) {
  for (let i = 0; i < STOPS.length - 1; i++) {
    const [a0, ...c0] = STOPS[i]
    const [a1, ...c1] = STOPS[i + 1]
    if (alt >= a0 && alt <= a1) {
      const t = smooth(0, 1, (alt - a0) / (a1 - a0))
      return c0.map((c, k) => mix(c, c1[k], t))
    }
  }
  return STOPS[STOPS.length - 1].slice(1)
}

// WMO weather code -> { gray, dens, rain }
export function conditionProfile(code) {
  if (code == null) return { gray: 0, dens: 0, rain: 0, label: 'Clear Sky' }
  if (code === 0) return { gray: 0, dens: 0, rain: 0, label: 'Clear Sky' }
  if (code === 1) return { gray: 0.05, dens: 0.05, rain: 0, label: 'Mostly Clear' }
  if (code === 2) return { gray: 0.15, dens: 0.15, rain: 0, label: 'Partly Cloudy' }
  if (code === 3) return { gray: 0.45, dens: 0.35, rain: 0, label: 'Overcast Clouds' }
  if (code === 45 || code === 48) return { gray: 0.6, dens: 0.3, rain: 0, fog: 1, label: 'Fog' }
  if (code >= 51 && code <= 67) return { gray: 0.55, dens: 0.4, rain: 0.6, label: 'Rain' }
  if (code >= 71 && code <= 77) return { gray: 0.5, dens: 0.4, rain: 0.3, label: 'Snow' }
  if (code >= 80 && code <= 82) return { gray: 0.5, dens: 0.4, rain: 0.8, label: 'Showers' }
  if (code >= 95) return { gray: 0.7, dens: 0.5, rain: 1, label: 'Thunderstorm' }
  return { gray: 0.2, dens: 0.1, rain: 0, label: 'Cloudy' }
}

export function computePalette({ altitude, cloudCover = 20, weatherCode = 0, moon = 0.5 }) {
  const [zenith, horizon, cloudLit, sunColor] = sample(altitude)
  const prof = conditionProfile(weatherCode)
  const cover = clamp(Math.max(0.07, cloudCover / 100))
  const day = smooth(-8, 2, altitude)
  const gray = clamp(prof.gray * (0.4 + cover))
  const grayDay = hex('#9aa6b6'), grayNight = hex('#232a40')
  const g = mix(grayNight, grayDay, day)
  const stars = clamp(1 - smooth(-14, -4, altitude)) * (1 - cover * 0.85)
  return {
    zenith: mix(zenith, g, gray * 0.8),
    horizon: mix(horizon, mix(g, [1, 1, 1], 0.2), gray * 0.7),
    cloud: mix(cloudLit, g, gray * 0.5),
    sunColor,
    cover: clamp(cover + prof.dens * 0.5),
    stars,
    sunGlow: clamp(1 - cover * 0.9) * smooth(-10, -1, altitude),
    moonGlow: (1 - day) * Math.sin(moon * Math.PI) * (1 - cover),
    fog: prof.fog || 0,
    day,
    isDay: altitude > -4,
    label: prof.label,
  }
}
