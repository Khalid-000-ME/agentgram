/**
 * PixelBlast — an animated dithered-pixel field, used behind the landing page hero.
 *
 * Ported from React Bits' PixelBlast (JS-CSS variant, https://reactbits.dev) to a plain
 * ES module, because the landing page is server-rendered HTML with no React build. The
 * shader is the original. Two things are deliberately left out: the optional `liquid` and
 * `noise` passes, which pull in the `postprocessing` package and are off by default.
 *
 *   import { pixelBlast } from '/assets/pixelblast.js';
 *   const stop = pixelBlast(containerEl, { color: '#FF3B00' });
 *
 * Unlike the original, it pauses for real when the container is off screen, and renders a
 * single still frame for visitors who ask for reduced motion.
 */
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js';

const SHAPES = { square: 0, circle: 1, triangle: 2, diamond: 3 };
const MAX_CLICKS = 10;

const VERTEX = `
void main() {
  gl_Position = vec4(position, 1.0);
}
`;

const FRAGMENT = `
precision highp float;

uniform vec3  uColor;
uniform vec2  uResolution;
uniform float uTime;
uniform float uPixelSize;
uniform float uScale;
uniform float uDensity;
uniform float uPixelJitter;
uniform int   uEnableRipples;
uniform float uRippleSpeed;
uniform float uRippleThickness;
uniform float uRippleIntensity;
uniform float uEdgeFade;

uniform int   uShapeType;
const int SHAPE_SQUARE   = 0;
const int SHAPE_CIRCLE   = 1;
const int SHAPE_TRIANGLE = 2;
const int SHAPE_DIAMOND  = 3;

const int   MAX_CLICKS = 10;

uniform vec2  uClickPos  [MAX_CLICKS];
uniform float uClickTimes[MAX_CLICKS];

out vec4 fragColor;

float Bayer2(vec2 a) {
  a = floor(a);
  return fract(a.x / 2. + a.y * a.y * .75);
}
#define Bayer4(a) (Bayer2(.5*(a))*0.25 + Bayer2(a))
#define Bayer8(a) (Bayer4(.5*(a))*0.25 + Bayer2(a))

#define FBM_OCTAVES     5
#define FBM_LACUNARITY  1.25
#define FBM_GAIN        1.0

float hash11(float n){ return fract(sin(n)*43758.5453); }

float vnoise(vec3 p){
  vec3 ip = floor(p);
  vec3 fp = fract(p);
  float n000 = hash11(dot(ip + vec3(0.0,0.0,0.0), vec3(1.0,57.0,113.0)));
  float n100 = hash11(dot(ip + vec3(1.0,0.0,0.0), vec3(1.0,57.0,113.0)));
  float n010 = hash11(dot(ip + vec3(0.0,1.0,0.0), vec3(1.0,57.0,113.0)));
  float n110 = hash11(dot(ip + vec3(1.0,1.0,0.0), vec3(1.0,57.0,113.0)));
  float n001 = hash11(dot(ip + vec3(0.0,0.0,1.0), vec3(1.0,57.0,113.0)));
  float n101 = hash11(dot(ip + vec3(1.0,0.0,1.0), vec3(1.0,57.0,113.0)));
  float n011 = hash11(dot(ip + vec3(0.0,1.0,1.0), vec3(1.0,57.0,113.0)));
  float n111 = hash11(dot(ip + vec3(1.0,1.0,1.0), vec3(1.0,57.0,113.0)));
  vec3 w = fp*fp*fp*(fp*(fp*6.0-15.0)+10.0);
  float x00 = mix(n000, n100, w.x);
  float x10 = mix(n010, n110, w.x);
  float x01 = mix(n001, n101, w.x);
  float x11 = mix(n011, n111, w.x);
  float y0  = mix(x00, x10, w.y);
  float y1  = mix(x01, x11, w.y);
  return mix(y0, y1, w.z) * 2.0 - 1.0;
}

float fbm2(vec2 uv, float t){
  vec3 p = vec3(uv * uScale, t);
  float amp = 1.0;
  float freq = 1.0;
  float sum = 1.0;
  for (int i = 0; i < FBM_OCTAVES; ++i){
    sum  += amp * vnoise(p * freq);
    freq *= FBM_LACUNARITY;
    amp  *= FBM_GAIN;
  }
  return sum * 0.5 + 0.5;
}

float maskCircle(vec2 p, float cov){
  float r = sqrt(cov) * .25;
  float d = length(p - 0.5) - r;
  float aa = 0.5 * fwidth(d);
  return cov * (1.0 - smoothstep(-aa, aa, d * 2.0));
}

float maskTriangle(vec2 p, vec2 id, float cov){
  bool flip = mod(id.x + id.y, 2.0) > 0.5;
  if (flip) p.x = 1.0 - p.x;
  float r = sqrt(cov);
  float d  = p.y - r*(1.0 - p.x);
  float aa = fwidth(d);
  return cov * clamp(0.5 - d/aa, 0.0, 1.0);
}

float maskDiamond(vec2 p, float cov){
  float r = sqrt(cov) * 0.564;
  return step(abs(p.x - 0.49) + abs(p.y - 0.49), r);
}

void main(){
  float pixelSize = uPixelSize;
  vec2 fragCoord = gl_FragCoord.xy - uResolution * .5;
  float aspectRatio = uResolution.x / uResolution.y;

  vec2 pixelId = floor(fragCoord / pixelSize);
  vec2 pixelUV = fract(fragCoord / pixelSize);

  float cellPixelSize = 8.0 * pixelSize;
  vec2 cellId = floor(fragCoord / cellPixelSize);
  vec2 cellCoord = cellId * cellPixelSize;
  vec2 uv = cellCoord / uResolution * vec2(aspectRatio, 1.0);

  float base = fbm2(uv, uTime * 0.05);
  base = base * 0.5 - 0.65;

  float feed = base + (uDensity - 0.5) * 0.3;

  float speed     = uRippleSpeed;
  float thickness = uRippleThickness;
  const float dampT     = 1.0;
  const float dampR     = 10.0;

  if (uEnableRipples == 1) {
    for (int i = 0; i < MAX_CLICKS; ++i){
      vec2 pos = uClickPos[i];
      if (pos.x < 0.0) continue;
      float cellPixelSize = 8.0 * pixelSize;
      vec2 cuv = (((pos - uResolution * .5 - cellPixelSize * .5) / (uResolution))) * vec2(aspectRatio, 1.0);
      float t = max(uTime - uClickTimes[i], 0.0);
      float r = distance(uv, cuv);
      float waveR = speed * t;
      float ring  = exp(-pow((r - waveR) / thickness, 2.0));
      float atten = exp(-dampT * t) * exp(-dampR * r);
      feed = max(feed, ring * atten * uRippleIntensity);
    }
  }

  float bayer = Bayer8(fragCoord / uPixelSize) - 0.5;
  float bw = step(0.5, feed + bayer);

  float h = fract(sin(dot(floor(fragCoord / uPixelSize), vec2(127.1, 311.7))) * 43758.5453);
  float jitterScale = 1.0 + (h - 0.5) * uPixelJitter;
  float coverage = bw * jitterScale;
  float M;
  if      (uShapeType == SHAPE_CIRCLE)   M = maskCircle (pixelUV, coverage);
  else if (uShapeType == SHAPE_TRIANGLE) M = maskTriangle(pixelUV, pixelId, coverage);
  else if (uShapeType == SHAPE_DIAMOND)  M = maskDiamond(pixelUV, coverage);
  else                                   M = coverage;

  if (uEdgeFade > 0.0) {
    vec2 norm = gl_FragCoord.xy / uResolution;
    float edge = min(min(norm.x, norm.y), min(1.0 - norm.x, 1.0 - norm.y));
    float fade = smoothstep(0.0, uEdgeFade, edge);
    M *= fade;
  }

  vec3 color = uColor;
  vec3 srgbColor = mix(
    color * 12.92,
    1.055 * pow(color, vec3(1.0 / 2.4)) - 0.055,
    step(0.0031308, color)
  );

  fragColor = vec4(srgbColor, M);
}
`;

/**
 * Mount the field in `container` and start it. Returns a function that stops it and frees
 * the GPU resources.
 *
 * @param {HTMLElement} container  sized by the page; the canvas fills it
 * @param {object} [o]
 * @param {HTMLElement} [o.clickTarget]  element whose clicks send ripples (default: container)
 */
export function pixelBlast(container, o = {}) {
  const opt = {
    variant: 'square', pixelSize: 3, color: '#B497CF', antialias: true,
    patternScale: 2, patternDensity: 1, pixelSizeJitter: 0,
    enableRipples: true, rippleIntensityScale: 1, rippleThickness: 0.1, rippleSpeed: 0.3,
    speed: 0.5, edgeFade: 0.5, clickTarget: container, ...o,
  };

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: opt.antialias, alpha: true, powerPreference: 'high-performance' });
  } catch {
    return () => {};   // no WebGL: the hero's own background shows instead
  }
  const canvas = renderer.domElement;
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.display = 'block';
  canvas.setAttribute('aria-hidden', 'true');
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearAlpha(0);
  container.appendChild(canvas);

  const uniforms = {
    uResolution: { value: new THREE.Vector2(0, 0) },
    uTime: { value: 0 },
    uColor: { value: new THREE.Color(opt.color) },
    uClickPos: { value: Array.from({ length: MAX_CLICKS }, () => new THREE.Vector2(-1, -1)) },
    uClickTimes: { value: new Float32Array(MAX_CLICKS) },
    uShapeType: { value: SHAPES[opt.variant] ?? 0 },
    uPixelSize: { value: opt.pixelSize * renderer.getPixelRatio() },
    uScale: { value: opt.patternScale },
    uDensity: { value: opt.patternDensity },
    uPixelJitter: { value: opt.pixelSizeJitter },
    uEnableRipples: { value: opt.enableRipples ? 1 : 0 },
    uRippleSpeed: { value: opt.rippleSpeed },
    uRippleThickness: { value: opt.rippleThickness },
    uRippleIntensity: { value: opt.rippleIntensityScale },
    uEdgeFade: { value: opt.edgeFade },
  };

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX, fragmentShader: FRAGMENT, uniforms,
    transparent: true, depthTest: false, depthWrite: false, glslVersion: THREE.GLSL3,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  scene.add(quad);

  const setSize = () => {
    renderer.setSize(container.clientWidth || 1, container.clientHeight || 1, false);
    uniforms.uResolution.value.set(canvas.width, canvas.height);
    uniforms.uPixelSize.value = opt.pixelSize * renderer.getPixelRatio();
    if (still) renderer.render(scene, camera);
  };

  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const clock = new THREE.Clock();
  const timeOffset = (crypto.getRandomValues(new Uint32Array(1))[0] / 0xffffffff) * 1000;
  let clickIx = 0;

  // Ripples come from clicks anywhere on the click target, not just bare canvas, so text
  // and buttons sitting over the field do not swallow them.
  const onDown = (e) => {
    const r = canvas.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
    const fx = (e.clientX - r.left) * (canvas.width / r.width);
    const fy = (r.height - (e.clientY - r.top)) * (canvas.height / r.height);
    uniforms.uClickPos.value[clickIx].set(fx, fy);
    uniforms.uClickTimes.value[clickIx] = uniforms.uTime.value;
    clickIx = (clickIx + 1) % MAX_CLICKS;
  };
  if (opt.enableRipples && !still) opt.clickTarget.addEventListener('pointerdown', onDown, { passive: true });

  const ro = new ResizeObserver(setSize);
  ro.observe(container);
  setSize();

  let raf = 0;
  let visible = true;
  const io = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible && !raf && !still) raf = requestAnimationFrame(frame);
  });
  io.observe(container);

  function frame() {
    raf = 0;
    if (!visible) return;
    uniforms.uTime.value = timeOffset + clock.getElapsedTime() * opt.speed;
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }

  if (still) {
    uniforms.uTime.value = timeOffset;
    renderer.render(scene, camera);
  } else {
    raf = requestAnimationFrame(frame);
  }

  return () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
    io.disconnect();
    opt.clickTarget.removeEventListener('pointerdown', onDown);
    quad.geometry.dispose();
    material.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    canvas.remove();
  };
}
