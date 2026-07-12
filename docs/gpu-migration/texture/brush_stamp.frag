#version 300 es
precision highp float;

// brush_stamp.frag — TEXTURE-PARITY build.
//
// Replaces the procedural (hash/fbm/Worley) brush-mode noise with sampling the
// SAME precomputed noise field the CPU uses (uploaded as u_brushTexture) plus
// the real paper-height field (u_paper), and applies the CPU's exact
// deposit-factor math. The per-cell math below is a line-for-line
// transliteration of brush-texture-deposit.js, which texture-parity.test.mjs
// proves matches the CPU lib to < 1e-4 per cell.
//
// NEEDS A GPU TO VALIDATE: the math is verified in JS; this GLSL transliteration
// still needs a WebGL2 context to confirm it compiles and runs identically.

uniform sampler2D u_fluid;      // (u, v, pressure, wet)
uniform sampler2D u_pigment;    // (g0, g1, g2, 0)
uniform sampler2D u_deposit;    // (d0, d1, d2, mask)
uniform vec2 u_texelSize;       // (1/GW, 1/GH)
uniform float u_maxPigment;     // 1.0

// NEW: the active mode's precomputed noise field (R channel, grid-resolution,
// uploaded by the lib via setBrushTexture) and the paper-height field (R).
uniform sampler2D u_brushTexture;
uniform sampler2D u_paper;

const int MAX_STAMPS = 32;
uniform int u_stampCount;
uniform vec4 u_stampPosRad[MAX_STAMPS];   // (cx, cy, radius, strength)
uniform vec4 u_stampParams[MAX_STAMPS];   // (pigmentIdx, wetAmount, pressureAmount, type)
uniform vec3 u_rainbowWeights;

// Brush-mode controls (same knobs the lib already passes via setBrushMode):
// u_brushMode: 0=wet, 1=crayon, 2=dryBrush, 3=salt, 4=splatter
uniform int   u_brushMode;
uniform float u_dryness;      // _drynessAmount   (amount)
uniform float u_paperReject;  // _dryPaperReject
uniform float u_anisotropy;   // _dryAnisotropy
uniform float u_bristleSkip;  // _dryBrushSkip
uniform vec2  u_motionDir;    // unit stroke direction (zero on first stamp)

layout(location = 0) out vec4 out_pigment;
layout(location = 1) out vec4 out_deposit;
layout(location = 2) out vec4 out_fluid;

void main() {
  vec2 uv = gl_FragCoord.xy * u_texelSize;
  vec2 pos = gl_FragCoord.xy;

  vec4 fluid = texture(u_fluid, uv);
  vec4 pig = texture(u_pigment, uv);
  vec4 dep = texture(u_deposit, uv);

  vec3 g_val = pig.rgb;
  vec3 d_val = dep.rgb;
  float maskVal = dep.a;
  float wet = fluid.w;
  float pressure = fluid.z;
  float vel_u = fluid.x;
  float vel_v = fluid.y;

  // ── Per-mode constants, identical to brush-texture-deposit.js modeConstants ──
  float amount      = u_dryness;
  float baseThresh  = 0.5;
  float bandHalf    = 0.05;
  float paperWeight = 0.0;
  float anisoMul    = 0.0;
  float waterMult   = 1.0;
  if (u_brushMode == 1) {        // crayon
    baseThresh = 0.4 + 0.25 * u_paperReject; bandHalf = 0.05; paperWeight = 0.55; anisoMul = 6.0;  waterMult = 1.0 - amount * 0.85;
  } else if (u_brushMode == 2) { // dryBrush
    baseThresh = 0.4 + 0.25 * u_paperReject; bandHalf = 0.03; paperWeight = 0.25; anisoMul = 12.0; waterMult = 1.0 - amount * 0.85;
  } else if (u_brushMode == 3) { // salt
    baseThresh = 0.75; bandHalf = 0.12; paperWeight = 0.0; anisoMul = 0.0; waterMult = 1.0 - amount * 0.3;
  } else if (u_brushMode == 4) { // splatter
    baseThresh = 0.70; bandHalf = 0.02; paperWeight = 0.0; anisoMul = 0.0; waterMult = 1.0 - amount * 0.5;
  }
  float bristleK = amount * u_bristleSkip;
  float anisoK   = amount * u_anisotropy * anisoMul;

  for (int s = 0; s < MAX_STAMPS; s++) {
    if (s >= u_stampCount) break;

    vec4 posRad = u_stampPosRad[s];
    vec4 params = u_stampParams[s];
    float cx = posRad.x, cy = posRad.y, radius = posRad.z, strength = posRad.w;
    int brushType = int(params.w);
    float wetAmount = params.y, pressureAmount = params.z;

    float dx = pos.x - cx, dy = pos.y - cy;
    float d2 = dx * dx + dy * dy;
    float r2 = radius * radius;
    if (d2 >= r2) continue;

    float dist = sqrt(d2);
    float falloff = 1.0 - dist / radius;
    float f2 = falloff * falloff;

    if (maskVal > 0.1 && brushType != 3) continue;

    if (brushType == 0) {
      int pigIdx = int(params.x);
      vec3 weights = vec3(0.0);
      if (pigIdx == 0) weights.x = 1.0;
      else if (pigIdx == 1) weights.y = 1.0;
      else if (pigIdx == 2) weights.z = 1.0;
      else if (pigIdx == 3) weights = u_rainbowWeights;

      // ── deposit factor — transliteration of depositFactor() (verified) ──
      float depositFactor = 1.0;
      if (u_brushMode > 0 && amount > 0.0) {
        float fn = texture(u_brushTexture, uv).r;   // SAME field as CPU
        float ph = texture(u_paper, uv).r;
        float combined = fn * (1.0 - paperWeight) + ph * paperWeight;
        float thresh = 1.0 - amount * baseThresh;
        float lo = thresh - bandHalf;
        float hi = thresh + bandHalf;
        float skipMask;
        if (combined < lo) skipMask = 0.0;
        else if (combined > hi) skipMask = 1.0;
        else { float t = (combined - lo) / (bandHalf * 2.0); skipMask = t * t * (3.0 - 2.0 * t); }
        float totalReject = skipMask * (0.85 + 0.15 * bristleK);
        // anisotropy (dryBrush): paperH gradient projected on motion direction.
        // CPU uses paperH[i±1]/[i±GW] (a 2-cell central difference, no /2).
        if (anisoK > 0.0 && (u_motionDir.x != 0.0 || u_motionDir.y != 0.0)) {
          float hxp = texture(u_paper, uv + vec2(u_texelSize.x, 0.0)).r;
          float hxm = texture(u_paper, uv - vec2(u_texelSize.x, 0.0)).r;
          float hyp = texture(u_paper, uv + vec2(0.0, u_texelSize.y)).r;
          float hym = texture(u_paper, uv - vec2(0.0, u_texelSize.y)).r;
          float proj = (hxp - hxm) * u_motionDir.x + (hyp - hym) * u_motionDir.y;
          if (proj > 0.0) totalReject = min(1.0, totalReject + proj * anisoK);
        }
        totalReject = min(totalReject, 1.0);
        depositFactor = 1.0 - totalReject;
      }

      // NOTE: the procedural build's per-stamp deposit cap (mix(0.40,0.12,dryness))
      // is intentionally REMOVED — it compensated for procedural noise not matching
      // CPU pacing. With the real field + factor it would diverge from the CPU.
      vec3 deposit = weights * falloff * strength * depositFactor;
      g_val = min(g_val + deposit, vec3(u_maxPigment));
      d_val = min(d_val + deposit * 0.5, vec3(u_maxPigment));

      // Wet/pressure scaled by mode water multiplier and gated by the factor,
      // matching the CPU's effPigWetGain * depositFactor intent.
      float wetGate = (u_brushMode > 0) ? depositFactor : 1.0;
      float wMul    = (u_brushMode > 0) ? waterMult : 1.0;
      wet = max(wet, f2 * wetAmount * wMul * wetGate);
      pressure += f2 * pressureAmount * wMul * wetGate;

    } else if (brushType == 1) {
      wet = max(wet, f2 * wetAmount);
      pressure += f2 * pressureAmount;
      float liftStr = f2 * strength * 0.18;
      vec3 lifted = min(d_val, vec3(liftStr));
      d_val -= lifted; g_val += lifted;
    } else if (brushType == 2) {
      float sub = f2 * strength;
      g_val *= (1.0 - sub); d_val *= (1.0 - sub);
    } else if (brushType == 3) {
      maskVal = min(maskVal + falloff * strength, 1.0);
    } else if (brushType == 4) {
      float clear = f2 * strength;
      g_val *= (1.0 - clear); d_val *= (1.0 - clear);
      wet = max(wet, f2 * 0.3);
    }
  }

  out_pigment = vec4(g_val, 0.0);
  out_deposit = vec4(d_val, maskVal);
  out_fluid = vec4(vel_u, vel_v, pressure, wet);
}
