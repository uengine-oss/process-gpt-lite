// Location + live weather (Open-Meteo, no key). Falls back to Seoul.
const FALLBACK = { lat: 37.5665, lon: 126.978, place: 'Seoul, KR', approx: true }
const KEY = 'pgpt-pro-place'

export async function locate() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null')
    if (saved?.lat) return saved
  } catch { /* storage unavailable */ }
  try {
    const r = await fetch('https://ipapi.co/json/')
    const j = await r.json()
    if (j.latitude) return { lat: j.latitude, lon: j.longitude, place: `${j.city}, ${j.country_code}`, approx: true }
  } catch { /* offline or blocked */ }
  return FALLBACK
}

export function savePlace(p) {
  try { localStorage.setItem(KEY, JSON.stringify(p)) } catch { /* ignore */ }
}

export function preciseLocation() {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const { latitude: lat, longitude: lon } = pos.coords
      let place = '현재 위치'
      try {
        const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=10&accept-language=en`)
        const j = await r.json()
        place = `${j.address.city || j.address.town || j.address.county || ''}, ${(j.address.country_code || '').toUpperCase()}`
      } catch { /* keep generic name */ }
      resolve({ lat, lon, place, approx: false })
    }, reject, { timeout: 10000 })
  })
}

export async function weather({ lat, lon }) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    '&current=temperature_2m,apparent_temperature,weather_code,cloud_cover,wind_speed_10m,is_day' +
    '&daily=sunset,sunrise&timezone=auto&forecast_days=1'
  const j = await (await fetch(url)).json()
  return {
    temp: Math.round(j.current.temperature_2m),
    feels: Math.round(j.current.apparent_temperature),
    code: j.current.weather_code,
    cloud: j.current.cloud_cover,
    wind: j.current.wind_speed_10m,
    sunset: j.daily?.sunset?.[0],
    sunrise: j.daily?.sunrise?.[0],
  }
}
