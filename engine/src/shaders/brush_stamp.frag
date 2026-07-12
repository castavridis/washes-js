#version 300 es
precision highp float;

// brush_stamp.frag — TEXTURE-PARITY build (matches lib v1.0).
//
// Samples the SAME precomputed noise field the CPU uses (u_brushTexture) and
// the real paper field (u_paper), and applies the v1.0 deposit-multiplier math.
// The per-cell math is a transliteration of brush-texture-deposit.js, which
// texture-parity.test.mjs proves matches the v1.0 CPU lib to < 1e-4 per cell.
//
// NEEDS A GPU TO VALIDATE compile/run; the math itself is verified in JS.

uniform sampler2D u_fluid;
uniform sampler2D u_pigment;
uniform sampler2D u_deposit;
uniform vec2 u_texelSize;       // (1/GW, 1/GH)
uniform float u_maxPigment;

uniform sampler2D u_brushTexture;  // active mode's noise field (R), grid-res
uniform sampler2D u_paper;         // paper height (R) — already on the GPU

const int MAX_STAMPS = 32;
uniform int u_stampCount;
uniform vec4 u_stampPosRad[MAX_STAMPS];
uniform vec4 u_stampParams[MAX_STAMPS];
uniform vec3 u_rainbowWeights;

uniform int   u_brushMode;     // 0=wet,1=crayon,2=dryBrush,3=salt,4=splatter
uniform float u_dryness;
uniform float u_paperReject;
uniform float u_anisotropy;
uniform float u_bristleSkip;
uniform vec2  u_motionDir;

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

  // ── v1.0 per-mode constants (identical to modeConstants) ──
  float baseThresh = 0.5, bandHalf = 0.05, paperWeight = 0.0, anisoMul = 0.0, waterMult = 1.0;
  if (u_brushMode == 1) {        baseThresh = 0.4 + 0.25 * u_paperReject; bandHalf = 0.10; paperWeight = 0.55; anisoMul = 6.0;  waterMult = 1.0 - u_dryness * 0.85; }
  else if (u_brushMode == 2) {   baseThresh = 0.4 + 0.25 * u_paperReject; bandHalf = 0.06; paperWeight = 0.25; anisoMul = 12.0; waterMult = 1.0 - u_dryness * 0.85; }
  else if (u_brushMode == 3) {   baseThresh = 0.75; bandHalf = 0.12; paperWeight = 0.0; anisoMul = 0.0; waterMult = 1.0 - u_dryness * 0.3; }
  else if (u_brushMode == 4) {   baseThresh = 0.70; bandHalf = 0.03; paperWeight = 0.0; anisoMul = 0.0; waterMult = 1.0 - u_dryness * 0.5; }
  float anisoK   = u_dryness * u_anisotropy * anisoMul;
  float bristleK = u_dryness * u_bristleSkip;
  // Cell index for the per-index bristle hash (matches CPU i = py*GW + px).
  int gw = int(0.5 + 1.0 / u_texelSize.x);
  uint cellIdx = uint(int(gl_FragCoord.y) * gw + int(gl_FragCoord.x));

  for (int s = 0; s < MAX_STAMPS; s++) {
    if (s >= u_stampCount) break;
    vec4 posRad = u_stampPosRad[s];
    vec4 params = u_stampParams[s];
    float cx = posRad.x, cy = posRad.y, radius = posRad.z, strength = posRad.w;
    int brushType = int(params.w);
    float wetAmount = params.y, pressureAmount = params.z;

    float dx = pos.x - cx, dy = pos.y - cy;
    float d2 = dx * dx + dy * dy;
    if (d2 >= radius * radius) continue;
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

      // ── v1.0 textureMul — transliteration of textureMul() (verified) ──
      float textureMul = 1.0;
      if (u_brushMode > 0) {
        float nval = texture(u_brushTexture, uv).r;            // SAME field as CPU
        if (paperWeight > 0.0) nval = nval * (1.0 - paperWeight) + texture(u_paper, uv).r * paperWeight;
        if (anisoK != 0.0 && (u_motionDir.x != 0.0 || u_motionDir.y != 0.0)) {
          float rInv = 1.0 / radius;
          float align = (dx * rInv) * u_motionDir.x + (dy * rInv) * u_motionDir.y;
          nval += anisoK * align * 0.05;
        }
        float lo = baseThresh - bandHalf;
        float hi = baseThresh + bandHalf;
        float t = (nval - lo) / max(1e-6, hi - lo);
        textureMul = t <= 0.0 ? 0.0 : t >= 1.0 ? 1.0 : t * t * (3.0 - 2.0 * t);
        if (bristleK > 0.0) {
          float r1 = float((cellIdx * 2654435761u) & 0xFFFFu) / 65535.0;  // matches CPU
          if (r1 < bristleK) textureMul = 0.0;
        }
        if (textureMul <= 0.0) continue;
      }

      vec3 deposit = weights * falloff * strength * textureMul;
      g_val = min(g_val + deposit, vec3(u_maxPigment));
      d_val = min(d_val + deposit * 0.5, vec3(u_maxPigment));
      float wMul = (u_brushMode > 0) ? waterMult : 1.0;
      float gate = (u_brushMode > 0) ? textureMul : 1.0;
      wet = max(wet, f2 * wetAmount * wMul * gate);
      pressure += f2 * pressureAmount * wMul * gate;

    } else if (brushType == 1) {
      wet = max(wet, f2 * wetAmount); pressure += f2 * pressureAmount;
      float liftStr = f2 * strength * 0.18;
      vec3 lifted = min(d_val, vec3(liftStr));
      d_val -= lifted; g_val += lifted;
    } else if (brushType == 2) {
      float sub = f2 * strength; g_val *= (1.0 - sub); d_val *= (1.0 - sub);
    } else if (brushType == 3) {
      maskVal = min(maskVal + falloff * strength, 1.0);
    } else if (brushType == 4) {
      float clear = f2 * strength; g_val *= (1.0 - clear); d_val *= (1.0 - clear);
      wet = max(wet, f2 * 0.3);
    }
  }

  out_pigment = vec4(g_val, 0.0);
  out_deposit = vec4(d_val, maskVal);
  out_fluid = vec4(vel_u, vel_v, pressure, wet);
}
