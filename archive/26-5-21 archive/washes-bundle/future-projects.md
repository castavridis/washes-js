# Future projects: papers worth implementing

A working notebook of paper-based, browser-friendly, naturalistic
projects in the same vein as Washes. Each one fits the same
recipe: old paper, elegant math, surprising output, small enough to
run in a browser tab.

This list emerged from a conversation about what to build next
after Washes. It's not meant to be exhaustive — just the projects
I think would be worth doing, organized by what they're good for.

---

## The meta-pattern

Looking across all of these, there's a recipe for the next
"I built this from an old paper" piece of work. The pattern that
made Washes a viable project, and the pattern these all share:

1. **Old paper.** Ideally 1960s–2000s, so it has the "classic" patina. Recent papers feel like keeping up; old papers feel like reaching back.
2. **Elegant math.** Small enough to actually understand and explain in a paragraph. If you can't explain the core insight on one page, the project will be too heavy.
3. **Naturalistic output.** People instinctively connect to things that look like nature — fluid, branches, flocks, crystallization, patterns. This is what differentiates "neat hack" from "I want to look at this for an hour."
4. **Small enough to fit in a browser** without WebGL gymnastics or build-system hell. Canvas2D or simple WebGL. Vanilla JS or one tiny dep. Page loads instantly.
5. **A debugging story along the way.** Washes had the √2 cross. Any nontrivial project will have its own version — the off-by-one, the floating-point boundary, the algorithm that "shouldn't" work but does. Document it. The debugging story is often more interesting than the final result.
6. **Honest documentation** including prior art (who else built this, where they got it, what's different about yours) and the people you built on (cite the paper, name the authors). This is how you sit credibly in the lineage.

If you check those six boxes, you have something that holds
together as a project, reads well to a thoughtful audience, and
is satisfying to build.

---

## Project ideas, grouped by what they're good for

### Fluids and physics (closest to Washes)

**Stam, "Stable Fluids" (SIGGRAPH 1999)**
You already know this one from v0.67 of Washes (it's the
semi-Lagrangian advection scheme). As a *standalone* interactive,
it's spectacular: a 2D fluid sandbox where the cursor injects
velocity and dye, smoke swirls in real time. Jos Stam's original
C code is famously ~200 lines. Drag the cursor and people will
keep dragging — there's something hypnotic about it.
- Paper: https://pages.cs.wisc.edu/~chaol/data/cs777/stam-stable_fluids.pdf

**Jakobsen, "Advanced Character Physics" (GDC 2001)**
Verlet integration for ropes, chains, cloth, soft bodies. Drag
any vertex and the rest deforms naturally. The math is just:
"remember last frame's position, do `new = 2*now - last + accel*dt²`,
then enforce distance constraints between points." 50-100 lines.
Endless UX uses: hanging UI elements, draggable decorations, cloth
backgrounds, breakable chains.
- Paper: https://www.cs.cmu.edu/afs/cs/academic/class/15462-s13/www/lec_slides/Jakobsen.pdf

### Procedural patterns (gorgeous, slow-building, naturalistic)

**Turing, "The Chemical Basis of Morphogenesis" (Phil. Trans. Royal Society 1952)**
Two coupled diffusion equations with feedback produce the patterns
of coral, leopard spots, zebra stripes, fingerprints, seashells.
Slow-building animation: looks like nothing for ~500 frames, then
organic patterns emerge and you can't look away.
- Karl Sims' tutorial: https://www.karlsims.com/rd.html (canonical browser-shaped intro)
- Gray-Scott variant is the commonly-implemented form

**Lindenmayer, "Mathematical models for cellular interactions in development" (J. Theor. Biology 1968)**
L-systems. Recursive grammar that produces trees, ferns, flowers,
river networks. See expanded section below — this is the one I'd
recommend most.
- Canonical reference: Prusinkiewicz & Lindenmayer, *The Algorithmic Beauty of Plants* (1990), free PDF at http://algorithmicbotany.org/papers/abop/abop.pdf
- One of the most beautiful CS books ever published

**Perlin, "An Image Synthesizer" (SIGGRAPH 1985)**
Gradient noise. Underlies basically all naturalistic procedural
texture in computer graphics. Combined with flow fields (particles
following the gradient), produces gorgeous organic motion. Three
lines of math, four decades of influence.
- Original paper: https://dl.acm.org/doi/10.1145/325165.325247
- The Book of Shaders chapter: https://thebookofshaders.com/11/

**Witten & Sander, "Diffusion-Limited Aggregation" (Phys. Rev. Lett. 1981)**
Random walk + sticking = frost, lichen, electric arcs, river
deltas. The algorithm is literally "particles do a random walk
until they touch the cluster, then freeze." A few lines of code.
Could be a "growing-on-hover" effect on portfolio cards.
- Paper: https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.47.1400

### Agents and behavior

**Reynolds, "Flocks, Herds, and Schools" (SIGGRAPH 1987)**
Boids. Three rules per agent — separation, alignment, cohesion —
produce convincing flocks, schools, herds. Endlessly useful for
portfolio sites: cursor-following swarms, decorative birds across
the top of a page, particle systems that react to mouse position.
The implementation is small; the design space is huge.
- Paper (full pseudocode): https://www.red3d.com/cwr/papers/1987/
- Reynolds' updates page: https://www.red3d.com/cwr/boids/

### Sound (an underexplored direction)

**Karplus & Strong, "Digital Synthesis of Plucked-String..." (Computer Music Journal 1983)**
Physically-modeled plucked strings using a delay line + averaging
filter. ~20 lines of JS, produces beautiful realistic
guitar/harp/sitar sounds depending on parameters. With Web Audio
API this is browser-native. Click any UI element, hear a
satisfying note. The space of "websites that have thoughtful sound
design" is mostly empty — this would be a differentiator.
- Paper: https://www.jstor.org/stable/3680062
- Tone.js has Karplus-Strong as a built-in primitive if you want to skip the implementation

### Placement and sampling

**Bridson, "Fast Poisson Disk Sampling in Arbitrary Dimensions" (SIGGRAPH 2007)**
Places points randomly but with a minimum distance between them.
The output looks much more natural than uniform random (which
clumps) or grid-aligned (which is mechanical). Used everywhere
natural-looking-but-not-mechanical placement is needed: foliage,
stars, decorative dots, particle initial conditions. ~50 lines.
- Paper: https://www.cs.ubc.ca/~rbridson/docs/bridson-siggraph07-poissondisk.pdf

### A newer one with HN momentum

**Gumin, "Wave Function Collapse" (2016)**
Not from a 1980s paper, but the same shape of "simple algorithm
produces magical output." Generates tile-based content that
satisfies adjacency constraints. Has had several HN front-pages
and become a thing in indie game dev. The output is striking —
coherent landscapes, cities, patterns assembled from small tile
sets. Could be its own portfolio piece.
- Original repo: https://github.com/mxgmn/WaveFunctionCollapse

---

## L-systems, expanded

If you do one of these next, this is the one I'd recommend.

### The intuition

An L-system is a *rewriting rule*. You start with a string (the
"axiom") and a set of rules that replace each character with
another string. You apply the rules to every character in
parallel, and repeat.

The classic textbook example is algae growth from Lindenmayer's
original 1968 paper:

```
Axiom:  A
Rules:  A → AB
        B → A

Generation 0:  A
Generation 1:  AB
Generation 2:  ABA
Generation 3:  ABAAB
Generation 4:  ABAABABA
Generation 5:  ABAABABAABAAB
```

That string is then interpreted as drawing instructions. The
turtle-graphics convention is:

```
F  →  draw a line forward
+  →  turn left by some angle
-  →  turn right by some angle
[  →  push current position/heading onto a stack
]  →  pop position/heading from the stack
```

With those primitives, a rule like:

```
Axiom:  F
Rule:   F → F[+F]F[-F]F
Angle:  25.7°
```

…produces a tree. Five generations in, a *convincing* tree. The
branches go off into branches that go off into branches. Adjust
the angle and you get different species. Add stochasticity to
the rules and every tree is unique.

### Why it's beautiful

1. **Self-similarity is intrinsic.** Trees are self-similar at multiple scales. So are river networks, lightning, snowflakes, lung airways, blood vessels. L-systems get this for free because the rules apply recursively.
2. **The grammar is editable in real time.** Change one rule, regenerate, see a wildly different plant. This is intoxicating to play with.
3. **It's compositional.** A flower can be `F[+L][-L]F[+L][-L]X` where `L` is "leaf" with its own rules and `X` is "blossom" with its own rules. Each subgrammar is independently designable.
4. **The math is teachable.** You can explain L-systems on one page. Most procedural-generation techniques can't claim that.
5. **The output is gorgeous.** *The Algorithmic Beauty of Plants* — the canonical reference — is one of the most visually stunning CS books ever made. Reading it is its own pleasure.

### What a good browser-native L-system project might look like

Nobody has made a really great L-system playground for the web.
The opportunity:

- A two-pane interface: grammar editor on the left, canvas on the right
- Live regeneration as the user edits rules
- Animated growth (one generation per second) rather than instant draw
- Stochastic rule support (each `F → F[+F]F[-F]F | F[+F]F` chooses randomly among alternatives, weighted)
- Parametric L-systems (rules with arguments: `F(x) → F(x*0.7) [+F(x*0.7)] F(x*0.7)`)
- A gallery of pre-made grammars users can fork: tree, fern, dragon curve, Koch snowflake, Sierpinski, river network, etc.
- Export to SVG for further use in design work
- Maybe: 3D variant (turtle in 3D, with `&^/\` for pitch/roll commands)

The technical surface is small (a few hundred lines for the core
engine). The product/design surface is huge (how do you make
grammar editing feel natural to someone who's never seen a
context-free rewriting rule?). That's the real opportunity here —
it's a design problem disguised as a math problem.

### Variations and extensions to know about

- **Stochastic L-systems** — rules with multiple right-hand sides chosen probabilistically
- **Context-sensitive L-systems** — rules that depend on neighboring characters
- **Parametric L-systems** — characters carry numeric parameters (length, angle, age)
- **Environment-sensitive L-systems** — rules that respond to external fields (light direction, obstacle avoidance)
- **3D L-systems** — turtle has full 3D orientation, characters for pitch/roll
- **Differential L-systems** — continuous-time growth rather than discrete generations

### Resources to start with

- *The Algorithmic Beauty of Plants* — Prusinkiewicz & Lindenmayer (1990) — free PDF: http://algorithmicbotany.org/papers/abop/abop.pdf — read at least chapter 1
- Paul Bourke's L-system pages: https://paulbourke.net/fractals/lsys/
- Karl Sims' page on growth & form: https://www.karlsims.com/
- Algorithmic Botany (the project Prusinkiewicz still runs): http://algorithmicbotany.org/

### Anticipated debugging stories

Things that will go wrong (and become good documentation):

- **Stack overflow on deep recursion.** You'll generate strings of length 10⁶+ at high generations. The string-rewriting approach hits memory limits fast. Move to lazy evaluation or generator-based rewriting.
- **Turtle drift.** Floating-point accumulation in the turtle's position over millions of forward steps. Fix with periodic snap-to-grid or by tracking position in a more numerically stable way.
- **Aesthetic vs. fidelity.** Real plants don't quite follow L-system rules. Where do you stop adding biological realism? This is a *design* call disguised as a technical one — the kind of decision a Design Engineer makes.
- **Performance with stochasticity.** Re-rolling the random seed on every edit destroys flow. Persistent seeds, or "lock this branch" gestures, become a UX problem.

The debugging stories from L-systems would probably read closer
to "I spent two weeks figuring out how to make grammar editing
feel like drawing" than "I spent two weeks debugging math." That
might actually be a more interesting story to write than Washes'.

---

## How to pick one for your portfolio

The question is what *role* you want the next piece to play.

| Goal | Best fit |
|------|----------|
| Second showcase library like Washes | Reaction-diffusion or L-systems. Both have the "slow magical reveal" quality and document well. |
| Page transition collection | Boids (assembling/scattering), L-systems (growing), Stam fluid (dispersing). Different transitions for different moods. |
| Interactive playground | L-systems grammar editor, or Wave Function Collapse. Lets visitors create something. |
| Hero ambient background | Perlin flow fields, Turing reaction-diffusion, or DLA. Slow, never-twice-the-same. |
| UI feedback sound | Karplus-Strong on hover/click. Almost no one does this. |
| HN postmortem post | Whichever one has the best debugging story. You can't predict this in advance — pick the project you'll enjoy, build it, and the story will appear. |

---

## Doing this well

Finish Washes first. Ship it. See what the response is. The
next project will look different after one round of public
feedback.

When you do pick, the meta-pattern up top is the actual heuristic
to apply. Six criteria, all of them either passable or
non-passable. If a project candidate fails any of them, it's the
wrong project. If it passes all six, it's worth two weeks of
focused effort.

And one more thing worth saying, because it bears on how to
think about all of this: the value of these projects isn't the
algorithm. The algorithms are public, the math is published, the
techniques are decades old. The value is *taste* — what you pick
to build, how you scope it, how you make it feel, how you
document it, and how you talk about it. That's the part that's
yours. The L-system grammar is Lindenmayer's; the L-system
*playground that someone wants to spend an hour in* is yours.
