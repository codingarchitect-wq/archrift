# Diagram kit

Shared by the Diagrams views: `../erd` (Tables) and `../classes` (Classes),
both in the toolbar's **Diagrams** menu. Like `../arc42-kit` (whose boards,
slabs, ink and labels it builds on), this folder has no `index.ts`, so the
registry doesn't take it for a view. Each file's header says more.

- **`text.ts`**: `TextLayer`, crisp text lying on a surface, as many rows as
  the cards need (the screen-space labels stop at 150). Glyphs are drawn once
  into one shared 2048² atlas as signed distance fields (`sdf.ts`), and each
  glyph is an instance of one quad in a single mesh: a diagram's text is one
  draw call. Runs carry a tone and an owner and are painted again on theme or
  selection change without being rebuilt (`paint`); `width` measures. Text
  too small on screen to read fades out.
- **`metrics.ts`**: the fonts and their advance widths, so sizes are computed
  without a canvas (and unit-tested).
- **`card.ts`**: `CardContent` → `shapeCard`: a title band, rows, how many
  show ("+N more"), the card's size.
- **`draw.ts`**: `drawCard` (a slab with a paper top, a tinted title band,
  striped rows that are pickable plates, a rim) and `drawLink` (a connector
  with end marks `triangle`, `arrow`, `bar`, `bar-ring`, `crow-ring`).
- **`layered.ts`** and **`arrange.ts`**: the pure layout. A layered layout
  (after Sugiyama) per connected group, ranks along one axis (the ERD's
  parents left of their children, the class diagram's bases above their
  subtypes), cycles broken, long ranks wrapped, connectors routed
  orthogonally through the gaps on tracks of their own; groups and loose
  cards packed beside each other.
- **`scene.ts`**: `DiagramScene`, what a view hands the decoration (boards,
  cards, connectors), and `focusOn`.
- **`decoration.ts`**: `DiagramDecoration`, which both views draw with: builds
  the scene into one Drawing and one text layer, paints by the selection (the
  selected card in the accent, its neighbors and their connectors bright, the
  rest faded), opens the selected card above the board with all its rows,
  shows the connectors kept off the board (to a card nearly everything
  references) as arcs while one of their ends is selected, picks cards and
  rows, and fades in. Hooks: `cardOf`, `focusOther`, `rowId`.
- **`layout.ts`**: the engine `Layout` for a scene: pickable boxes, the board
  and card labels, notes. **`frame.ts`**: the home camera.
- **`Legend.tsx`**, **`Picker.tsx`**, **`diagrams.css`**: the panels.
- **`sections.ts`**: each view's label, toolbar order, what it answers and
  what the code can't tell.

## Conventions

- Text wears ink tones (`ink`, `muted`, `accent`), never a series color;
  status (a key, FK, UQ) comes with its glyph or tag, not color alone.
- Far away, a card's title shows as a screen label until the card's own text
  is about 10 px on screen; then the card's text takes over.
- Both color schemes: every color comes from the ink (`../arc42-kit/ink.ts`).
