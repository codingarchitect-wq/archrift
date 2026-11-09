# arc42 kit

Shared by the arc42 views: one view plug-in per arc42 section
(`../context`, `../blocks`, `../runtime`, `../crosscutting`, `../risks`), all
in the toolbar's **arc42** menu (`group: ARC42`). This folder has no
`index.ts`, so the registry doesn't take it for a view.

A view uses the kit so the five read as one family: the same boards, boxes,
connectors, colors, labels and legend.

- **`sections.ts`**: each section's chapter, title, menu label, toolbar `order`,
  what it answers (`about`) and what the code can't tell (`limits`). A plug-in
  takes its `label`, `order` and `group` from here.
- **`ink.ts`**: the diagram colors from the viewer's theme (`inkOf(ctx.theme)`).
  A *tone* names a color: `board`, `edge`, `paper`, `ink`, `line`, `muted`,
  `accent`, `danger`, `warn`, `ok`, `ground`, `background`, `cat:<n>` (the n-th
  categorical color; layers use `cat:<layer index>` in every arc42 view), or
  `#rrggbb`. `toneColor(ink, tone)` resolves one; `fade(color, ink, k)` sinks a
  color toward the ground for what isn't selected.
- **`sketch.ts`**: `new Sketch()` collects primitives and `build()`s them
  into a `Drawing` (two merged meshes: lit solids, flat ink).
  - Flat ink on a `Surface` (`GROUND`, `level(y)`, `wall(z)`): `plate`,
    `frame`, `ribbon` (rounded bends, dashes, arrowheads), `disc`, `ring`,
    `polygon`. It's drawn in the order added, later on top; `lift` raises it.
  - Lit solids: `slab` (a rounded box on a surface), `solid` (any three.js
    geometry, e.g. a cylinder for a database), `tube` (along a curve through
    world points).
  - Every primitive has a `tone` and an `owner` (your number for what it
    stands for). `drawing.paint((tone, owner) => color)` colors it, again on
    every selection or theme change, without rebuilding. `drawing.pick(ray)`
    returns the owner hit (-1: something without one; undefined: nothing).
- **`board.ts`**: `board(sketch, surface, rect)` draws the sheet a diagram
  sits on and returns where its caption and heading go. Lift ink on a board
  by `ON_BOARD`.
- **`flows.ts`**: `new Flows(paths)`, dots travelling along paths to show
  direction. Call `animate(time)` from the decoration's `animate`. With
  reduced motion they stand still.
- **`blocks.ts`**: `topBlocks(world, isShown)` finds the top-level building
  blocks. It goes down from the root through folders that hold nearly all
  the code (`src/`) to where the code splits, and keeps what lay beside the
  way (`prisma/`, the root's own files) as blocks of their own. Views that draw
  the top-level blocks (§5's level 1, §8's pillars) use it, so they agree.
  `layerOfBlock` gives a block's majority layer.
- **`anchors.ts`**: `anchor(layout, id, point, width)` puts an undrawn box
  where a label goes; `stand(layout, id, box)` gives a node the diagram draws
  itself a pickable box (with `hideBoxes`).
- **`Legend.tsx`**: `<Arc42Legend section="blocks">` with `<Swatch>`es as
  the view's `Legend`. It shows the chapter, what it answers and its limits.
- **`arc42.css`** (comes with the legend): label classes `a42-title`,
  `a42-heading`, `a42-name`, `a42-small`, `a42-pill`, `a42-accent`,
  `a42-danger`, `a42-warn`, `a42-dim`, and `a42-left`, which starts a label at
  its anchor instead of centering it.

## Conventions

- **Boards:**
  - A diagram sits on a board with the caption `arc42 §<n> · <title>` (class
    `a42-title a42-left`) and a heading (`a42-heading a42-left`) in its top-left
    corner.
  - Use `ground: true` with the board on the ground, or `ground: false` when
    boards float.
- **Building blocks** are slabs with a `paper` top. Their walls are tinted
  with the layer or area color, or the top is. Connectors are `line` ribbons
  with arrowheads; the selection and its relations are `accent`, and the rest
  fades.
- **Selection:** a click selects the node a thing stands for: a file
  (`f:`), a folder (`d:`) or a package (`x:`). A group id (`layer:<name>`,
  `module:<n>`) works only while the toolbar groups by it, because that's
  what the inspector reads. The view dims what isn't related.
- **Both color schemes:** take every color from the ink, never a fixed hex
  that only works on dark.
- **Motion:**
  - Fade a new drawing in (`setOpacity`) over ~600 ms.
  - Flows move while the view is shown.
  - With reduced motion, nothing moves.
