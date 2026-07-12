// ============================================================
// Washes GPU Sim v0.98.0 — compiled from washes-gpu-sim.ts.
// Loaded via classic <script src> (works under file:// without CORS).
// Sets window.WashesGpuSim = { initGpuSim, version }.
// Sanity check after loading: WashesGpuSim.version → '0.98.0'.
// ============================================================
(function () {
"use strict";

// ─── Shader sources (inlined, was ?raw imports) ─────────────────────────────
const fullscreenVert = "#version 300 es\n// Fullscreen triangle from gl_VertexID \u2014 no vertex buffer needed.\n// Covers [-1,1]\u00b2 with a single oversized triangle.\nvoid main() {\n  float x = float((gl_VertexID & 1) << 2) - 1.0;\n  float y = float((gl_VertexID & 2) << 1) - 1.0;\n  gl_Position = vec4(x, y, 0.0, 1.0);\n}\n";
const diffuseWetFrag = "#version 300 es\nprecision highp float;\n\n// Wet diffusion: 4-neighbor Laplacian on wet channel.\n// Reads fluid_A, writes fluid_B with diffused wet.\n\nuniform sampler2D u_fluid;      // (u, v, pressure, wet)\nuniform sampler2D u_deposit;    // (.a = mask)\nuniform vec2 u_texelSize;       // (1/GW, 1/GH)\nuniform float u_wetDiffusion;   // WET_DIFFUSION coefficient\nuniform int u_maskActive;\n\nout vec4 fragColor;\n\nvoid main() {\n  vec2 uv = gl_FragCoord.xy * u_texelSize;\n  vec4 c = texture(u_fluid, uv);\n\n  // Boundary cells (first/last row/col) pass through unchanged\n  vec2 pos = gl_FragCoord.xy;\n  vec2 gridSize = 1.0 / u_texelSize;\n  if (pos.x < 1.5 || pos.x > gridSize.x - 1.5 ||\n      pos.y < 1.5 || pos.y > gridSize.y - 1.5) {\n    fragColor = c;\n    return;\n  }\n\n  // Mask check\n  if (u_maskActive != 0) {\n    float maskVal = texture(u_deposit, uv).a;\n    if (maskVal > 0.1) {\n      fragColor = c;\n      return;\n    }\n  }\n\n  float wet_c = c.w;\n  float wet_l = texture(u_fluid, uv + vec2(-u_texelSize.x, 0.0)).w;\n  float wet_r = texture(u_fluid, uv + vec2( u_texelSize.x, 0.0)).w;\n  float wet_u = texture(u_fluid, uv + vec2(0.0,  u_texelSize.y)).w;\n  float wet_d = texture(u_fluid, uv + vec2(0.0, -u_texelSize.y)).w;\n\n  // Skip cells with no wet in the stencil\n  if (wet_c < 1e-6 && wet_l < 1e-6 && wet_r < 1e-6 && wet_u < 1e-6 && wet_d < 1e-6) {\n    fragColor = c;\n    return;\n  }\n\n  float newWet = wet_c + u_wetDiffusion * (wet_l + wet_r + wet_u + wet_d - 4.0 * wet_c);\n  fragColor = vec4(c.xyz, newWet);\n}\n";
const binarizeEdgeFrag = "#version 300 es\nprecision highp float;\n\n// Binarize wet channel for edge darkening.\n// Output: 1.0 where wet > threshold, 0.0 otherwise.\n\nuniform sampler2D u_fluid;      // (u, v, pressure, wet)\nuniform vec2 u_texelSize;       // (1/GW, 1/GH)\n\nout vec4 fragColor;\n\nvoid main() {\n  vec2 uv = gl_FragCoord.xy * u_texelSize;\n  float wet = texture(u_fluid, uv).w;\n  float binary = wet > 0.04 ? 1.0 : 0.0;\n  fragColor = vec4(binary, 0.0, 0.0, 0.0);\n}\n";
const blurHFrag = "#version 300 es\nprecision highp float;\n\n// Horizontal separable box blur.\n// Reads from source texture .r channel, writes blurred value.\n\nuniform sampler2D u_source;\nuniform vec2 u_texelSize;   // (1/GW, 1/GH)\nuniform int u_radius;\n\nout vec4 fragColor;\n\nvoid main() {\n  vec2 uv = gl_FragCoord.xy * u_texelSize;\n  float sum = 0.0;\n  int r = u_radius;\n  float count = float(2 * r + 1);\n\n  for (int i = -r; i <= r; i++) {\n    vec2 sampleUV = uv + vec2(float(i) * u_texelSize.x, 0.0);\n    // Clamp to [0,1] for boundary handling\n    sampleUV.x = clamp(sampleUV.x, 0.0, 1.0);\n    sum += texture(u_source, sampleUV).r;\n  }\n\n  fragColor = vec4(sum / count, 0.0, 0.0, 0.0);\n}\n";
const blurVFrag = "#version 300 es\nprecision highp float;\n\n// Vertical separable box blur.\n// Reads from source texture .r channel, writes blurred value.\n\nuniform sampler2D u_source;\nuniform vec2 u_texelSize;   // (1/GW, 1/GH)\nuniform int u_radius;\n\nout vec4 fragColor;\n\nvoid main() {\n  vec2 uv = gl_FragCoord.xy * u_texelSize;\n  float sum = 0.0;\n  int r = u_radius;\n  float count = float(2 * r + 1);\n\n  for (int i = -r; i <= r; i++) {\n    vec2 sampleUV = uv + vec2(0.0, float(i) * u_texelSize.y);\n    // Clamp to [0,1] for boundary handling\n    sampleUV.y = clamp(sampleUV.y, 0.0, 1.0);\n    sum += texture(u_source, sampleUV).r;\n  }\n\n  fragColor = vec4(sum / count, 0.0, 0.0, 0.0);\n}\n";
const edgeApplyFrag = "#version 300 es\nprecision highp float;\n\n// Edge darkening: apply pressure reduction at wet boundaries.\n// Reads blurred wet (small + large kernel), fluid state.\n// Writes modified fluid with reduced pressure at wet edges.\n\nuniform sampler2D u_fluid;          // (u, v, pressure, wet)\nuniform sampler2D u_blurSmall;      // small-kernel blur of binary wet\nuniform sampler2D u_blurLarge;      // large-kernel blur of binary wet\nuniform sampler2D u_deposit;        // (.a = mask)\nuniform vec2 u_texelSize;\nuniform float u_edgeEta;            // EDGE_ETA = 0.045\nuniform float u_edgeWetActive;      // 0.40\nuniform float u_edgeWetOff;         // 0.10\nuniform int u_maskActive;\n\nout vec4 fragColor;\n\nvoid main() {\n  vec2 uv = gl_FragCoord.xy * u_texelSize;\n  vec4 fluid = texture(u_fluid, uv);\n\n  // Mask check\n  if (u_maskActive != 0) {\n    float maskVal = texture(u_deposit, uv).a;\n    if (maskVal > 0.1) {\n      fragColor = fluid;\n      return;\n    }\n  }\n\n  float wet = fluid.w;\n  float pressure = fluid.z;\n\n  if (wet > 0.04) {\n    float blurS = texture(u_blurSmall, uv).r;\n    float deficit = 1.0 - blurS;\n\n    if (deficit > 0.0) {\n      float blurL = texture(u_blurLarge, uv).r;\n\n      // Smooth activation ramp\n      float activeRange = u_edgeWetActive - u_edgeWetOff;\n      float activation = wet >= u_edgeWetActive ? 1.0\n                       : wet <= u_edgeWetOff    ? 0.0\n                       : (wet - u_edgeWetOff) / activeRange;\n\n      pressure -= u_edgeEta * deficit * blurL * wet * activation;\n    }\n  }\n\n  fragColor = vec4(fluid.xy, pressure, wet);\n}\n";
const updateVelocityFrag = "#version 300 es\nprecision highp float;\n\n// Velocity update: pressure gradient + paper tilt + viscosity + drag + gravity.\n// Reads fluid_A (u, v, pressure, wet) + paper (paperH).\n// Writes fluid_B (u_new, v_new, pressure * decay, wet).\n\nuniform sampler2D u_fluid;      // (u, v, pressure, wet)\nuniform sampler2D u_paper;      // (paperH, 0, 0, 0)\nuniform sampler2D u_deposit;    // (.a = mask)\nuniform vec2 u_texelSize;       // (1/GW, 1/GH)\nuniform float u_DT;             // 0.42\nuniform float u_viscosity;      // 0.10\nuniform float u_drag;           // 0.014\nuniform float u_paperTilt;      // 0.06\nuniform float u_velClamp;       // VEL_CLAMP\nuniform float u_pressureDecay;  // 0.94\nuniform int u_maskActive;\n\n// Gravity\nuniform int u_gravityMode;      // 0=none, 1=fixed, 2=radial, 3=radial-in\nuniform vec2 u_gravityBias;     // (biasX, biasY) for fixed mode\nuniform float u_gravityStrength;\nuniform vec2 u_gridCenter;      // ((GW-1)/2, (GH-1)/2)\n\n// Edge boundary\nuniform int u_edgeOpenLeft;\nuniform int u_edgeOpenRight;\nuniform int u_edgeOpenTop;\nuniform int u_edgeOpenBottom;\n\nout vec4 fragColor;\n\nvoid main() {\n  vec2 uv = gl_FragCoord.xy * u_texelSize;\n  vec2 pos = gl_FragCoord.xy;\n  vec2 gridSize = 1.0 / u_texelSize;\n\n  vec4 c = texture(u_fluid, uv);\n  float pressure_c = c.z;\n  float wet_c = c.w;\n\n  // Boundary cells: zero velocity, pass through\n  if (pos.x < 1.5 || pos.x > gridSize.x - 1.5 ||\n      pos.y < 1.5 || pos.y > gridSize.y - 1.5) {\n    fragColor = vec4(0.0, 0.0, pressure_c * u_pressureDecay, wet_c);\n    return;\n  }\n\n  // Mask check\n  if (u_maskActive != 0) {\n    float maskVal = texture(u_deposit, uv).a;\n    if (maskVal > 0.1) {\n      fragColor = vec4(0.0, 0.0, pressure_c * u_pressureDecay, wet_c);\n      return;\n    }\n  }\n\n  // Dry cells: no flow\n  if (wet_c < 0.04) {\n    fragColor = vec4(0.0, 0.0, pressure_c * u_pressureDecay, wet_c);\n    return;\n  }\n\n  // Sample neighbors\n  vec2 dx = vec2(u_texelSize.x, 0.0);\n  vec2 dy = vec2(0.0, u_texelSize.y);\n\n  vec4 fL = texture(u_fluid, uv - dx);\n  vec4 fR = texture(u_fluid, uv + dx);\n  vec4 fU = texture(u_fluid, uv + dy);\n  vec4 fD = texture(u_fluid, uv - dy);\n\n  // Pressure gradient (matches CPU: dpdy = pressure[i+GW] - pressure[i-GW])\n  // uv+dy = texture row above = CPU y+1 = one row DOWN on screen\n  float dpdx = fR.z - fL.z;\n  float dpdy = fU.z - fD.z;\n\n  // Paper slope\n  float hL = texture(u_paper, uv - dx).r;\n  float hR = texture(u_paper, uv + dx).r;\n  float hU = texture(u_paper, uv + dy).r;\n  float hD = texture(u_paper, uv - dy).r;\n  float dhdx = hR - hL;\n  float dhdy = hU - hD;\n\n  // Viscous diffusion (Laplacian of velocity)\n  float lapU = fL.x + fR.x + fU.x + fD.x - 4.0 * c.x;\n  float lapV = fL.y + fR.y + fU.y + fD.y - 4.0 * c.y;\n\n  float nu = c.x + u_DT * (-dpdx * 0.5 - dhdx * u_paperTilt + u_viscosity * lapU - u_drag * c.x);\n  float nv = c.y + u_DT * (-dpdy * 0.5 - dhdy * u_paperTilt + u_viscosity * lapV - u_drag * c.y);\n\n  // Gravity bias\n  if (u_gravityMode == 1) {\n    // Fixed direction\n    nu += u_gravityBias.x;\n    nv += u_gravityBias.y;\n  } else if (u_gravityMode == 2 || u_gravityMode == 3) {\n    // Radial (2=outward, 3=inward)\n    vec2 r = pos - u_gridCenter;\n    float rmag = length(r);\n    if (rmag > 0.001) {\n      float sign = u_gravityMode == 3 ? -1.0 : 1.0;\n      float radialBias = sign * u_gravityStrength * u_velClamp;\n      vec2 radialDir = r / rmag * radialBias;\n      nu += radialDir.x;\n      nv += radialDir.y;\n    }\n  }\n\n  // Magnitude clamp (circular envelope)\n  float mag = sqrt(nu * nu + nv * nv);\n  if (mag > u_velClamp) {\n    float s = u_velClamp / mag;\n    nu *= s;\n    nv *= s;\n  }\n\n  fragColor = vec4(nu, nv, pressure_c * u_pressureDecay, wet_c);\n}\n";
const advectSemilagFrag = "#version 300 es\nprecision highp float;\n\n// Semi-Lagrangian advection with mass-conserving divergence correction.\n// Backward-traces each cell along velocity, bilinear-samples pigment.\n// Also applies isotropic pigment diffusion (Laplacian).\n\nuniform sampler2D u_fluid;      // (u, v, pressure, wet) \u2014 velocity source\nuniform sampler2D u_pigment;    // (g0, g1, g2, 0) \u2014 pigment to advect (LINEAR filtering)\nuniform sampler2D u_deposit;    // (.a = mask)\nuniform vec2 u_texelSize;       // (1/GW, 1/GH)\nuniform float u_adt;            // DT * 0.7 = advection timestep\nuniform float u_pigmentDiffusion; // PIGMENT_DIFFUSION coefficient\nuniform int u_maskActive;\n\n// Open boundary flags\nuniform int u_edgeOpenLeft;\nuniform int u_edgeOpenRight;\nuniform int u_edgeOpenTop;\nuniform int u_edgeOpenBottom;\n\nout vec4 fragColor;\n\n// v7 \u2014 Manual bilinear sample for portability. Hardware LINEAR filtering\n// on RGBA32F textures requires OES_texture_float_linear, which is not\n// universally available. Without it, texture() snaps to NEAREST and\n// produces stair-step artifacts in advection (sharp horizontal shelves\n// in gravity flow, etc.). Four texel-center NEAREST samples plus a\n// fract()-driven bilinear blend gives identical results everywhere.\n//\n// `p` is in grid-cell coordinates (e.g. (12.7, 8.3)) \u2014 same space as\n// gl_FragCoord.xy. Converts to UV internally.\nvec4 sampleBilinear(sampler2D tex, vec2 p, vec2 texel) {\n  // Move to texel-corner coordinates: subtract 0.5 because texel centers\n  // are at integer + 0.5 in pixel coords, and we want fract() relative\n  // to the corner so the weights are clean.\n  vec2 q = p - 0.5;\n  vec2 base = floor(q);\n  vec2 f = q - base;\n  // Four texel centers: (base, base+(1,0), base+(0,1), base+(1,1))\n  // Each in UV is (texel_center + integer_offset) * texelSize, but\n  // since texel_center = (base + 0.5) and we want a NEAREST sample\n  // at that center, the UV is exactly (base + 0.5) * texelSize.\n  vec2 c00 = (base + vec2(0.5, 0.5)) * texel;\n  vec2 c10 = (base + vec2(1.5, 0.5)) * texel;\n  vec2 c01 = (base + vec2(0.5, 1.5)) * texel;\n  vec2 c11 = (base + vec2(1.5, 1.5)) * texel;\n  vec4 s00 = texture(tex, c00);\n  vec4 s10 = texture(tex, c10);\n  vec4 s01 = texture(tex, c01);\n  vec4 s11 = texture(tex, c11);\n  vec4 sx0 = mix(s00, s10, f.x);\n  vec4 sx1 = mix(s01, s11, f.x);\n  return mix(sx0, sx1, f.y);\n}\n\nvoid main() {\n  vec2 uv = gl_FragCoord.xy * u_texelSize;\n  vec2 pos = gl_FragCoord.xy;\n  vec2 gridSize = 1.0 / u_texelSize;\n\n  // Boundary cells pass through\n  if (pos.x < 1.5 || pos.x > gridSize.x - 1.5 ||\n      pos.y < 1.5 || pos.y > gridSize.y - 1.5) {\n    fragColor = texture(u_pigment, uv);\n    return;\n  }\n\n  // Mask check\n  if (u_maskActive != 0) {\n    float maskVal = texture(u_deposit, uv).a;\n    if (maskVal > 0.1) {\n      fragColor = texture(u_pigment, uv);\n      return;\n    }\n  }\n\n  vec4 fluid = texture(u_fluid, uv);\n  float wet = fluid.w;\n\n  // Dry cells: no advection\n  if (wet < 0.04) {\n    fragColor = texture(u_pigment, uv);\n    return;\n  }\n\n  float ux = fluid.x;\n  float vy = fluid.y;\n\n  // Divergence for mass conservation (central difference)\n  vec2 dx = vec2(u_texelSize.x, 0.0);\n  vec2 dy = vec2(0.0, u_texelSize.y);\n  float uR = texture(u_fluid, uv + dx).x;\n  float uL = texture(u_fluid, uv - dx).x;\n  float vU = texture(u_fluid, uv + dy).y;\n  float vD = texture(u_fluid, uv - dy).y;\n  float div = (uR - uL) * 0.5 + (vU - vD) * 0.5;\n  float areaRatio = exp(-div * u_adt);\n\n  // Backward trace in grid coordinates (matches CPU: sy = y - vy * adt)\n  float sx = pos.x - ux * u_adt;\n  float sy = pos.y - vy * u_adt;\n\n  // Open boundary check: if trace goes off an open edge, zero pigment\n  bool offCanvas = false;\n  if (sx < 0.0) {\n    if (u_edgeOpenLeft != 0) offCanvas = true;\n    else sx = 0.0;\n  } else if (sx > gridSize.x - 1.001) {\n    if (u_edgeOpenRight != 0) offCanvas = true;\n    else sx = gridSize.x - 1.001;\n  }\n  if (sy < 0.0) {\n    if (u_edgeOpenTop != 0) offCanvas = true;\n    else sy = 0.0;\n  } else if (sy > gridSize.y - 1.001) {\n    if (u_edgeOpenBottom != 0) offCanvas = true;\n    else sy = gridSize.y - 1.001;\n  }\n\n  if (offCanvas) {\n    fragColor = vec4(0.0);\n    return;\n  }\n\n  // v7 \u2014 Manual bilinear (see sampleBilinear above). The previous code\n  // used hardware LINEAR filtering via texture(u_pigment, srcUV), which\n  // silently degraded to NEAREST on GPUs without OES_texture_float_linear,\n  // producing stair-step advection artifacts under gravity. Manual\n  // bilinear is deterministic across all platforms.\n  vec4 advected = sampleBilinear(u_pigment, vec2(sx, sy), u_texelSize) * areaRatio;\n\n  // Isotropic pigment diffusion (Laplacian)\n  vec4 pC = texture(u_pigment, uv);\n  vec4 pL = texture(u_pigment, uv - dx);\n  vec4 pR = texture(u_pigment, uv + dx);\n  vec4 pU = texture(u_pigment, uv + dy);\n  vec4 pD = texture(u_pigment, uv - dy);\n  vec4 laplacian = pL + pR + pU + pD - 4.0 * pC;\n  vec4 diffused = advected + u_pigmentDiffusion * laplacian;\n\n  fragColor = max(diffused, vec4(0.0));\n}\n";
const transferEvaporateFrag = "#version 300 es\nprecision highp float;\n\n// Fused pass: transferPigment + evaporate + drainBoundaries.\n// Per-cell (no neighbor reads except for drain boundary detection).\n// MRT output: 3 color attachments.\n\nuniform sampler2D u_fluid;      // (u, v, pressure, wet)\nuniform sampler2D u_pigment;    // (g0, g1, g2, 0)\nuniform sampler2D u_deposit;    // (d0, d1, d2, mask)\nuniform sampler2D u_paper;      // (paperH, 0, 0, 0)\nuniform vec2 u_texelSize;       // (1/GW, 1/GH)\nuniform int u_maskActive;\nuniform float u_evaporationRate;  // 0.9988\nuniform float u_maxPigment;       // 1.0\nuniform float u_drainAdt;         // DT * 0.7\n\n// Per-pigment constants (3 pigments)\nuniform vec3 u_density;         // (den0, den1, den2)\nuniform vec3 u_staining;        // (sta0, sta1, sta2)\nuniform vec3 u_granulation;     // (gra0, gra1, gra2)\n\n// Edge drain flags\nuniform int u_edgeOpenLeft;\nuniform int u_edgeOpenRight;\nuniform int u_edgeOpenTop;\nuniform int u_edgeOpenBottom;\n\nlayout(location = 0) out vec4 out_pigment;   // (g0', g1', g2', 0)\nlayout(location = 1) out vec4 out_deposit;   // (d0', d1', d2', mask)\nlayout(location = 2) out vec4 out_fluid;     // (u, v, pressure, wet')\n\nvoid main() {\n  vec2 uv = gl_FragCoord.xy * u_texelSize;\n  vec2 pos = gl_FragCoord.xy;\n  vec2 gridSize = 1.0 / u_texelSize;\n\n  vec4 fluid = texture(u_fluid, uv);\n  vec4 pig = texture(u_pigment, uv);\n  vec4 dep = texture(u_deposit, uv);\n  float paperH = texture(u_paper, uv).r;\n\n  float wet = fluid.w;\n  float pressure = fluid.z;\n  float vel_u = fluid.x;\n  float vel_v = fluid.y;\n  vec3 g_val = pig.rgb;\n  vec3 d_val = dep.rgb;\n  float maskVal = dep.a;\n\n  // Mask check \u2014 frozen cells pass through unchanged\n  if (u_maskActive != 0 && maskVal > 0.1) {\n    out_pigment = pig;\n    out_deposit = dep;\n    out_fluid = fluid;\n    return;\n  }\n\n  // --- Drain Boundaries ---\n  // Detect if this cell is on an open boundary edge and apply drain\n  float flux = 0.0;\n  bool isBoundary = false;\n\n  // Bottom edge (y == 1 in grid, pos.y ~1.5 in frag coords)\n  if (u_edgeOpenBottom != 0 && pos.y < 2.5 && pos.y >= 1.5) {\n    float outVel = -vel_v; // bottom edge: -v is outward (y=0 is bottom)\n    if (outVel > 0.0) {\n      flux = min(outVel * u_drainAdt, 1.0);\n      isBoundary = true;\n    }\n  }\n  // Top edge\n  if (u_edgeOpenTop != 0 && pos.y > gridSize.y - 2.5 && pos.y <= gridSize.y - 1.5) {\n    float outVel = vel_v; // top edge: +v is outward\n    if (outVel > 0.0) {\n      flux = min(outVel * u_drainAdt, 1.0);\n      isBoundary = true;\n    }\n  }\n  // Left edge\n  if (u_edgeOpenLeft != 0 && pos.x < 2.5 && pos.x >= 1.5) {\n    float outVel = -vel_u;\n    if (outVel > 0.0) {\n      flux = min(outVel * u_drainAdt, 1.0);\n      isBoundary = true;\n    }\n  }\n  // Right edge\n  if (u_edgeOpenRight != 0 && pos.x > gridSize.x - 2.5 && pos.x <= gridSize.x - 1.5) {\n    float outVel = vel_u;\n    if (outVel > 0.0) {\n      flux = min(outVel * u_drainAdt, 1.0);\n      isBoundary = true;\n    }\n  }\n\n  if (isBoundary) {\n    float retain = 1.0 - flux;\n    g_val *= retain;\n    d_val *= retain;\n    wet *= retain;\n    pressure *= retain;\n  }\n\n  // --- Transfer Pigment (only in wet cells) ---\n  if (wet >= 0.04) {\n    for (int k = 0; k < 3; k++) {\n      float gi = g_val[k];\n      float di = d_val[k];\n      float den = u_density[k];\n      float sta = u_staining[k];\n      float gra = u_granulation[k];\n\n      float hg = 1.0 - paperH * gra;\n      float hu = 1.0 + (paperH - 1.0) * gra;\n\n      float down = gi * hg * den;\n      float up = di * hu * den / sta;\n\n      down = max(down, 0.0);\n      up = max(up, 0.0);\n\n      // Cap so d doesn't exceed 1\n      if (di + down > 1.0) down = max(1.0 - di, 0.0);\n      if (gi + up > 1.0) up = max(1.0 - gi, 0.0);\n\n      d_val[k] = di + down - up;\n      g_val[k] = gi + up - down;\n    }\n  }\n\n  // --- Evaporate ---\n  wet *= u_evaporationRate;\n\n  // When cell goes dry, dump suspended pigment to deposited\n  if (wet < 0.025) {\n    for (int k = 0; k < 3; k++) {\n      float nd = d_val[k] + g_val[k];\n      d_val[k] = min(nd, u_maxPigment);\n      g_val[k] = 0.0;\n    }\n    wet = 0.0;\n    vel_u = 0.0;\n    vel_v = 0.0;\n  }\n\n  out_pigment = vec4(g_val, 0.0);\n  out_deposit = vec4(d_val, maskVal);\n  out_fluid = vec4(vel_u, vel_v, pressure, wet);\n}\n";
const brushStampFrag = "#version 300 es\nprecision highp float;\n\n// brush_stamp.frag \u2014 TEXTURE-PARITY build (matches lib v1.0).\n//\n// Samples the SAME precomputed noise field the CPU uses (u_brushTexture) and\n// the real paper field (u_paper), and applies the v1.0 deposit-multiplier math.\n// The per-cell math is a transliteration of brush-texture-deposit.js, which\n// texture-parity.test.mjs proves matches the v1.0 CPU lib to < 1e-4 per cell.\n//\n// NEEDS A GPU TO VALIDATE compile/run; the math itself is verified in JS.\n\nuniform sampler2D u_fluid;\nuniform sampler2D u_pigment;\nuniform sampler2D u_deposit;\nuniform vec2 u_texelSize;       // (1/GW, 1/GH)\nuniform float u_maxPigment;\n\nuniform sampler2D u_brushTexture;  // active mode's noise field (R), grid-res\nuniform sampler2D u_paper;         // paper height (R) \u2014 already on the GPU\n\nconst int MAX_STAMPS = 32;\nuniform int u_stampCount;\nuniform vec4 u_stampPosRad[MAX_STAMPS];\nuniform vec4 u_stampParams[MAX_STAMPS];\nuniform vec3 u_rainbowWeights;\n\nuniform int   u_brushMode;     // 0=wet,1=crayon,2=dryBrush,3=salt,4=splatter\nuniform float u_dryness;\nuniform float u_paperReject;\nuniform float u_anisotropy;\nuniform float u_bristleSkip;\nuniform vec2  u_motionDir;\n\nlayout(location = 0) out vec4 out_pigment;\nlayout(location = 1) out vec4 out_deposit;\nlayout(location = 2) out vec4 out_fluid;\n\nvoid main() {\n  vec2 uv = gl_FragCoord.xy * u_texelSize;\n  vec2 pos = gl_FragCoord.xy;\n\n  vec4 fluid = texture(u_fluid, uv);\n  vec4 pig = texture(u_pigment, uv);\n  vec4 dep = texture(u_deposit, uv);\n  vec3 g_val = pig.rgb;\n  vec3 d_val = dep.rgb;\n  float maskVal = dep.a;\n  float wet = fluid.w;\n  float pressure = fluid.z;\n  float vel_u = fluid.x;\n  float vel_v = fluid.y;\n\n  // \u2500\u2500 v1.0 per-mode constants (identical to modeConstants) \u2500\u2500\n  float baseThresh = 0.5, bandHalf = 0.05, paperWeight = 0.0, anisoMul = 0.0, waterMult = 1.0;\n  if (u_brushMode == 1) {        baseThresh = 0.4 + 0.25 * u_paperReject; bandHalf = 0.10; paperWeight = 0.55; anisoMul = 6.0;  waterMult = 1.0 - u_dryness * 0.85; }\n  else if (u_brushMode == 2) {   baseThresh = 0.4 + 0.25 * u_paperReject; bandHalf = 0.06; paperWeight = 0.25; anisoMul = 12.0; waterMult = 1.0 - u_dryness * 0.85; }\n  else if (u_brushMode == 3) {   baseThresh = 0.75; bandHalf = 0.12; paperWeight = 0.0; anisoMul = 0.0; waterMult = 1.0 - u_dryness * 0.3; }\n  else if (u_brushMode == 4) {   baseThresh = 0.70; bandHalf = 0.03; paperWeight = 0.0; anisoMul = 0.0; waterMult = 1.0 - u_dryness * 0.5; }\n  float anisoK   = u_dryness * u_anisotropy * anisoMul;\n  float bristleK = u_dryness * u_bristleSkip;\n  // Cell index for the per-index bristle hash (matches CPU i = py*GW + px).\n  int gw = int(0.5 + 1.0 / u_texelSize.x);\n  uint cellIdx = uint(int(gl_FragCoord.y) * gw + int(gl_FragCoord.x));\n\n  for (int s = 0; s < MAX_STAMPS; s++) {\n    if (s >= u_stampCount) break;\n    vec4 posRad = u_stampPosRad[s];\n    vec4 params = u_stampParams[s];\n    float cx = posRad.x, cy = posRad.y, radius = posRad.z, strength = posRad.w;\n    int brushType = int(params.w);\n    float wetAmount = params.y, pressureAmount = params.z;\n\n    float dx = pos.x - cx, dy = pos.y - cy;\n    float d2 = dx * dx + dy * dy;\n    if (d2 >= radius * radius) continue;\n    float dist = sqrt(d2);\n    float falloff = 1.0 - dist / radius;\n    float f2 = falloff * falloff;\n\n    if (maskVal > 0.1 && brushType != 3) continue;\n\n    if (brushType == 0) {\n      int pigIdx = int(params.x);\n      vec3 weights = vec3(0.0);\n      if (pigIdx == 0) weights.x = 1.0;\n      else if (pigIdx == 1) weights.y = 1.0;\n      else if (pigIdx == 2) weights.z = 1.0;\n      else if (pigIdx == 3) weights = u_rainbowWeights;\n\n      // \u2500\u2500 v1.0 textureMul \u2014 transliteration of textureMul() (verified) \u2500\u2500\n      float textureMul = 1.0;\n      if (u_brushMode > 0) {\n        float nval = texture(u_brushTexture, uv).r;            // SAME field as CPU\n        if (paperWeight > 0.0) nval = nval * (1.0 - paperWeight) + texture(u_paper, uv).r * paperWeight;\n        if (anisoK != 0.0 && (u_motionDir.x != 0.0 || u_motionDir.y != 0.0)) {\n          float rInv = 1.0 / radius;\n          float align = (dx * rInv) * u_motionDir.x + (dy * rInv) * u_motionDir.y;\n          nval += anisoK * align * 0.05;\n        }\n        float lo = baseThresh - bandHalf;\n        float hi = baseThresh + bandHalf;\n        float t = (nval - lo) / max(1e-6, hi - lo);\n        textureMul = t <= 0.0 ? 0.0 : t >= 1.0 ? 1.0 : t * t * (3.0 - 2.0 * t);\n        if (bristleK > 0.0) {\n          float r1 = float((cellIdx * 2654435761u) & 0xFFFFu) / 65535.0;  // matches CPU\n          if (r1 < bristleK) textureMul = 0.0;\n        }\n        if (textureMul <= 0.0) continue;\n      }\n\n      vec3 deposit = weights * falloff * strength * textureMul;\n      g_val = min(g_val + deposit, vec3(u_maxPigment));\n      d_val = min(d_val + deposit * 0.5, vec3(u_maxPigment));\n      float wMul = (u_brushMode > 0) ? waterMult : 1.0;\n      float gate = (u_brushMode > 0) ? textureMul : 1.0;\n      wet = max(wet, f2 * wetAmount * wMul * gate);\n      pressure += f2 * pressureAmount * wMul * gate;\n\n    } else if (brushType == 1) {\n      wet = max(wet, f2 * wetAmount); pressure += f2 * pressureAmount;\n      float liftStr = f2 * strength * 0.18;\n      vec3 lifted = min(d_val, vec3(liftStr));\n      d_val -= lifted; g_val += lifted;\n    } else if (brushType == 2) {\n      float sub = f2 * strength; g_val *= (1.0 - sub); d_val *= (1.0 - sub);\n    } else if (brushType == 3) {\n      maskVal = min(maskVal + falloff * strength, 1.0);\n    } else if (brushType == 4) {\n      float clear = f2 * strength; g_val *= (1.0 - clear); d_val *= (1.0 - clear);\n      wet = max(wet, f2 * 0.3);\n    }\n  }\n\n  out_pigment = vec4(g_val, 0.0);\n  out_deposit = vec4(d_val, maskVal);\n  out_fluid = vec4(vel_u, vel_v, pressure, wet);\n}\n";
const copyTextureFrag = "#version 300 es\nprecision highp float;\n\nuniform sampler2D u_source;\nuniform vec2 u_texelSize;\n\nout vec4 fragColor;\n\nvoid main() {\n  vec2 uv = gl_FragCoord.xy * u_texelSize;\n  fragColor = texture(u_source, uv);\n}\n";
// ─── Constants ────────────────────────────────────────────────────────────────
const MAX_STAMPS_PER_FRAME = 32;
// Pinned texture units
const TEX_FLUID_A = 0;
const TEX_FLUID_B = 1;
const TEX_PIGMENT_A = 2;
const TEX_PIGMENT_B = 3;
const TEX_DEPOSIT_A = 4;
const TEX_DEPOSIT_B = 5;
const TEX_PAPER = 6;
const TEX_BLUR_TMP = 7;
const TEX_BLUR_TMP2 = 8;
const TEX_BINARIZE = 9;
const TEX_BRUSH = 10;        // v1.0.1 — active mode noise field
const GPU_SIM_DEBUG_LOGS = false;
const GPU_SIM_DEBUG_READBACK = false;
function gpuSimDebugLogs() {
    return GPU_SIM_DEBUG_LOGS;
}
function gpuSimDebugReadbackEnabled() {
    return GPU_SIM_DEBUG_READBACK;
}
let debugStampLogCount = 0;
let debugBrushPassLogCount = 0;
let debugReadbackLogCount = 0;
let debugReadbackPaintFrameCount = 0;
// ─── Helpers ──────────────────────────────────────────────────────────────────
function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error(`Shader compile error:\n${log}\n\nSource:\n${source.slice(0, 300)}`);
    }
    return shader;
}
function linkProgram(gl, vs, fs) {
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(prog);
        gl.deleteProgram(prog);
        throw new Error(`Program link error:\n${log}`);
    }
    return prog;
}
function createProgram(gl, vertSrc, fragSrc) {
    const vs = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
    const prog = linkProgram(gl, vs, fs);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return prog;
}
function createFloat32Texture(gl, width, height, data, filter = gl.NEAREST) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, data);
    return tex;
}
function createFBO(gl, colorAttachments) {
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    const drawBuffers = [];
    for (let i = 0; i < colorAttachments.length; i++) {
        const attachment = gl.COLOR_ATTACHMENT0 + i;
        gl.framebufferTexture2D(gl.FRAMEBUFFER, attachment, gl.TEXTURE_2D, colorAttachments[i], 0);
        drawBuffers.push(attachment);
    }
    gl.drawBuffers(drawBuffers);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error(`Framebuffer incomplete: 0x${status.toString(16)}`);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return fbo;
}
// ─── Init ─────────────────────────────────────────────────────────────────────
function initGpuSim(gl, GW, GH) {
    // Ensure required extensions
    const extFloat = gl.getExtension("EXT_color_buffer_float");
    if (!extFloat) {
        throw new Error("EXT_color_buffer_float not available — cannot render to float textures");
    }
    gl.getExtension("OES_texture_float_linear");
    const texelSize = [1.0 / GW, 1.0 / GH];
    // ─── Create textures ──────────────────────────────────────────────────
    const textures = [];
    function makeTex(filter = gl.NEAREST) {
        const tex = createFloat32Texture(gl, GW, GH, null, filter);
        textures.push(tex);
        return tex;
    }
    const fluidA = makeTex();
    const fluidB = makeTex();
    // v7 — pigment textures dropped back to NEAREST. Bilinear sampling
    // for advection is now done manually in advect_semilag.frag via
    // sampleBilinear(), which is deterministic across GPUs regardless
    // of OES_texture_float_linear availability.
    const pigmentA = makeTex(gl.NEAREST);
    const pigmentB = makeTex(gl.NEAREST);
    const depositA = makeTex();
    const depositB = makeTex();
    const paper = makeTex();
    const brushTex = makeTex(); // v1.0.1 — uploaded noise field for texture brushes
    const blurTmp = makeTex();
    const blurTmp2 = makeTex();
    const binarizeTex = makeTex();
    // ─── Bind to pinned texture units ─────────────────────────────────────
    function bindTextureUnit(unit, tex) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, tex);
    }
    function bindAllTextures() {
        bindTextureUnit(TEX_FLUID_A, fluidA);
        bindTextureUnit(TEX_FLUID_B, fluidB);
        bindTextureUnit(TEX_PIGMENT_A, pigmentA);
        bindTextureUnit(TEX_PIGMENT_B, pigmentB);
        bindTextureUnit(TEX_DEPOSIT_A, depositA);
        bindTextureUnit(TEX_DEPOSIT_B, depositB);
        bindTextureUnit(TEX_PAPER, paper);
        bindTextureUnit(TEX_BRUSH, brushTex);
        bindTextureUnit(TEX_BLUR_TMP, blurTmp);
        bindTextureUnit(TEX_BLUR_TMP2, blurTmp2);
        bindTextureUnit(TEX_BINARIZE, binarizeTex);
    }
    // ─── Create FBOs ──────────────────────────────────────────────────────
    const fboFluidB = createFBO(gl, [fluidB]);
    const fboFluidA = createFBO(gl, [fluidA]);
    const fboPigmentB = createFBO(gl, [pigmentB]);
    const fboPigmentA = createFBO(gl, [pigmentA]);
    const fboDepositB = createFBO(gl, [depositB]);
    const fboDepositA = createFBO(gl, [depositA]);
    const fboBinarize = createFBO(gl, [binarizeTex]);
    const fboBlurTmp = createFBO(gl, [blurTmp]);
    const fboBlurTmp2 = createFBO(gl, [blurTmp2]);
    // MRT FBO for transfer_evaporate.
    const fboTransferA = createFBO(gl, [pigmentA, depositA, fluidA]);
    const fboTransferB = createFBO(gl, [pigmentB, depositB, fluidB]);
    // MRT FBO for brush_stamp (same pattern)
    const fboBrushA = createFBO(gl, [pigmentA, depositA, fluidA]);
    const fboBrushB = createFBO(gl, [pigmentB, depositB, fluidB]);
    // ─── Compile programs ─────────────────────────────────────────────────
    const progDiffuseWet = createProgram(gl, fullscreenVert, diffuseWetFrag);
    const progBinarize = createProgram(gl, fullscreenVert, binarizeEdgeFrag);
    const progBlurH = createProgram(gl, fullscreenVert, blurHFrag);
    const progBlurV = createProgram(gl, fullscreenVert, blurVFrag);
    const progEdgeApply = createProgram(gl, fullscreenVert, edgeApplyFrag);
    const progVelocity = createProgram(gl, fullscreenVert, updateVelocityFrag);
    const progAdvect = createProgram(gl, fullscreenVert, advectSemilagFrag);
    const progTransfer = createProgram(gl, fullscreenVert, transferEvaporateFrag);
    const progBrush = createProgram(gl, fullscreenVert, brushStampFrag);
    const progCopy = createProgram(gl, fullscreenVert, copyTextureFrag);
    const programs = [
        progDiffuseWet,
        progBinarize,
        progBlurH,
        progBlurV,
        progEdgeApply,
        progVelocity,
        progAdvect,
        progTransfer,
        progBrush,
        progCopy,
    ];
    // ─── Fullscreen VAO (empty — vertex shader uses gl_VertexID) ──────────
    const vao = gl.createVertexArray();
    const uniformCache = new Map();
    function getUniforms(prog) {
        let cache = uniformCache.get(prog);
        if (!cache) {
            cache = {};
            const count = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
            for (let i = 0; i < count; i++) {
                const info = gl.getActiveUniform(prog, i);
                if (info) {
                    // For arrays, getUniformLocation needs the base name
                    const name = info.name.replace(/\[0\]$/, "");
                    cache[name] = gl.getUniformLocation(prog, info.name);
                    // Also cache array entries we use
                    if (info.size > 1) {
                        for (let j = 0; j < info.size; j++) {
                            const arrName = `${name}[${j}]`;
                            cache[arrName] = gl.getUniformLocation(prog, arrName);
                        }
                    }
                }
            }
            uniformCache.set(prog, cache);
        }
        return cache;
    }
    // ─── Draw dispatch ────────────────────────────────────────────────────
    function draw() {
        gl.bindVertexArray(vao);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    function useProgram(prog) {
        gl.useProgram(prog);
        return getUniforms(prog);
    }
    // ─── Ping-pong tracking ───────────────────────────────────────────────
    // After each full sim step, A textures hold the latest state.
    // During a step, passes alternate writing to B then back to A.
    // Track which is "current read" for fluid and pigment.
    let fluidRead = TEX_FLUID_A;
    let pigmentRead = TEX_PIGMENT_A;
    let depositRead = TEX_DEPOSIT_A;
    // Brush stamp queue
    let pendingStamps = [];
    let debugReadFbo = null;
    let debugFluidReadback = null;
    let debugPigmentReadback = null;
    // ─── Rainbow weights (CPU-computed, uploaded per-frame) ───────────────
    // The brush_stamp.frag shader reads `u_rainbowWeights` when a stamp's
    // pigIdx == 3, producing a smoothly mixed RGB deposit. washes.js calls
    // setRainbowWeights() right before each rainbow stamp so the live
    // phase value reaches the GPU; without it the weights freeze at the
    // initial [1,0,0] and rainbow strokes look like pure rose.
    const rainbowWeights = [1, 0, 0];
    function setRainbowWeights(w0, w1, w2) {
        rainbowWeights[0] = w0;
        rainbowWeights[1] = w1;
        rainbowWeights[2] = w2;
    }
    // v4 — Brush-mode parameters consumed by brush_stamp.frag's pigment
    // branch. washes.js calls setBrushMode() before each pigment stamp
    // to forward the current mode + dryness controls + motion vector.
    // Mode codes match the shader: 0=wet, 1=crayon, 2=dryBrush, 3=salt,
    // 4=splatter. Defaults emulate the CPU lib's 'wet' (no-op).
    const brushModeState = {
        mode: 0,
        dryness: 0,
        paperReject: 0.5,
        anisotropy: 0.5,
        bristleSkip: 0.3,
        motionDirX: 0,
        motionDirY: 0,
    };
    // v1.0.1 — upload the active mode's CPU noise field so the brush shader
    // samples the SAME field as the CPU instead of synthesizing procedural
    // noise. field: Float32Array(GW*GH) in [0,1]. Packed into R of an RGBA32F
    // texture (matches makeTex); G/B/A unused.
    function setBrushTexture(field, w, h) {
        const n = GW * GH;
        if (!field || field.length < n) return;
        const rgba = new Float32Array(n * 4);
        for (let i = 0; i < n; i++) rgba[i * 4] = field[i];
        gl.activeTexture(gl.TEXTURE0 + TEX_BRUSH);
        gl.bindTexture(gl.TEXTURE_2D, brushTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, GW, GH, 0, gl.RGBA, gl.FLOAT, rgba);
    }

    function setBrushMode(mode, dryness, paperReject, anisotropy, bristleSkip, motionDirX, motionDirY) {
        brushModeState.mode = mode | 0;
        brushModeState.dryness = +dryness || 0;
        brushModeState.paperReject = +paperReject || 0;
        brushModeState.anisotropy = +anisotropy || 0;
        brushModeState.bristleSkip = +bristleSkip || 0;
        brushModeState.motionDirX = +motionDirX || 0;
        brushModeState.motionDirY = +motionDirY || 0;
    }
    // ─── Pass implementations ─────────────────────────────────────────────
    function passDiffuseWet(params) {
        // Reads fluidA, writes fluidB
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboFluidB);
        gl.viewport(0, 0, GW, GH);
        const u = useProgram(progDiffuseWet);
        gl.uniform1i(u["u_fluid"], TEX_FLUID_A);
        gl.uniform1i(u["u_deposit"], TEX_DEPOSIT_A);
        gl.uniform2f(u["u_texelSize"], texelSize[0], texelSize[1]);
        gl.uniform1f(u["u_wetDiffusion"], params.wetDiffusion);
        gl.uniform1i(u["u_maskActive"], params.maskActive ? 1 : 0);
        draw();
        // Swap: fluid read is now B
        fluidRead = TEX_FLUID_B;
    }
    function passEdgeDarkening(params) {
        // Step 1: Binarize wet from fluidB -> binarizeTex
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboBinarize);
        gl.viewport(0, 0, GW, GH);
        let u = useProgram(progBinarize);
        gl.uniform1i(u["u_fluid"], TEX_FLUID_B);
        gl.uniform2f(u["u_texelSize"], texelSize[0], texelSize[1]);
        draw();
        // Step 2: Blur small (H then V) -> blurTmp
        // H pass: binarize -> blurTmp2
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboBlurTmp2);
        gl.viewport(0, 0, GW, GH);
        u = useProgram(progBlurH);
        gl.uniform1i(u["u_source"], TEX_BINARIZE);
        gl.uniform2f(u["u_texelSize"], texelSize[0], texelSize[1]);
        gl.uniform1i(u["u_radius"], params.edgeKernel);
        draw();
        // V pass: blurTmp2 -> blurTmp (small kernel result)
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboBlurTmp);
        gl.viewport(0, 0, GW, GH);
        u = useProgram(progBlurV);
        gl.uniform1i(u["u_source"], TEX_BLUR_TMP2);
        gl.uniform2f(u["u_texelSize"], texelSize[0], texelSize[1]);
        gl.uniform1i(u["u_radius"], params.edgeKernel);
        draw();
        // Step 3: Blur large (H then V) -> blurTmp2
        // H pass: binarize -> blurTmp2 (reuse)
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboBlurTmp2);
        gl.viewport(0, 0, GW, GH);
        u = useProgram(progBlurH);
        gl.uniform1i(u["u_source"], TEX_BINARIZE);
        gl.uniform2f(u["u_texelSize"], texelSize[0], texelSize[1]);
        gl.uniform1i(u["u_radius"], params.edgeKernelLarge);
        draw();
        // V pass: blurTmp2 -> binarizeTex (reuse as large blur output)
        // We store large blur result in binarizeTex since we no longer need the binary
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboBinarize);
        gl.viewport(0, 0, GW, GH);
        u = useProgram(progBlurV);
        gl.uniform1i(u["u_source"], TEX_BLUR_TMP2);
        gl.uniform2f(u["u_texelSize"], texelSize[0], texelSize[1]);
        gl.uniform1i(u["u_radius"], params.edgeKernelLarge);
        draw();
        // Step 4: Apply edge darkening — reads fluidB + blurTmp (small) + binarize (large) -> fluidA
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboFluidA);
        gl.viewport(0, 0, GW, GH);
        u = useProgram(progEdgeApply);
        gl.uniform1i(u["u_fluid"], TEX_FLUID_B);
        gl.uniform1i(u["u_blurSmall"], TEX_BLUR_TMP);
        gl.uniform1i(u["u_blurLarge"], TEX_BINARIZE);
        gl.uniform1i(u["u_deposit"], TEX_DEPOSIT_A);
        gl.uniform2f(u["u_texelSize"], texelSize[0], texelSize[1]);
        gl.uniform1f(u["u_edgeEta"], params.edgeEta);
        gl.uniform1f(u["u_edgeWetActive"], params.edgeWetActive);
        gl.uniform1f(u["u_edgeWetOff"], params.edgeWetOff);
        gl.uniform1i(u["u_maskActive"], params.maskActive ? 1 : 0);
        draw();
        // Now fluidA has the edge-darkened state
        fluidRead = TEX_FLUID_A;
    }
    function passBrush(stamps) {
        if (stamps.length === 0)
            return;
        // Brush must ping-pong: WebGL forbids sampling from textures that are
        // attached to the framebuffer currently being rendered into.
        const writeToB = pigmentRead === TEX_PIGMENT_A;
        if (gpuSimDebugLogs() && debugBrushPassLogCount < 12) {
            console.debug("[GPU-SIM] passBrush draw", {
                count: stamps.length,
                writeTarget: writeToB ? "B" : "A",
                fluidRead,
                pigmentRead,
                depositRead,
            });
            debugBrushPassLogCount++;
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, writeToB ? fboBrushB : fboBrushA);
        gl.viewport(0, 0, GW, GH);
        const u = useProgram(progBrush);
        // Bind current-read textures as inputs
        gl.uniform1i(u["u_fluid"], fluidRead);
        gl.uniform1i(u["u_pigment"], pigmentRead);
        gl.uniform1i(u["u_deposit"], depositRead);
        gl.uniform2f(u["u_texelSize"], texelSize[0], texelSize[1]);
        gl.uniform1f(u["u_maxPigment"], 1.0);
        gl.uniform3f(u["u_rainbowWeights"], rainbowWeights[0], rainbowWeights[1], rainbowWeights[2]);
        // v4 — brush-mode uniforms. uniform1i with -1 for an unused
        // location is a silent no-op in WebGL, so safe even if a future
        // build of the shader compiles them out.
        gl.uniform1i(u["u_brushMode"], brushModeState.mode);
        gl.uniform1f(u["u_dryness"], brushModeState.dryness);
        gl.uniform1f(u["u_paperReject"], brushModeState.paperReject);
        gl.uniform1f(u["u_anisotropy"], brushModeState.anisotropy);
        gl.uniform1f(u["u_bristleSkip"], brushModeState.bristleSkip);
        gl.uniform2f(u["u_motionDir"], brushModeState.motionDirX, brushModeState.motionDirY);
        gl.uniform1i(u["u_brushTexture"], TEX_BRUSH); // v1.0.1
        gl.uniform1i(u["u_paper"], TEX_PAPER);
        const count = Math.min(stamps.length, MAX_STAMPS_PER_FRAME);
        gl.uniform1i(u["u_stampCount"], count);
        // Upload stamp data as uniform arrays
        for (let i = 0; i < count; i++) {
            const s = stamps[i];
            const posRadLoc = u[`u_stampPosRad[${i}]`];
            const paramsLoc = u[`u_stampParams[${i}]`];
            if (posRadLoc)
                gl.uniform4f(posRadLoc, s.cx, s.cy, s.radius, s.strength);
            if (paramsLoc)
                gl.uniform4f(paramsLoc, s.pigmentIdx, s.wetAmount, s.pressureAmount, s.brushType);
        }
        draw();
        if (writeToB) {
            fluidRead = TEX_FLUID_B;
            pigmentRead = TEX_PIGMENT_B;
            depositRead = TEX_DEPOSIT_B;
        }
        else {
            fluidRead = TEX_FLUID_A;
            pigmentRead = TEX_PIGMENT_A;
            depositRead = TEX_DEPOSIT_A;
        }
    }
    function copyTexture(sourceUnit, targetFbo) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, targetFbo);
        gl.viewport(0, 0, GW, GH);
        const u = useProgram(progCopy);
        gl.uniform1i(u["u_source"], sourceUnit);
        gl.uniform2f(u["u_texelSize"], texelSize[0], texelSize[1]);
        draw();
    }
    function alignReadStateToB() {
        if (fluidRead !== TEX_FLUID_B)
            copyTexture(fluidRead, fboFluidB);
        if (pigmentRead !== TEX_PIGMENT_B)
            copyTexture(pigmentRead, fboPigmentB);
        if (depositRead !== TEX_DEPOSIT_B)
            copyTexture(depositRead, fboDepositB);
        fluidRead = TEX_FLUID_B;
        pigmentRead = TEX_PIGMENT_B;
        depositRead = TEX_DEPOSIT_B;
        bindAllTextures();
    }
    function readTextureInto(texture, target) {
        if (!debugReadFbo)
            debugReadFbo = gl.createFramebuffer();
        if (!debugReadFbo)
            return;
        gl.bindFramebuffer(gl.FRAMEBUFFER, debugReadFbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        gl.readPixels(0, 0, GW, GH, gl.RGBA, gl.FLOAT, target);
    }
    function logDebugReadback(label) {
        if (!gpuSimDebugReadbackEnabled())
            return;
        if (debugReadbackLogCount >= 36)
            return;
        if (!debugFluidReadback)
            debugFluidReadback = new Float32Array(GW * GH * 4);
        if (!debugPigmentReadback)
            debugPigmentReadback = new Float32Array(GW * GH * 4);
        readTextureInto(fluidRead === TEX_FLUID_B ? fluidB : fluidA, debugFluidReadback);
        readTextureInto(pigmentRead === TEX_PIGMENT_B ? pigmentB : pigmentA, debugPigmentReadback);
        let wetMass = 0;
        let weightedU = 0;
        let weightedV = 0;
        let maxSpeed = -1;
        let maxSpeedX = 0;
        let maxSpeedGLY = 0;
        let minU = Infinity;
        let maxU = -Infinity;
        let minV = Infinity;
        let maxV = -Infinity;
        let pigmentMass = 0;
        let pigmentX = 0;
        let pigmentGLY = 0;
        let pigmentWeightedU = 0;
        let pigmentWeightedV = 0;
        let maxPigment = -1;
        let maxPigmentX = 0;
        let maxPigmentGLY = 0;
        for (let y = 0; y < GH; y++) {
            for (let x = 0; x < GW; x++) {
                const i = (y * GW + x) * 4;
                const velU = debugFluidReadback[i];
                const velV = debugFluidReadback[i + 1];
                const wet = debugFluidReadback[i + 3];
                const speed = Math.hypot(velU, velV);
                if (wet > 0.001) {
                    wetMass += wet;
                    weightedU += velU * wet;
                    weightedV += velV * wet;
                }
                if (speed > maxSpeed) {
                    maxSpeed = speed;
                    maxSpeedX = x;
                    maxSpeedGLY = y;
                }
                minU = Math.min(minU, velU);
                maxU = Math.max(maxU, velU);
                minV = Math.min(minV, velV);
                maxV = Math.max(maxV, velV);
                const pigment = debugPigmentReadback[i] +
                    debugPigmentReadback[i + 1] +
                    debugPigmentReadback[i + 2];
                if (pigment > 0.00001) {
                    pigmentMass += pigment;
                    pigmentX += x * pigment;
                    pigmentGLY += y * pigment;
                    pigmentWeightedU += velU * pigment;
                    pigmentWeightedV += velV * pigment;
                }
                if (pigment > maxPigment) {
                    maxPigment = pigment;
                    maxPigmentX = x;
                    maxPigmentGLY = y;
                }
            }
        }
        const avgU = wetMass > 0 ? weightedU / wetMass : 0;
        const avgV = wetMass > 0 ? weightedV / wetMass : 0;
        const centerX = pigmentMass > 0 ? pigmentX / pigmentMass : null;
        const centerGLY = pigmentMass > 0 ? pigmentGLY / pigmentMass : null;
        const centerVisibleY = centerGLY;
        const pigmentAvgU = pigmentMass > 0 ? pigmentWeightedU / pigmentMass : 0;
        const pigmentAvgV = pigmentMass > 0 ? pigmentWeightedV / pigmentMass : 0;
        console.log(`[GPU-SIM] readback ${label} ${JSON.stringify({
            grid: [GW, GH],
            textures: { fluidRead, pigmentRead, depositRead },
            velocity: {
                wetMass: Number(wetMass.toFixed(4)),
                avgU: Number(avgU.toFixed(5)),
                avgV: Number(avgV.toFixed(5)),
                minU: Number(minU.toFixed(5)),
                maxU: Number(maxU.toFixed(5)),
                minV: Number(minV.toFixed(5)),
                maxV: Number(maxV.toFixed(5)),
                maxSpeed: Number(maxSpeed.toFixed(5)),
                maxSpeedAt: {
                    x: maxSpeedX,
                    glY: maxSpeedGLY,
                    visibleY: maxSpeedGLY,
                },
            },
            pigment: {
                mass: Number(pigmentMass.toFixed(4)),
                localVelocity: {
                    avgU: Number(pigmentAvgU.toFixed(5)),
                    avgV: Number(pigmentAvgV.toFixed(5)),
                },
                center: centerX == null
                    ? null
                    : {
                        x: Number(centerX.toFixed(2)),
                        glY: Number(centerGLY.toFixed(2)),
                        visibleY: Number(centerVisibleY.toFixed(2)),
                    },
                max: Number(maxPigment.toFixed(5)),
                maxAt: {
                    x: maxPigmentX,
                    glY: maxPigmentGLY,
                    visibleY: maxPigmentGLY,
                },
            },
        })}`);
        debugReadbackLogCount++;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    // ─── Public API ───────────────────────────────────────────────────────
    function step(params) {
        gl.viewport(0, 0, GW, GH);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.BLEND);
        bindAllTextures();
        // Apply brush stamps first (before sim)
        if (pendingStamps.length > 0) {
            alignReadStateToB();
            passBrush(pendingStamps);
            pendingStamps = [];
            // Re-bind after brush modified textures
            bindAllTextures();
        }
        // 1. Diffuse wet: fluidA -> fluidB
        passDiffuseWet(params);
        bindTextureUnit(TEX_FLUID_B, fluidB);
        // 2. Edge darkening (optional): fluidB -> fluidA
        if (params.edgeDarkeningEnabled) {
            passEdgeDarkening(params);
            bindTextureUnit(TEX_FLUID_A, fluidA);
        }
        else {
            // Skip edge darkening — copy fluidB to A conceptually
            // Actually just swap the read pointers
            // velocity pass reads from whatever is current
            fluidRead = TEX_FLUID_B;
        }
        // 3. Update velocity: fluid(current) -> fluid(other)
        // After edge darkening: fluidA is current, writes to fluidB
        // Without edge darkening: fluidB is current, writes to fluidA
        if (fluidRead === TEX_FLUID_A) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, fboFluidB);
        }
        else {
            gl.bindFramebuffer(gl.FRAMEBUFFER, fboFluidA);
        }
        gl.viewport(0, 0, GW, GH);
        {
            const u = useProgram(progVelocity);
            gl.uniform1i(u["u_fluid"], fluidRead);
            gl.uniform1i(u["u_paper"], TEX_PAPER);
            gl.uniform1i(u["u_deposit"], depositRead);
            gl.uniform2f(u["u_texelSize"], texelSize[0], texelSize[1]);
            gl.uniform1f(u["u_DT"], params.DT);
            gl.uniform1f(u["u_viscosity"], params.viscosity);
            gl.uniform1f(u["u_drag"], params.drag);
            gl.uniform1f(u["u_paperTilt"], params.paperTilt);
            gl.uniform1f(u["u_velClamp"], params.velClamp);
            gl.uniform1f(u["u_pressureDecay"], params.pressureDecay);
            gl.uniform1i(u["u_maskActive"], params.maskActive ? 1 : 0);
            gl.uniform1i(u["u_gravityMode"], params.gravityMode);
            gl.uniform2f(u["u_gravityBias"], params.gravityBias[0], params.gravityBias[1]);
            gl.uniform1f(u["u_gravityStrength"], params.gravityStrength);
            gl.uniform2f(u["u_gridCenter"], (GW - 1) / 2, (GH - 1) / 2);
            gl.uniform1i(u["u_edgeOpenLeft"], params.edgeOpen.left ? 1 : 0);
            gl.uniform1i(u["u_edgeOpenRight"], params.edgeOpen.right ? 1 : 0);
            gl.uniform1i(u["u_edgeOpenTop"], params.edgeOpen.top ? 1 : 0);
            gl.uniform1i(u["u_edgeOpenBottom"], params.edgeOpen.bottom ? 1 : 0);
            draw();
        }
        // After velocity: output is in the "other" buffer
        if (fluidRead === TEX_FLUID_A) {
            fluidRead = TEX_FLUID_B;
            bindTextureUnit(TEX_FLUID_B, fluidB);
        }
        else {
            fluidRead = TEX_FLUID_A;
            bindTextureUnit(TEX_FLUID_A, fluidA);
        }
        // 4. Advection (movePigment): reads fluid(current) + pigmentA -> pigmentB
        {
            gl.bindFramebuffer(gl.FRAMEBUFFER, fboPigmentB);
            gl.viewport(0, 0, GW, GH);
            const u = useProgram(progAdvect);
            gl.uniform1i(u["u_fluid"], fluidRead);
            gl.uniform1i(u["u_pigment"], TEX_PIGMENT_A);
            gl.uniform1i(u["u_deposit"], depositRead);
            gl.uniform2f(u["u_texelSize"], texelSize[0], texelSize[1]);
            gl.uniform1f(u["u_adt"], params.DT * 0.7);
            gl.uniform1f(u["u_pigmentDiffusion"], params.pigmentDiffusion);
            gl.uniform1i(u["u_maskActive"], params.maskActive ? 1 : 0);
            gl.uniform1i(u["u_edgeOpenLeft"], params.edgeOpen.left ? 1 : 0);
            gl.uniform1i(u["u_edgeOpenRight"], params.edgeOpen.right ? 1 : 0);
            gl.uniform1i(u["u_edgeOpenTop"], params.edgeOpen.top ? 1 : 0);
            gl.uniform1i(u["u_edgeOpenBottom"], params.edgeOpen.bottom ? 1 : 0);
            draw();
            pigmentRead = TEX_PIGMENT_B;
            bindTextureUnit(TEX_PIGMENT_B, pigmentB);
        }
        // 5. Transfer + evaporate + drain (MRT)
        // Align reads to B so the MRT can safely write authoritative state to A.
        alignReadStateToB();
        {
            gl.bindFramebuffer(gl.FRAMEBUFFER, fboTransferA);
            gl.viewport(0, 0, GW, GH);
            const u = useProgram(progTransfer);
            gl.uniform1i(u["u_fluid"], fluidRead);
            gl.uniform1i(u["u_pigment"], pigmentRead);
            gl.uniform1i(u["u_deposit"], depositRead);
            gl.uniform1i(u["u_paper"], TEX_PAPER);
            gl.uniform2f(u["u_texelSize"], texelSize[0], texelSize[1]);
            gl.uniform1i(u["u_maskActive"], params.maskActive ? 1 : 0);
            gl.uniform1f(u["u_evaporationRate"], params.dryingPaused ? 1.0 : params.evaporationRate);
            gl.uniform1f(u["u_maxPigment"], params.maxPigment);
            gl.uniform1f(u["u_drainAdt"], params.DT * 0.7);
            gl.uniform3f(u["u_density"], params.pigDensity[0], params.pigDensity[1], params.pigDensity[2]);
            gl.uniform3f(u["u_staining"], params.pigStaining[0], params.pigStaining[1], params.pigStaining[2]);
            gl.uniform3f(u["u_granulation"], params.pigGranulation[0], params.pigGranulation[1], params.pigGranulation[2]);
            gl.uniform1i(u["u_edgeOpenLeft"], params.edgeOpen.left ? 1 : 0);
            gl.uniform1i(u["u_edgeOpenRight"], params.edgeOpen.right ? 1 : 0);
            gl.uniform1i(u["u_edgeOpenTop"], params.edgeOpen.top ? 1 : 0);
            gl.uniform1i(u["u_edgeOpenBottom"], params.edgeOpen.bottom ? 1 : 0);
            draw();
            // After MRT: pigmentA, depositA, fluidA are current
            fluidRead = TEX_FLUID_A;
            pigmentRead = TEX_PIGMENT_A;
            depositRead = TEX_DEPOSIT_A;
        }
        // Rebind for next step / render sampling
        bindAllTextures();
        // At end of step: fluidA, pigmentA, depositA hold authoritative state
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    function stampBrush(stamps) {
        if (gpuSimDebugLogs() && debugStampLogCount < 12) {
            console.debug("[GPU-SIM] handle.stampBrush queued", {
                count: stamps.length,
                first: stamps[0] ?? null,
            });
            debugStampLogCount++;
        }
        pendingStamps.push(...stamps);
    }
    function debugApplyBrushStampsOnly() {
        if (pendingStamps.length === 0) {
            if (gpuSimDebugLogs() && debugBrushPassLogCount < 12) {
                console.debug("[GPU-SIM] debugApplyBrushStampsOnly no pending stamps");
                debugBrushPassLogCount++;
            }
            return;
        }
        if (gpuSimDebugLogs() && debugBrushPassLogCount < 12) {
            console.debug("[GPU-SIM] debugApplyBrushStampsOnly flushing", {
                pending: pendingStamps.length,
            });
            debugBrushPassLogCount++;
        }
        gl.viewport(0, 0, GW, GH);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.BLEND);
        bindAllTextures();
        alignReadStateToB();
        passBrush(pendingStamps);
        pendingStamps = [];
        bindAllTextures();
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    function debugApplyTransferOnly(params) {
        gl.viewport(0, 0, GW, GH);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.BLEND);
        bindAllTextures();
        if (pendingStamps.length > 0) {
            alignReadStateToB();
            passBrush(pendingStamps);
            pendingStamps = [];
            bindAllTextures();
        }
        const writeToB = pigmentRead === TEX_PIGMENT_A;
        if (gpuSimDebugLogs() && debugBrushPassLogCount < 12) {
            console.debug("[GPU-SIM] debugApplyTransferOnly draw", {
                writeTarget: writeToB ? "B" : "A",
                fluidRead,
                pigmentRead,
                depositRead,
            });
            debugBrushPassLogCount++;
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, writeToB ? fboBrushB : fboBrushA);
        const u = useProgram(progTransfer);
        gl.uniform1i(u["u_fluid"], fluidRead);
        gl.uniform1i(u["u_pigment"], pigmentRead);
        gl.uniform1i(u["u_deposit"], depositRead);
        gl.uniform1i(u["u_paper"], TEX_PAPER);
        gl.uniform2f(u["u_texelSize"], texelSize[0], texelSize[1]);
        gl.uniform1i(u["u_maskActive"], params.maskActive ? 1 : 0);
        gl.uniform1f(u["u_evaporationRate"], 1.0);
        gl.uniform1f(u["u_maxPigment"], params.maxPigment);
        gl.uniform1f(u["u_drainAdt"], 0.0);
        gl.uniform3f(u["u_density"], params.pigDensity[0], params.pigDensity[1], params.pigDensity[2]);
        gl.uniform3f(u["u_staining"], params.pigStaining[0], params.pigStaining[1], params.pigStaining[2]);
        gl.uniform3f(u["u_granulation"], params.pigGranulation[0], params.pigGranulation[1], params.pigGranulation[2]);
        gl.uniform1i(u["u_edgeOpenLeft"], 0);
        gl.uniform1i(u["u_edgeOpenRight"], 0);
        gl.uniform1i(u["u_edgeOpenTop"], 0);
        gl.uniform1i(u["u_edgeOpenBottom"], 0);
        draw();
        if (writeToB) {
            fluidRead = TEX_FLUID_B;
            pigmentRead = TEX_PIGMENT_B;
            depositRead = TEX_DEPOSIT_B;
        }
        else {
            fluidRead = TEX_FLUID_A;
            pigmentRead = TEX_PIGMENT_A;
            depositRead = TEX_DEPOSIT_A;
        }
        bindAllTextures();
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    function debugApplyWetDiffusionOnly(params) {
        gl.viewport(0, 0, GW, GH);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.BLEND);
        bindAllTextures();
        if (pendingStamps.length > 0) {
            alignReadStateToB();
            passBrush(pendingStamps);
            pendingStamps = [];
            bindAllTextures();
        }
        const writeToB = fluidRead === TEX_FLUID_A;
        if (gpuSimDebugLogs() && debugBrushPassLogCount < 12) {
            console.debug("[GPU-SIM] debugApplyWetDiffusionOnly draw", {
                writeTarget: writeToB ? "B" : "A",
                fluidRead,
                depositRead,
            });
            debugBrushPassLogCount++;
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, writeToB ? fboFluidB : fboFluidA);
        const u = useProgram(progDiffuseWet);
        gl.uniform1i(u["u_fluid"], fluidRead);
        gl.uniform1i(u["u_deposit"], depositRead);
        gl.uniform2f(u["u_texelSize"], texelSize[0], texelSize[1]);
        gl.uniform1f(u["u_wetDiffusion"], params.wetDiffusion);
        gl.uniform1i(u["u_maskActive"], params.maskActive ? 1 : 0);
        draw();
        fluidRead = writeToB ? TEX_FLUID_B : TEX_FLUID_A;
        // This checkpoint renders only fluid.w. Keep all current pointers on
        // the same side so the next brush pass can safely render to the opposite
        // side without sampling any texture attached to the target FBO.
        pigmentRead = writeToB ? TEX_PIGMENT_B : TEX_PIGMENT_A;
        depositRead = writeToB ? TEX_DEPOSIT_B : TEX_DEPOSIT_A;
        bindAllTextures();
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    function debugApplyVelocityOnly(params) {
        debugApplyWetDiffusionOnly(params);
        bindAllTextures();
        const writeToB = fluidRead === TEX_FLUID_A;
        if (gpuSimDebugLogs() && debugBrushPassLogCount < 12) {
            console.debug("[GPU-SIM] debugApplyVelocityOnly draw", {
                writeTarget: writeToB ? "B" : "A",
                fluidRead,
                depositRead,
            });
            debugBrushPassLogCount++;
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, writeToB ? fboFluidB : fboFluidA);
        const u = useProgram(progVelocity);
        gl.uniform1i(u["u_fluid"], fluidRead);
        gl.uniform1i(u["u_paper"], TEX_PAPER);
        gl.uniform1i(u["u_deposit"], depositRead);
        gl.uniform2f(u["u_texelSize"], texelSize[0], texelSize[1]);
        gl.uniform1f(u["u_DT"], params.DT);
        gl.uniform1f(u["u_viscosity"], params.viscosity);
        gl.uniform1f(u["u_drag"], params.drag);
        gl.uniform1f(u["u_paperTilt"], params.paperTilt);
        gl.uniform1f(u["u_velClamp"], params.velClamp);
        gl.uniform1f(u["u_pressureDecay"], params.pressureDecay);
        gl.uniform1i(u["u_maskActive"], params.maskActive ? 1 : 0);
        gl.uniform1i(u["u_gravityMode"], params.gravityMode);
        gl.uniform2f(u["u_gravityBias"], params.gravityBias[0], params.gravityBias[1]);
        gl.uniform1f(u["u_gravityStrength"], params.gravityStrength);
        gl.uniform2f(u["u_gridCenter"], (GW - 1) / 2, (GH - 1) / 2);
        gl.uniform1i(u["u_edgeOpenLeft"], params.edgeOpen.left ? 1 : 0);
        gl.uniform1i(u["u_edgeOpenRight"], params.edgeOpen.right ? 1 : 0);
        gl.uniform1i(u["u_edgeOpenTop"], params.edgeOpen.top ? 1 : 0);
        gl.uniform1i(u["u_edgeOpenBottom"], params.edgeOpen.bottom ? 1 : 0);
        draw();
        fluidRead = writeToB ? TEX_FLUID_B : TEX_FLUID_A;
        pigmentRead = writeToB ? TEX_PIGMENT_B : TEX_PIGMENT_A;
        depositRead = writeToB ? TEX_DEPOSIT_B : TEX_DEPOSIT_A;
        bindAllTextures();
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    function debugApplyAdvectionOnly(params) {
        const shouldLogReadback = gpuSimDebugReadbackEnabled() &&
            pendingStamps.length > 0 &&
            debugReadbackPaintFrameCount < 8;
        debugApplyVelocityOnly(params);
        bindAllTextures();
        if (shouldLogReadback)
            logDebugReadback("after-velocity");
        const writeToB = pigmentRead === TEX_PIGMENT_A;
        if (gpuSimDebugLogs() && debugBrushPassLogCount < 12) {
            console.debug("[GPU-SIM] debugApplyAdvectionOnly draw", {
                writeTarget: writeToB ? "B" : "A",
                fluidRead,
                pigmentRead,
                depositRead,
            });
            debugBrushPassLogCount++;
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, writeToB ? fboPigmentB : fboPigmentA);
        const u = useProgram(progAdvect);
        gl.uniform1i(u["u_fluid"], fluidRead);
        gl.uniform1i(u["u_pigment"], pigmentRead);
        gl.uniform1i(u["u_deposit"], depositRead);
        gl.uniform2f(u["u_texelSize"], texelSize[0], texelSize[1]);
        gl.uniform1f(u["u_adt"], params.DT * 0.7);
        gl.uniform1f(u["u_pigmentDiffusion"], params.pigmentDiffusion);
        gl.uniform1i(u["u_maskActive"], params.maskActive ? 1 : 0);
        gl.uniform1i(u["u_edgeOpenLeft"], params.edgeOpen.left ? 1 : 0);
        gl.uniform1i(u["u_edgeOpenRight"], params.edgeOpen.right ? 1 : 0);
        gl.uniform1i(u["u_edgeOpenTop"], params.edgeOpen.top ? 1 : 0);
        gl.uniform1i(u["u_edgeOpenBottom"], params.edgeOpen.bottom ? 1 : 0);
        draw();
        pigmentRead = writeToB ? TEX_PIGMENT_B : TEX_PIGMENT_A;
        bindAllTextures();
        if (shouldLogReadback)
            logDebugReadback("after-advection-before-align");
        if (pigmentRead === TEX_PIGMENT_B) {
            if (fluidRead !== TEX_FLUID_B)
                copyTexture(fluidRead, fboFluidB);
            if (depositRead !== TEX_DEPOSIT_B)
                copyTexture(depositRead, fboDepositB);
            fluidRead = TEX_FLUID_B;
            depositRead = TEX_DEPOSIT_B;
        }
        else {
            if (fluidRead !== TEX_FLUID_A)
                copyTexture(fluidRead, fboFluidA);
            if (depositRead !== TEX_DEPOSIT_A)
                copyTexture(depositRead, fboDepositA);
            fluidRead = TEX_FLUID_A;
            depositRead = TEX_DEPOSIT_A;
        }
        bindAllTextures();
        if (shouldLogReadback) {
            logDebugReadback("after-advection-aligned");
            debugReadbackPaintFrameCount++;
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    function uploadState(state) {
        gl.activeTexture(gl.TEXTURE0 + TEX_FLUID_A);
        gl.bindTexture(gl.TEXTURE_2D, fluidA);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, GW, GH, gl.RGBA, gl.FLOAT, state.fluid);
        gl.activeTexture(gl.TEXTURE0 + TEX_PIGMENT_A);
        gl.bindTexture(gl.TEXTURE_2D, pigmentA);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, GW, GH, gl.RGBA, gl.FLOAT, state.pigment);
        gl.activeTexture(gl.TEXTURE0 + TEX_DEPOSIT_A);
        gl.bindTexture(gl.TEXTURE_2D, depositA);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, GW, GH, gl.RGBA, gl.FLOAT, state.deposit);
        gl.activeTexture(gl.TEXTURE0 + TEX_PAPER);
        gl.bindTexture(gl.TEXTURE_2D, paper);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, GW, GH, gl.RGBA, gl.FLOAT, state.paper);
        // Reset ping-pong state
        fluidRead = TEX_FLUID_A;
        pigmentRead = TEX_PIGMENT_A;
        depositRead = TEX_DEPOSIT_A;
    }
    function downloadState(state) {
        // Read back from current-read textures
        const readFBO = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, readFBO);
        // Fluid
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fluidA, 0);
        gl.readPixels(0, 0, GW, GH, gl.RGBA, gl.FLOAT, state.fluid);
        // Pigment
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, pigmentA, 0);
        gl.readPixels(0, 0, GW, GH, gl.RGBA, gl.FLOAT, state.pigment);
        // Deposit
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, depositRead === TEX_DEPOSIT_B ? depositB : depositA, 0);
        gl.readPixels(0, 0, GW, GH, gl.RGBA, gl.FLOAT, state.deposit);
        // Paper (static, always the same)
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, paper, 0);
        gl.readPixels(0, 0, GW, GH, gl.RGBA, gl.FLOAT, state.paper);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteFramebuffer(readFBO);
    }
    function getFluidTexture() {
        return fluidRead === TEX_FLUID_B ? fluidB : fluidA;
    }
    function getPigmentTexture() {
        return pigmentRead === TEX_PIGMENT_B ? pigmentB : pigmentA;
    }
    function getDepositTexture() {
        return depositRead === TEX_DEPOSIT_B ? depositB : depositA;
    }
    function debugFillPigmentTexture() {
        const data = new Float32Array(GW * GH * 4);
        for (let y = 0; y < GH; y++) {
            for (let x = 0; x < GW; x++) {
                const i = (y * GW + x) * 4;
                data[i] = x / Math.max(1, GW - 1);
                data[i + 1] = y / Math.max(1, GH - 1);
                data[i + 2] = x % 24 < 12 === y % 24 < 12 ? 1 : 0.15;
                data[i + 3] = 1;
            }
        }
        gl.activeTexture(gl.TEXTURE0 + TEX_PIGMENT_A);
        gl.bindTexture(gl.TEXTURE_2D, pigmentA);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, GW, GH, gl.RGBA, gl.FLOAT, data);
        pigmentRead = TEX_PIGMENT_A;
    }
    function destroy() {
        for (const prog of programs)
            gl.deleteProgram(prog);
        for (const tex of textures)
            gl.deleteTexture(tex);
        gl.deleteVertexArray(vao);
        if (debugReadFbo)
            gl.deleteFramebuffer(debugReadFbo);
        gl.deleteFramebuffer(fboFluidA);
        gl.deleteFramebuffer(fboFluidB);
        gl.deleteFramebuffer(fboPigmentA);
        gl.deleteFramebuffer(fboPigmentB);
        gl.deleteFramebuffer(fboDepositA);
        gl.deleteFramebuffer(fboDepositB);
        gl.deleteFramebuffer(fboBinarize);
        gl.deleteFramebuffer(fboBlurTmp);
        gl.deleteFramebuffer(fboBlurTmp2);
        gl.deleteFramebuffer(fboTransferA);
        gl.deleteFramebuffer(fboTransferB);
        gl.deleteFramebuffer(fboBrushA);
        gl.deleteFramebuffer(fboBrushB);
    }
    return {
        step,
        stampBrush,
        uploadState,
        downloadState,
        getFluidTexture,
        getPigmentTexture,
        getDepositTexture,
        setRainbowWeights,
        setBrushMode,
        setBrushTexture,
        debugFillPigmentTexture,
        debugApplyBrushStampsOnly,
        debugApplyTransferOnly,
        debugApplyWetDiffusionOnly,
        debugApplyVelocityOnly,
        debugApplyAdvectionOnly,
        destroy,
    };
}

// ─── Global attachment ──────────────────────────────────────────────────────
// Mirrors washes.js convention: when loaded via <script type="module" src="…">,
// the IIFE-like side effect attaches initGpuSim to a global namespace so
// non-module consumers can read it off `window.WashesGpuSim`.
if (typeof globalThis !== 'undefined') {
    const _root = globalThis;
    _root.WashesGpuSim = { initGpuSim, version: '0.98.0' };
    if (typeof window !== 'undefined' && window !== _root) {
        window.WashesGpuSim = _root.WashesGpuSim;
    }
}

})();

// ============================================================
// ES Module exports (added by dist build).
//
//   import { initGpuSim, version } from 'washes/gpu-sim';
//   import * as WashesGpuSim from 'washes/gpu-sim';
//   import WashesGpuSim from 'washes/gpu-sim';   // default
// ============================================================
const WashesGpuSim = globalThis.WashesGpuSim;
const initGpuSim = WashesGpuSim.initGpuSim;
const version = WashesGpuSim.version;
export { initGpuSim, version };
export default WashesGpuSim;
