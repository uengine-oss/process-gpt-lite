<script setup>
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { useSky } from '../stores/sky.js'
import { VERT, FRAG } from './shader.js'
import { sunPosition } from './solar.js'
import { computePalette } from './palette.js'

const props = defineProps({ hour: { type: Number, default: null } })
const sky = useSky()
const canvas = ref(null)
let gl, prog, raf, u = {}
// current (eased) values, so time or weather changes glide instead of jumping
const cur = {}
const lerp = (a, b, t) => (Array.isArray(a) ? a.map((v, i) => v + (b[i] - v) * t) : a + (b - a) * t)

function target() {
  if (props.hour != null) {
    const d = new Date()
    d.setHours(Math.floor(props.hour), Math.round((props.hour % 1) * 60), 0, 0)
    const pl = sky.place || { lat: 37.57, lon: 126.98 }
    const sun = sunPosition(d, pl.lat, pl.lon)
    return { ...computePalette({ altitude: sun.altitude, cloudCover: 30, weatherCode: 2 }), sun }
  }
  return { ...sky.palette, sun: sky.sun }
}

function sunScreen(sun) {
  const x = 0.5 + Math.max(-0.7, Math.min(0.7, (sun.azimuth - 180) / 150))
  const y = 0.1 + sun.altitude / 55
  return [x, y]
}

function compile(type, src) {
  const s = gl.createShader(type)
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s))
  return s
}

function resize() {
  const c = canvas.value
  // the sky is soft; render at reduced resolution and let CSS upscale
  const scale = Math.min(window.devicePixelRatio || 1, 1) * 0.5
  c.width = Math.max(2, Math.floor(c.clientWidth * scale))
  c.height = Math.max(2, Math.floor(c.clientHeight * scale))
  gl.viewport(0, 0, c.width, c.height)
}

function frame(ts) {
  const t = target()
  const goal = {
    zenith: t.zenith, horizon: t.horizon, cloud: t.cloud, sun: t.sunColor,
    sunPos: sunScreen(t.sun), sunGlow: t.sunGlow, moonGlow: t.moonGlow,
    cover: t.cover, stars: t.stars, day: t.day, fog: t.fog,
  }
  for (const k in goal) cur[k] = cur[k] === undefined ? goal[k] : lerp(cur[k], goal[k], 0.03)
  gl.uniform2f(u.uRes, canvas.value.width, canvas.value.height)
  gl.uniform1f(u.uTime, ts / 1000)
  gl.uniform3fv(u.uZenith, cur.zenith)
  gl.uniform3fv(u.uHorizon, cur.horizon)
  gl.uniform3fv(u.uCloud, cur.cloud)
  gl.uniform3fv(u.uSun, cur.sun)
  gl.uniform2fv(u.uSunPos, cur.sunPos)
  gl.uniform1f(u.uSunGlow, cur.sunGlow)
  gl.uniform1f(u.uMoonGlow, cur.moonGlow)
  gl.uniform1f(u.uCover, cur.cover)
  gl.uniform1f(u.uStars, cur.stars)
  gl.uniform1f(u.uDay, cur.day)
  gl.uniform1f(u.uFog, cur.fog)
  gl.uniform1f(u.uWind, Math.min(1, (sky.wx?.wind ?? 8) / 25))
  gl.drawArrays(gl.TRIANGLES, 0, 6)
  raf = requestAnimationFrame(frame)
}

onMounted(() => {
  gl = canvas.value.getContext('webgl', { antialias: false, alpha: false })
  if (!gl) return
  prog = gl.createProgram()
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT))
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG))
  gl.linkProgram(prog)
  gl.useProgram(prog)
  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW)
  const loc = gl.getAttribLocation(prog, 'p')
  gl.enableVertexAttribArray(loc)
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
  for (const n of ['uRes', 'uTime', 'uZenith', 'uHorizon', 'uCloud', 'uSun', 'uSunPos', 'uSunGlow', 'uMoonGlow', 'uCover', 'uStars', 'uDay', 'uFog', 'uWind']) {
    u[n] = gl.getUniformLocation(prog, n)
  }
  resize()
  window.addEventListener('resize', resize)
  raf = requestAnimationFrame(frame)
})
onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  window.removeEventListener('resize', resize)
})
</script>

<template>
  <canvas ref="canvas" class="sky" />
</template>

<style scoped>
.sky { position: absolute; inset: 0; width: 100%; height: 100%; display: block; filter: blur(14px) saturate(1.05); transform: scale(1.08); }
</style>
