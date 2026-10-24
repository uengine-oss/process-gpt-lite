// Sky fragment shader: gradient + sun/moon glow + domain-warped fbm clouds + stars + grain.
// All color decisions are made on the CPU (palette.js); the shader only composes.
export const VERT = `
attribute vec2 p;
void main(){ gl_Position = vec4(p, 0.0, 1.0); }`

export const FRAG = `
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform vec3 uZenith, uHorizon, uCloud, uSun;
uniform vec2 uSunPos;      // screen space 0..1 (y up); can be below 0 when set
uniform float uSunGlow, uMoonGlow, uCover, uStars, uDay, uFog, uWind;

float hash(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(hash(i), hash(i+vec2(1,0)), u.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), u.x), u.y);
}
float fbm(vec2 p){
  float v = 0.0, a = 0.5;
  mat2 r = mat2(0.8, -0.6, 0.6, 0.8);
  for (int i = 0; i < 6; i++){ v += a*noise(p); p = r*p*2.03 + 7.1; a *= 0.5; }
  return v;
}

void main(){
  vec2 uv = gl_FragCoord.xy / uRes;
  float aspect = uRes.x / uRes.y;
  vec2 q = vec2(uv.x*aspect, uv.y);

  // base gradient: horizon at the bottom, zenith at the top (eased)
  float h = pow(clamp(uv.y, 0.0, 1.0), 0.75);
  vec3 col = mix(uHorizon, uZenith, h);

  // sun / moon glow
  vec2 sp = vec2(uSunPos.x*aspect, uSunPos.y);
  float d = distance(q, sp);
  col += uSun * uSunGlow * (0.55*exp(-d*3.2) + 0.25*exp(-d*12.0));
  col += uSun * uSunGlow * 0.18 * exp(-abs(uv.y - max(uSunPos.y, 0.0))*6.0) * (1.0-uDay*0.6);
  vec2 mp = vec2((1.0-uSunPos.x)*aspect, 0.78);
  float md = distance(q, mp);
  col += vec3(0.75, 0.8, 1.0) * uMoonGlow * (0.22*exp(-md*7.0) + 0.6*smoothstep(0.022, 0.018, md));

  // stars
  if (uStars > 0.01){
    vec2 g = gl_FragCoord.xy / 2.2;
    float s = hash(floor(g));
    float tw = 0.6 + 0.4*sin(uTime*1.7 + s*40.0);
    float star = step(0.9965, s) * tw * smoothstep(0.15, 0.6, uv.y);
    col += vec3(star) * uStars * 0.9;
  }

  // clouds: two domain-warped layers drifting with the wind
  float t = uTime * 0.012 * (0.4 + uWind);
  vec2 cp = q * vec2(1.1, 2.4) + vec2(t, 0.0);
  vec2 w = vec2(fbm(cp*0.6 + t*0.3), fbm(cp*0.6 - t*0.2 + 3.7));
  float n = fbm(cp + 1.8*w);
  float cov = mix(0.72, 0.28, uCover);
  float c = smoothstep(cov, cov + 0.32, n) * smoothstep(-0.05, 0.55, uv.y + 0.2);
  // thinner high wisps
  float wisp = smoothstep(0.55, 0.95, fbm(q*vec2(0.7, 3.5) + vec2(t*1.6, 0.0) + w)) * 0.45;
  float lightSide = clamp(1.0 - distance(q, sp)*0.6, 0.0, 1.0);
  vec3 cloudCol = mix(uCloud*0.82, uCloud + uSun*0.15*uSunGlow, lightSide);
  col = mix(col, cloudCol, clamp(c*0.85 + wisp*(0.4+uCover*0.3), 0.0, 0.95));

  // low haze / fog along the horizon
  float haze = exp(-uv.y*4.0) * (0.18 + uFog*0.6);
  col = mix(col, mix(uHorizon, uCloud, 0.5), haze);

  // night floor: never pure black
  col = max(col, vec3(0.035, 0.05, 0.12) * (1.0 - uDay));

  // soft vignette + grain
  col *= 1.0 - 0.12*pow(distance(uv, vec2(0.5)), 2.0);
  col += (hash(gl_FragCoord.xy + fract(uTime)) - 0.5) * 0.018;
  gl_FragColor = vec4(col, 1.0);
}`
