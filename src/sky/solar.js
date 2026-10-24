// Solar position (NOAA simplified). Returns degrees.
const rad = Math.PI / 180

export function sunPosition(date, lat, lon) {
  const jd = date.getTime() / 86400000 + 2440587.5
  const n = jd - 2451545.0
  const L = (280.46 + 0.9856474 * n) % 360
  const g = ((357.528 + 0.9856003 * n) % 360) * rad
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad
  const eps = (23.439 - 0.0000004 * n) * rad
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda))
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda))
  const gmst = (280.46061837 + 360.98564736629 * n) % 360
  const ha = ((gmst + lon) * rad - ra)
  const phi = lat * rad
  const alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha))
  const az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(ha))
  return { altitude: alt / rad, azimuth: ((az / rad) + 360) % 360 }
}

// Sunset time today (local), found by scanning altitude crossings.
export function sunsetTime(date, lat, lon) {
  const d = new Date(date); d.setHours(12, 0, 0, 0)
  let prev = sunPosition(d, lat, lon).altitude
  for (let m = 5; m < 12 * 60; m += 5) {
    const t = new Date(d.getTime() + m * 60000)
    const a = sunPosition(t, lat, lon).altitude
    if (prev > -0.83 && a <= -0.83) return t
    prev = a
  }
  return null
}

// Moon phase 0..1 (0 = new, .5 = full)
export function moonPhase(date) {
  const synodic = 29.530588853
  const ref = Date.UTC(2000, 0, 6, 18, 14) // known new moon
  const days = (date.getTime() - ref) / 86400000
  return ((days % synodic) + synodic) % synodic / synodic
}
