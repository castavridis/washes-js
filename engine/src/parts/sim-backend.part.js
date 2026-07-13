    // ============================================================
    // SIM BACKEND SEAM (v1.16 — docs/gpu-migration MIGRATION.md Phase 0,
    // now in production). The de-facto contract the GPU module already
    // exposes (step / stampBrush / uploadState / downloadState /
    // getTextures / destroy) promoted to a real seam inside the lib:
    // the frame loop steps the sim through _simBackend instead of
    // calling simStep directly, so a worker or GPU backend can slot in
    // behind the same interface (backend/sim-backend.d.ts). The CPU
    // adapter is a faithful pass-through over existing code — proven by
    // the harness `backend` pattern (field-identical to direct simStep
    // driving) and the untouched equivalence/render goldens.
    // ============================================================
    function _unpackSimState(state) {
      const f = state.fluid,
        p = state.pigment,
        dep = state.deposit;
      let anyMask = false;
      let mx0 = GW, mx1 = -1, my0 = GH, my1 = -1;
      for (let i = 0; i < N; i++) {
        const i4 = i * 4;
        u[i] = f[i4];
        v[i] = f[i4 + 1];
        pressure[i] = f[i4 + 2];
        wet[i] = f[i4 + 3];
        g[0][i] = p[i4];
        g[1][i] = p[i4 + 1];
        g[2][i] = p[i4 + 2];
        d[0][i] = dep[i4];
        d[1][i] = dep[i4 + 1];
        d[2][i] = dep[i4 + 2];
        mask[i] = dep[i4 + 3];
        if (mask[i] > MASK_THRESHOLD) {
          anyMask = true;
          const x = i % GW,
            y = (i / GW) | 0;
          if (x < mx0) mx0 = x;
          if (x > mx1) mx1 = x;
          if (y < my0) my0 = y;
          if (y > my1) my1 = y;
        }
      }
      maskActive = anyMask;
      if (anyMask) {
        maskRectMinX = mx0;
        maskRectMaxX = mx1;
        maskRectMinY = my0;
        maskRectMaxY = my1;
      }
      // Restored content is unknown to the rect tracker — start full and
      // let the next shrink scan tighten to what actually arrived.
      setActiveRectFull();
      markCanvasActive();
    }

    const _simBackend = (function _createCpuBackend() {
      let queued = [];
      let destroyed = false;
      return {
        capabilities: {
          gpu: false,
          zeroCopyRender: false,
          textureBrushes: true,
          ink: true,
          maxStampsPerStep: Infinity,
        },
        step(params) {
          if (destroyed) return;
          if (queued.length) {
            for (let i = 0; i < queued.length; i++) {
              const s = queued[i];
              // brushType 0 (pigment) is the only stamp routed through
              // the seam today; paintAt applies deposit + wet + pressure
              // with the same math the pointer path uses. Other types
              // keep their dedicated verbs until Phase 1.
              if (s.brushType === 0)
                paintAt(s.cx, s.cy, s.radius, s.pigmentIdx, s.strength);
            }
            queued.length = 0;
          }
          simStep(params);
        },
        stampBrush(stamps) {
          if (destroyed || !stamps || !stamps.length) return;
          for (let i = 0; i < stamps.length; i++) queued.push(stamps[i]);
        },
        uploadState(state) {
          if (!destroyed) _unpackSimState(state);
        },
        downloadState(out) {
          if (destroyed) return;
          const s = _packGpuState();
          out.fluid.set(s.fluid);
          out.pigment.set(s.pigment);
          out.deposit.set(s.deposit);
          out.paper.set(s.paper);
        },
        getTextures() {
          return null;
        },
        destroy() {
          destroyed = true;
          queued.length = 0;
        },
      };
    })();
