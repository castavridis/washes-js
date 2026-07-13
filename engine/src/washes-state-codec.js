// washes-state-codec.js — the SimStateArrays transfer format.
//
// One codec for the interleaved state layout that crosses every seam
// (CPU adapter upload/download, GPU texture upload, worker transfer):
//   fluid   = (u, v, pressure, wet)   × N
//   pigment = (g0, g1, g2, 0)         × N
//   deposit = (d0, d1, d2, mask)      × N
//   paper   = (paperH, 0, 0, 0)       × N
// Matches washes.js's _packGpuState / _unpackSimState byte-for-byte.

/** Allocate an empty SimStateArrays for a grid of N cells. */
export function allocState(N) {
  return {
    fluid: new Float32Array(N * 4),
    pigment: new Float32Array(N * 4),
    deposit: new Float32Array(N * 4),
    paper: new Float32Array(N * 4),
  };
}

/** Pack per-channel field arrays into an existing SimStateArrays. */
export function packState(fields, out) {
  const { u, v, pressure, wet, g, d, mask, paperH } = fields;
  const N = u.length;
  const f = out.fluid, p = out.pigment, dep = out.deposit, pap = out.paper;
  for (let i = 0; i < N; i++) {
    const i4 = i * 4;
    f[i4] = u[i]; f[i4 + 1] = v[i]; f[i4 + 2] = pressure[i]; f[i4 + 3] = wet[i];
    p[i4] = g[0][i]; p[i4 + 1] = g[1][i]; p[i4 + 2] = g[2][i]; p[i4 + 3] = 0;
    dep[i4] = d[0][i]; dep[i4 + 1] = d[1][i]; dep[i4 + 2] = d[2][i]; dep[i4 + 3] = mask[i];
    pap[i4] = paperH[i]; pap[i4 + 1] = 0; pap[i4 + 2] = 0; pap[i4 + 3] = 0;
  }
  return out;
}

/** Unpack a SimStateArrays into per-channel field arrays. */
export function unpackState(state, fields) {
  const { u, v, pressure, wet, g, d, mask, paperH } = fields;
  const N = u.length;
  const f = state.fluid, p = state.pigment, dep = state.deposit, pap = state.paper;
  for (let i = 0; i < N; i++) {
    const i4 = i * 4;
    u[i] = f[i4]; v[i] = f[i4 + 1]; pressure[i] = f[i4 + 2]; wet[i] = f[i4 + 3];
    g[0][i] = p[i4]; g[1][i] = p[i4 + 1]; g[2][i] = p[i4 + 2];
    d[0][i] = dep[i4]; d[1][i] = dep[i4 + 1]; d[2][i] = dep[i4 + 2];
    mask[i] = dep[i4 + 3];
    paperH[i] = pap[i4];
  }
  return fields;
}

/** The transfer list for zero-copy postMessage of a SimStateArrays. */
export function stateTransferList(state) {
  return [state.fluid.buffer, state.pigment.buffer, state.deposit.buffer, state.paper.buffer];
}
