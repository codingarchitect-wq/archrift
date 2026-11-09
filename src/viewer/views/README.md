# View plug-ins

Every folder here with an `index.ts` (or `index.tsx`) whose default export is a
`ViewPlugin` (`types.ts`) is a view. `registry.ts` finds it, the toolbar gets a
button after City, Layers and Galaxy (keys 1–9 in toolbar order), and
`?view=<id>` opens it. Adding a view touches no other file.

Plug-ins with the same `group` share one toolbar button, a menu named after
the group, placed where the first of them would be. Its key (1–9) steps through
them. The arc42 views form the group `arc42` and draw with the shared kit in
`arc42-kit/` (see its README). The Diagrams views (`erd`, `classes`, group
`Diagrams`) draw with `diagram-kit/` (see its README): cards with rows of
text, a layered layout with orthogonal routing, and a decoration that paints
by the selection, opens the selected card and picks rows.

## What a view does

- **`layout(ctx)`** returns a `Layout` (`../layouts/types.ts`): one box per node
  id it shows. Set `view` to the plug-in's id.
  - The engine draws boxes as buildings, districts, planes or externals by
    `placement`, in the layout's `shape` (`box` or `sphere`).
  - It tweens from the previous view.
  - It picks, labels, frames the selection and flies to boxes.
  - Reuse `../layouts/*` (`cityLayout`, `squarify`, `childrenOf`, `weighTree`) where they fit.
  - Return `undefined` while a layout is computed off the main thread, then call `ctx.refresh()` when it's ready (never synchronously from inside `layout`).
- **Layout switches:**
  - `hideBoxes: true`: boxes stay pickable, selectable and labelled, but the view draws its nodes itself.
  - `arcs: 'none'`: the view shows dependencies its own way.
  - `openFile: 'floors' | 'moons' | 'none'`: how a selected file opens.
  - `keepView: true`: selecting keeps the camera while the node is in view (a diagram read whole).
- **`edges: false`** hides the toolbar's edges option, for a view that draws no dependencies (or only its own way, regardless of it).
- **`groupBy: false`** on the plug-in hides the toolbar's group option, for a view it means nothing to. Otherwise `ctx.grouping` holds the groups (detected modules, layers, configured groups), or null by folder.
  - `ground`, `home`, `center`, `size`: the camera.
- **`decoration(ctx, engine)`** returns a `ViewDecoration` (`../scene/decoration.ts`), created when the view is shown and disposed of when it isn't:
  - `object`: its own three.js content.
  - `animate(time)`: called every frame while it returns true.
  - `pick(raycaster)`: returns `{ id, kind }` for a node it draws, `null` for "mine but not a node", or undefined to fall through to boxes.
  - `update(ctx, layout)`: runs after every change to colors, selection, options or the graph.
  - `stats()`: counts for tests.
  - `dispose()`: free geometries, materials and textures.
- **Optional hooks:**
  - `labels(ctx, layout)`: extra labels.
  - `colors(ctx, layout, map)`: adjust colors; the map holds what the color option chose.
  - `routeArc(ctx, layout, arc)`: set `arc.points` to route an arc, or return null to drop it.
  - `layoutKey(ctx)`: recompute the layout when this changes.
  - `Controls`: a React component shown in the toolbar while the view is.

## What `ctx` offers

- `s`: the whole state. Read it; don't write it.
- `world` and `visibility`: nodes and the filters.
- `graph`: file-level dependencies under the filters, with `out`, `in` and `weight`.
- `grouping`: detected modules or layers, when chosen.
- `layers()`: `order` and `layerOf`.
- `theme`: colors from the CSS tokens.
- `refresh()`.
- Graph data:
  - `world.graph.meta`: `cycles`, `violations`, `rules`, `history`, `layers`.
  - Node metrics: `loc`, `complexity`, `fanIn`, `churn`, `hotspot`, `lastCommit`, `firstCommit`, `testReach` …
  - `world.coChanges(id)`, `world.links(id)` and `world.index`.
- Colors: `../colors.ts` has the palettes and `heat(t)`.

## Rules for a plug-in

- **A worker:** write it as `new Worker(new URL('./x.worker.ts', import.meta.url), { type: 'module' })`. An exported page (`archrift export html`) inlines it and starts it as a classic worker from a blob, so it must bundle into one file: no dynamic imports, and nothing that relies on `import.meta`.
- Import from `../layouts`, `../scene`, `../colors.ts`, `../world.ts`, `../../core/*` and `three`. From `../controller.ts`, import **types only**. `../store.ts` is safe to import, even outside a browser: `Controls` may use `store`/`actions`, although the views so far keep their own options in small stores of their own. Anything shared you'd have to change is worth a note in your report rather than a refactor.
- Keep it fast at 10k files (instancing, one geometry per family, no per-frame allocation). Render on demand: return false from `animate` when nothing moves, and respect `prefers-reduced-motion` for decorative motion.
- Both color schemes: take colors from `ctx.theme` or the CSS tokens.
- **Tests:**
  - Unit tests for the layout math in `tests/viewer/views/<id>.test.ts`, which is pure and deterministic.
  - An end-to-end spec in `tests/e2e/view-<id>.spec.ts`: switch to the view, check `window.__archrift.scene()` (boxes, `decoration` stats), select something, switch back. Use `serverUrl('plainTs' | 'fullstack' | 'history' …)` from `tests/e2e/ports.ts`.
  - Run the suites with `ARCHRIFT_E2E_PORT=<base>` when other checkouts are running theirs.
