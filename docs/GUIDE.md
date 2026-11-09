# archrift: the guide

Everything archrift does, command by command and view by view. The
[README](../README.md) has the overview. Examples run `archrift`
([Install and run](#install-and-run) has the other ways to start it). Paths to
archrift's own files (`src/cli/ask.ts`, `src/viewer/views/`) are relative to
its repository.

A 3D architecture visualizer for codebases in TypeScript/JavaScript, Kotlin
and Go, from one app to a system of services. How the arc42 views could work
on any project is in [docs/ARC42-GENERIC.md](ARC42-GENERIC.md); the
polyglot readers and the links between services in [docs/POLYGLOT.md](POLYGLOT.md);
how many ways a codebase does each job in [docs/COHERENCE.md](COHERENCE.md);
asking before a change and reviewing after it, for agents and people, in [docs/QUERY.md](QUERY.md).

**What it has:**
- the analyzer, with framework plugins
- `archrift serve`, with `--watch`
- switchable views (City, Layers, Galaxy and six plug-ins)
- the arc42 views: the sections of an arc42 architecture document drawn from the analysis
- the tools for tangled code
- architecture rules, with `archrift check`
- git history: hotspots, co-change, and a timeline over snapshots
- systems of services: Kotlin (Spring), Go and Avro beside TypeScript, and the links between the parts (HTTP calls, Kafka topics, databases)
- coherence: how many ways the code does each job (dates, HTTP calls, test doubles …), with `archrift coherence` and a view
- questions before a change (`archrift query`: how a folder does a job, what may depend on what, how two parts connect) and what a change does to the architecture (`archrift diff`, for pull requests)
- an optional hook for Claude Code (`archrift hook install`): before the agent writes a code file, the file's rules and its folder's ways go into its context
- names and descriptions for the code (`archrift describe`): what each block, feature, folder and file is for, kept beside the config and shown in the viewer, search and `query`
- questions in plain words (the viewer's **Ask**): Claude Code on your machine reads the code and the map, read-only, and the answer lights up on the map
- the change in progress in the viewer (**Changes**): `archrift diff` against the base, the changed files lit, with the coding agent's notes on why
- a first look at a project it hasn't seen (`archrift init`): a starter config written into the project, and a report
- documents and decisions linked to the code (config `docs`): which documents name a file, folder or function, where the decision ids the code cites (`D34`, `ADR-12`) are defined, and in `diff`, the documents kept current that name what a change removes or reshapes

Still open: faster live updates at 10k files (see Known limits).

## Install and run

archrift needs Node.js 22.18 or newer, and git. The Ask bar and the hook
also need the Claude Code CLI.

```bash
npm i -g archrift                # then: archrift <command>
npx archrift <command>           # without a global install
archrift --version
```

From a checkout of the repository:

```bash
git clone https://github.com/codingarchitect-wq/archrift && cd archrift
npm install && npm run build     # the viewer into dist/, the command line as JavaScript into lib/
node src/cli/main.ts <command>   # or npm link once, then archrift <command>
```

A linked checkout runs its TypeScript source directly (Node strips the
types), so an edit counts at the next call. The package from npm runs the
built `lib/` instead.

The commands archrift prints itself (init's lines for CLAUDE.md or
AGENTS.md, the hook's notes, the command the hook installs) use the one it
was started with: `archrift`, `npx archrift` or `node <path>/src/cli/main.ts`.

**Where its files go:**
- **The project's own folder** is `<project>/.archrift/`: the config and the descriptions, meant for git, and the results beside them (graph, cache, snapshots, saved views, exported pages), which git ignores. A `.archviz/` folder, from archrift's former name, is still read when there's no `.archrift/`.
- **archrift's home folder** is `~/.config/archrift/` (`$XDG_CONFIG_HOME/archrift`; `ARCHRIFT_HOME` moves it). It holds:
  - `projects.json`: the viewer's project list (local paths);
  - `projects/<name>/`: the results of a project without a `.archrift/` of its own, and its config when that is kept outside the project.
- **`ARCHRIFT_CACHE`** moves every project's results (graph, cache, snapshots, saved views) to `$ARCHRIFT_CACHE/<name>/`, so nothing is written into the project. A sandboxed agent, a CI job or a read-only checkout sets it once instead of adding `--out` to every command. Without it, a cache archrift may not write (`EPERM`, `EACCES`, `EROFS`) is skipped with one warning per folder: the answer is the same, only slower.

## Start on a new project

```bash
archrift init ~/src/my-app            # --dry-run prints the config instead of writing it
```

`init` takes a first look at a project archrift hasn't seen:
1. **It detects** what the project is made of, from its files:
   - languages, and the ones archrift can't read;
   - frameworks and tools, from the package manifests;
   - a monorepo's tsconfigs;
   - code a generator wrote (Prisma's output, files whose header says so), folders git ignores, static files, `vendor/`;
   - a copied-in UI kit (shadcn/ui's `components.json`);
   - the files a framework, the HTML page or a package script loads, so their exports don't count as dead;
   - packages whose dependencies aren't installed (their types stay unknown, so calls into them aren't linked).
2. **It analyzes** the project and proposes the **layers** its folders already keep: each block (the folders its code splits into) on the level of its longest chain of runtime imports.
3. **It adds starter rules, all errors:**
   - the rules: no import cycles; imports point down the layers; function complexity under 10 in logic and under 20 in UI blocks (copied-in kits and tests aside);
   - `check` fails until the code keeps every one of them; the report counts what breaks each today;
   - `diff` fails only on a change that breaks one again or further, so work goes on while the old cases are fixed (a rule set to `"severity": "warn"` by hand only reports).
4. **It writes** `<project>/.archrift/config.json`:
   - the results go beside it (graph, cache, snapshots, saved views, the report), with a `.gitignore` that leaves only the config and the descriptions for git;
   - it adds the project to the viewer's list (`~/.config/archrift/projects.json`), so `query` and `diff` find it from inside the project, and in its worktrees with no `--config`.
5. **It reports** what it found:
   - stack and size, layers, import cycles, hotspots, jobs done several ways, function complexity, dead exports, the rules;
   - the **bridges**: the production files the most shortest dependency paths between two other files run through (betweenness), that connect two blocks other than their own or more; a change there ripples furthest;
   - up to 7 **questions worth asking**, the types taking turns: why a bridge ties its blocks together; files that change together without depending on each other (git history); much-used files that are also hotspots; files nothing uses that no framework loads; blocks the dependencies split into 3 modules or more (Louvain); links guessed from names across blocks;
   - on stdout (`--format markdown` or `json`), and as `.archrift/first-look.md` and `.archrift/first-look.html`;
   - it ends with the commands to go on with, and the lines for a coding agent's CLAUDE.md or AGENTS.md (it never edits those files).

A project that has a config keeps it: `init` then analyzes and reports again. `--force` detects again and replaces the config.

## Explore a codebase in 3D

```bash
archrift serve ~/src/my-app --open   # http://127.0.0.1:4300; its config is ~/src/my-app/.archrift/config.json
```

`serve` analyzes the codebase first; a warm cache makes that take seconds. It
then serves the viewer and a read-only API on 127.0.0.1. The npm package
carries the viewer built; in a checkout, `npm run build` builds it into
`dist/viewer` first.

**Other projects:** the project's name in the toolbar is a menu.
- It lists every project `serve` knows, and opens another: that project is analyzed (with progress shown) and the page starts over on it.
- **Add a folder** takes a path (pasted or typed; `~` works). **✕** forgets a project, and its files stay.
- A link keeps the project (`?project=<name>`).
- The list lives in `~/.config/archrift/projects.json` (it holds local paths), and remembers the project opened last.

`serve` adds the folders you give it, and opens the first:

```bash
archrift serve ~/src/other-app ~/src/third-app --watch --open   # both join the list; other-app opens
archrift serve                                                  # the project opened last
```

- TypeScript comes from the folder's `tsconfig.json` (without one, every JS/TS file under it is analyzed); Kotlin, Avro and Go files are found wherever they are.
- A config (layers, rules, targets, excludes) is optional. Put it in `<project>/.archrift/config.json` (`archrift init` writes one), or pass it with `--config` (for the first folder; the project list remembers it).
- **A config kept outside its project**, for a repository you can't or won't write into, can live in archrift's home folder: `~/.config/archrift/projects/<name>/config.json`, with its `descriptions.json` beside it. The project's entry in `projects.json` points at it with `"config"` (`archrift serve <folder> --config <file>` writes that).
- Each project's graph, cache, snapshots and saved views go next to its config when that is in the project (`<project>/.archrift/`), else to `~/.config/archrift/projects/<name>/`. `--out` and `--views` move them.
- One project is open at a time, and switching affects every open tab. For two side by side, run a second server with `--port` and `--projects <another list>`.

**A system of services:** archrift reads an Angular or other TypeScript
frontend beside Kotlin (Spring) and Go services, and links them by HTTP
calls, Kafka topics and databases ([docs/POLYGLOT.md](POLYGLOT.md)).
`mounts` join repositories kept apart, and a config `groups` entry per
service groups the files by service (*group → by configured group*).
**Saved views** then make the ways in, for example:
- **Frontend:** the web apps alone.
- **Backend:** the services and libraries, with their topics and databases.
- **System:** the arc42 §5 building blocks by service, linked only by HTTP calls, topics and databases. Services that meet only at a topic are linked too: a subscriber depends on the publishers.

In the runtime view (§6), a web page's scenario follows the component's
lifecycle, the actions it dispatches and the effects that take them, across
the network to the Kotlin handler and down to the tables; each controller is
a scenario of its own.

With **`--watch`**, saving a file updates the open viewers within about a
second. Only what changed is re-analyzed; files that depend on a changed file
are left alone unless its declarations or exported types changed. The city
grows, adds or sinks buildings in place, and keeps the camera, selection and
filters. A **live** badge in the toolbar shows the last change. Press **`?`**
for the keyboard and mouse cheat sheet.

- **Views** (keys `1`–`8` or the toolbar), with every box animated to its new place:
  - **City:** directories are districts and files are buildings.
  - **Layers:** one plane per architecture layer, top layer highest. Dependencies that point up are red, and the legend counts them. The layers come from the config's `layers`, or are derived from dependency depth when there are none.
  - **Galaxy:** files are stars placed by a 3D force simulation run in a Web Worker, grouped by area. A selected file's symbols circle it as moons.
  - **Matrix:** a dependency structure matrix in digital rain.
    - Rows and columns are files, ordered by layer and folder, and a lit cell means the row uses the column.
    - Dependencies pointing up the layers are red. Cycles and broken rules have colors of their own.
    - The rain falls faster down files that change often, and bursts down a column when you save that file in watch mode.
    - Above 1,500 files, the rows are folders.
  - **Wheel:** files on a ring by folder, with folders as nested bands, and dependencies bundled through the middle (hierarchical edge bundling). It's the quickest picture of what's tangled with what. Hovering a band lights up its bundles.
  - **Terrain:** the City melted into a landscape.
    - Height is complexity, lines, churn or hotspots (chosen in the toolbar), so hard code rises as mountains, and the highest peaks are labelled.
    - Dependencies run over the ground like rivers.
  - **Tree:** folders as branches and files as leaves, with hotspots hanging as red fruit. On the timeline, the tree grows through the history.
  - **Transit:** a subway map of the requests. Each page is a line that runs down the layers to the data it reaches, and files that several lines share are interchanges. Choose which lines show in the toolbar.
  - **Coherence:** how many ways each job is done, after the essay [Decoherence](https://maevyn.codes/decoherence) ([docs/COHERENCE.md](COHERENCE.md)).
    - The toolbar's report ranks the jobs the code does several ways (dates, HTTP calls, test doubles …): least coherent within folders first, each as a bar of its ways.
    - **City:** pick a job, and buildings take the color of their way (the main one blue, several at once magenta); arcs mark dependencies between two ways. With no job picked, files glow by how many jobs they do differently from their folder.
    - **Clouds:** the essay's pictures. Files are dots pulled together by their dependencies, one small cloud per job side by side: colors gathered in lobes is coherent, speckled is mixed. Click a cloud to open it. Color the dots by way (the culprits stand out) or by folder or group (the lobes do, culprits ringed). The key reads like the essay's legend (dot, size, color, line); docs/COHERENCE.md says where the clouds differ from the essay's pictures.
    - The **edges** option picks the lines in both modes: the view's own (auto), all, the selection's, the rule breakers', or none.
  - Each view is a plug-in in `src/viewer/views/`, and `src/viewer/views/README.md` explains how to add one.
- **Minimap** (bottom left): the layout from above plus what the camera sees. Click it to move there.
- **Getting around:** drag to orbit, right-drag to pan, scroll to zoom. Click a building (a file) to select it; its symbols then show as floors, and those are clickable too. Click a district (a directory) to select it.
- **Inspector:** metrics, the symbols in the file, and what the selection uses and what uses it. Click any row to follow it: the camera rides the arc there. Use `Alt+←`/`Alt+→` or the arrows to go back and forward, the breadcrumbs to move up, and `Esc` to clear the selection.
- **Symbols:** the inspector shows the signature and references grouped by kind. Expand a row (▸) to see every place a reference occurs; clicking one opens the highlighted source there. There's also **Open in VS Code**.
- **Search:** `⌘K` searches files and symbols (`pl` finds `ProjectList`).
- **Options:** the edges shown (*auto*: everyone's, folded as needed, until something is selected, then only the selection's; *all*: everyone's even with a selection; *selection*; *violations*: only the dependencies that break a rule, a selected file's own bright; *none*), color (area, complexity, fan-in), build target, tests, packages.
- **Links:** the URL keeps the selection (`#n=<id>`) and every option (query), so a link reopens the same view.

Tools for tangled code:
- **Focus:** with a file, directory or package selected, choose what it *uses*, what it's *used by*, or both, 1–3 steps deep or all the way. Arcs fade with distance and everything else is ghosted.
  - **Impact:** everything that depends on the selection, directly or not.
  - **Dependencies:** everything it depends on.
- **Find path…:** pick a second node to see every shortest dependency path between the two. If there's none, it tries the other direction.
- **Group by** folder, *feature*, *detected module* (Louvain on the file dependency graph), layer, or configured group. Detected modules become districts that hold the folders their files come from, so you can see where structure and dependencies disagree.
- **Features** (*group by → feature*) are the vertical slices a user would name (orders, accounts, billing …), found across the layers the code is folded into (`src/core/features.ts`).
  - **Where they come from:** each page and API route seeds the feature named by its first route segment, and layouts seed the *app shell*. Transports like `/api/trpc` don't count.
  - **What a feature reaches:** what its code runs at function level: calls, renders, `new`, tRPC calls, queries, and through an interface to the classes implementing it. So one shared service class doesn't tie the features together.
  - **Who owns a file:**
    - a file named after a feature belongs to it (`routers/orders.ts`, `order-history.ts`);
    - else a file one feature reaches belongs to that feature;
    - else one a few reach belongs to the feature whose files use it most;
    - code many features use is *shared*, split by area (*shared · lib*, *shared · components*).
  - **Folders of common code** (a UI kit) stay shared as a whole.
  - **Needs routes:** features come from Next.js pages and API routes. Without them the option doesn't appear.
  - **Config:** `features.merge` and `features.exclude` name, merge or drop routes.
- **A directory's** inspector lists its import cycles (click one to show it) and the modules its files fall into.
- **Filters** (kept in the URL): which edge kinds count as dependencies, globs of files to hide, a minimum size, only files in import cycles, and whether to bundle arcs. Color can also be *group* or *import cycles*.
- **Arcs adjust to the zoom.** Background arcs fold into directories or groups until at most 600 remain, drawn in three widths by weight. When the camera settles close in, only dependencies near its focus count, so the arcs get finer. In City and Galaxy they're bundled along the folder tree.
- **Changes** (toolbar) is `archrift diff` in the viewer: the working tree against its base (where the branch left main; on main, HEAD).
  - The changed files light up (*color → the change in progress*: new green, changed blue, a warning amber, a broken rule or new cycle red) and the camera frames them.
  - The inspector lists what the diff finds, each finding on its file (a new violation opens as the Rules panel shows it), then every changed file with its lines added and removed.
  - A changed file's inspector says how it changed, and what the diff finds in it.
  - Why each file changed comes from the coding agent, if it wrote `.archrift/changes.json` (the request, a summary, a note per file; docs/QUERY.md has the format): the notes show beside the files.
  - **Edges**: the arcs among the changed files only (the default: how the change hangs together), or to every file they use or are used by (what it touches); one step, both ways, whatever the Focus bar says. The toolbar's edges option still turns them off.
  - **Compare** picks the range: the change in progress (the default above), the last commit, one commit (against its parent), or everything since a commit (its commits and the change in progress). A range of commits lists them with their messages; the agent's notes belong to the change in progress, so they show only with it. The map stays the working tree: a file changed since shows as it is now.
  - The first comparison analyzes the base (about 6 s for archrift's own repository); each revision analyzed stays in memory, so the next ones, and those after each live change in watch mode, take a fraction of a second. **Compare again** after a commit, or when the notes changed.
- **Saved views** (menu in the toolbar) store the options, the selection and the camera as JSON in `--views <dir>` (default: `views/` beside the graph), ready to commit and share.
- **Rules** (toolbar, when the config has `rules`) lists every rule with its violations, broken ones first. Click a violation to see it:
  - The dependency, or the whole path, is drawn in red, for an error and a warning alike (the panel marks errors ✗ and warnings !).
  - The viewer switches to the build target the violation happens in.
  - The inspector explains the violation, marks the file that imports what it shouldn't, and steps through the rule's other violations.
  - *Color → rule violations* marks every file involved.
  - A broken limit names its file or function, the measure and the bound.
  - A rule that matches nothing says which pattern, and counts once.

## Ask the map

The toolbar's **Ask** (key `/`) takes a question in plain words: "How does a
sign-in reach the database?", "What breaks if I change this?". Asked with
something selected, the question is about it (**Ask about this** in the
inspector does the same).

- **Who answers:** Claude Code (`claude -p`) on this machine, in the project's folder, on your own sign-in. It may only read: Read, Grep and Glob on the code, and `archrift query` (with `overview` and `find` to start from), answered from the graph the viewer shows (written to disk for it, live changes included). No other tool, no MCP servers, and no session kept: a follow-up brings the last questions and answers along. Environment files (`.env*`), keys and certificates, `secrets/` and `certificates/` folders and `credentials*` files are denied to it whatever it is asked (`SECRETS` in `src/cli/ask.ts`). `serve --claude <path>` points at a `claude` elsewhere; without one, the bar says what's missing. `serve --ask-model <name>` picks the model (`sonnet`, `opus`, a full id; default: Claude Code's own), and the bar names it.
- **While it works** (about half a minute), the inspector lists what it reads and asks; **Stop** ends it (so does a page that closes). After 5 minutes it stops by itself.
- **The answer** is a few sentences in the inspector, with the files and functions it cites as links, the nodes it is about (each with its part), a numbered walkthrough when the answer is a sequence, and questions to ask next. On the map, those nodes stay bright, the rest is ghosted, and the walkthrough runs from stop to stop in the path finder's color, each stop labelled with its number. What the agent names that the graph doesn't have is listed apart, never drawn.
- **Not in an exported page**: the question needs the server and the agent.

## Share it as one file

```bash
archrift export html ~/src/my-app      # → ~/src/my-app/.archrift/my-app.html
archrift export html ~/src/my-app --view wheel --source --out ~/Desktop/my-app.html
```

`export html` writes the viewer and the project's analyzed graph into one HTML file (in a checkout, `npm run build` builds that viewer into `dist/static` first). It opens from disk with no server and no network, and has every view, the inspector, search (`⌘K`), Focus/Impact, Find path, the rules, coherence and the saved views (to open, not to change). Its link keeps the view and the selection, as on a server.
- **Where it goes:** beside the project's graph, named after the project: `<project>/.archrift/<name>.html` when its config is there, else `~/.config/archrift/projects/<name>/<name>.html`. `--out` moves it; the command prints where it went and how large it is.
- **The view it opens on:** `--view <id>` (`wheel`, `matrix`, `erd` …), or a viewer link, to carry its options and selection (`--view 'http://127.0.0.1:4300/?view=wheel&group=feature#n=f:src/lib/db.ts'`).
- **What stays out (the file gets shared):** the source, unless `--source`; without it, the source panel says so. Local folders stay out too, so there's no *Open in VS Code*. What needs a server is left out quietly: the project switcher, the timeline, saving views and live updates.
- **Size:** the graph travels gzipped and is decompressed in the browser. archrift's own 387 files make 2.1 MB (the graph 672 KB of it). With `--source` it's 3.5 MB: the files (1.2 MB), and about 220 KB of syntax highlighting, which comes only then.
- `--project <name>` exports a project of the list, `--views <dir>` names the saved views to carry; `--config`, `--no-cache` and `--no-history` work as for `analyze`.

## Draw it with archify

[archify](https://github.com/tt-a1i/archify) renders typed JSON into standalone interactive diagrams (dark and light, focus and reach, image export). Its JSON is usually written by a coding agent reading the code; `export archify` writes it from what archrift computed instead, and prints the archify command that renders each file. archrift never runs archify: install it separately.

```bash
archrift export archify architecture ~/src/shop   # the building blocks, a row per layer, the databases below
archrift export archify erd ~/src/shop            # one ERD per database (--database <name> picks one)
archrift export archify class ~/src/shop --family Order   # a type family, or --folder src/domain
# then, as printed:
node <archify>/bin/archify.mjs finalize erd ~/src/shop/.archrift/shop.db.erd.json \
  ~/src/shop/.archrift/shop.db.erd.html --quality standard
```

- **architecture:** a component per block (the folders the production code splits into, as `init` finds them; UI blocks are archify's frontends), one row per layer (the config's, else the order the imports keep), the databases in a row below. Connections are runtime imports between blocks and queries into a database, thicker for more.
- **erd:** a database's stored columns with their key roles (`pk`, `fk` with what it references, `uk`), and a crow's-foot relationship per foreign key: many children (one when the key is unique), one parent, optional when the key may be null, identifying when it's part of the child's own key. Keys a table has to itself, or to another database, are listed in cards, since archify joins two tables.
- **class:** the types with their attributes and methods (read from the signatures), realization for `implements`, inheritance for `extends`, associations for properties typed as another type; supertypes in rows above their subtypes.
- **Layout:** archify lays out nothing itself, so archrift picks the grid cells (13 × 13 for an ERD or class diagram, 12 columns for architecture): neighbors side by side, ordered so lines cross less. A larger database or family is refused with how many there are.
- The files go beside the project's graph (`--out <dir>` moves them), named after the HTML archify will write. Their `quality_profile` follows archify's guidance (`standard` past about a dozen components, 8 tables or 50 fields), and the printed command passes the same `--quality`.
- Tested against archify's own schemas (`tests/fixtures/archify-schemas`, schema_version 1). `fixtures/schemas` in archrift's repository has databases of every kind to try it on.

## Draw the arc42 sections

The toolbar's **arc42** menu (key `9`, press again for the next one) holds the
[arc42](https://arc42.org) sections the analysis can draw. You don't need any
arc42 documentation: each view says in its legend what it is built from, and
what the code can't tell and needs your words.

- **§3 Context:** the system as a glass tower, one slab per layer, among its neighbors.
  - Users and callers come in on the left. Outside services it calls stand at the back, and data stores in front.
  - Each tie enters the tower at the layer whose code uses it, and dots show which way requests go.
  - Neighbors come from a catalog of well-known packages (Stripe, an SMTP mailer, PostgreSQL, IndexedDB, Electron …) and from the code's database queries. Other packages are libraries, which the legend only counts.
- **§5 Building blocks:** the top-level blocks as boxes in layer rows, with orthogonal connectors.
  - Red connectors point up against the layers, and lollipops mark each block's provided interface.
  - Selecting a block opens its white box on a board floating above, with the neighbors it talks to as stubs on the edge. One more level opens down the selection's folders.
  - The toolbar's *edges* picks the connectors: *auto* the main ones, *all*, the selected block's (*selection*), those that break a rule (*violations*), or *none*.
  - *Group by* turns level 1 into the features, detected modules, layers or configured groups. A group's white box shows the folders its files are in.
  - By feature, the features stand above the shared code. A red connector is then shared code using a feature.
- **§6 Runtime:** one page or API route as a sequence diagram, with the calls in source order.
  - It follows calls, renders, tRPC calls and database queries.
  - An alt fragment holds each implementation behind an interface, and a glass pane marks the network.
  - Activation bars stand out by call depth, and a pulse replays the calls.
  - Pick the scenario in the toolbar. *Group by* merges the lifelines into modules, layers or groups: the scenario between building blocks.
- **§8 Crosscutting:** candidate concepts (code many blocks rely on, with a suggested name) as bands that run across the blocks' pillars. A collar marks each block that uses a band. With *group by*, the pillars are the groups.
- **§11 Risks & debt:** a 5 × 5 risk matrix, how often a file changes against how much depends on it.
  - Files stand as towers in their cells, with rings for debt: an import cycle, a broken rule, hidden coupling, no test, very complex.
  - The ten highest risks are named.
  - **Register** in the toolbar lists every file by priority.

## Draw diagrams

The toolbar's **Diagrams** menu (after arc42) holds two diagrams drawn in the style of the arc42 boards.
- **Tables (ERD):** the database schemas the code declares (`meta.databases`: Prisma, Dexie, SQL migrations, JPA and Mongo entities), one board per database, grouped by module.
  - A table is a card with a row per column: a key for the primary key, FK and UQ tags, the type (a nullable one muted). Relation fields the code navigates are behind a toolbar switch. A long table shows 12 rows and "+N more".
  - Foreign keys join the referencing row to the referenced one, with crow's-foot ends: one or many, and whether the key may be null. Parents stand left of the tables referencing them. Connectors to a table most others reference (`User`) are arcs shown only for the selection.
  - **Selecting a table** opens it with all its columns and lights its neighbors; the legend lists who reads and writes it, by file. Selecting a file lights the tables it queries.
  - The toolbar picks one database or all.
- **Classes:** a family of types joined by `extends` and `implements` (the biggest first, those with classes before; classes sharing only an outside base such as `Error` make a family named after it), or the types declared in one folder (the one selected, or picked) with their associations.
  - UML cards: the stereotype, abstract names in italics, members with their visibility, static ones underlined; a type alias shows what it stands for.
  - Hollow triangles for `extends` (solid) and `implements` (dashed), named arrows for associations (`*` for collections). Bases stand above their subtypes; bases outside the project (`Error`, `Dexie`) are dashed names.
  - Selecting a type opens it with all its members; a member's row selects the member.
- Both draw their text as distance-field glyphs in one atlas (`src/viewer/views/diagram-kit/`), so hundreds of cards stay crisp near and far.
- Not yet: the toolbar's choices (database, relation fields, family or folder) aren't kept in the link or in saved views, and selecting a table or type from search doesn't fly to it.

## Look back in time

When the root is in a git repository, analysis reads its log once per HEAD.

- **Per file:** commits, authors, the last change, and churn (lines changed in the 90 days before the newest commit). The **hotspot** score is churn × complexity.
- **History** (toolbar) shows the counts and the top 10 hotspots, and colors files by churn, hotspot or last change.
- **Changes together with** (a file's inspector) lists files changed in the same commits. It marks those with *no dependency* on the file, which is hidden coupling, and can draw them as arcs.

For the timeline, analyze some older commits first:

```bash
archrift snapshot ~/src/my-app                     # 10 commits spread over the history
archrift snapshot ~/src/my-app v1.0 HEAD~50 …      # or named revisions (--every n: every n-th commit)
```

Each snapshot is analyzed in a temporary git worktree, borrowing today's
`node_modules`, and kept in `<out dir>/snapshots/` by commit. The worktree is
removed afterwards, however the command ends: done, an error, Ctrl-C, or a
SIGTERM (a timeout). It is locked with archrift's process id, so after a kill
nothing can catch, the next archrift that adds a worktree in the repository
removes it, while one whose process still runs (a parallel `diff`) stays.

`serve` then offers **History → Open the timeline**:
- Step or play through the snapshots up to now. The city keeps its layout: files rise from the ground when they're added, grow and shrink with their size, and sink when they're removed.
- Every panel, the source view included, shows that commit.
- *Color → change on the timeline* marks what's new, grew or shrank since the previous point.
- The URL keeps the point in time.

## Check architecture rules

```bash
archrift check ~/src/my-app [--format text|json]
```

`check` analyzes the codebase (the cache makes that fast), then prints each
rule: broken ones first, with their violations, and ✓ for the ones that hold.
It exits 1 when a rule with severity `error` is broken, so it can gate CI.
Warnings never fail it. archrift on itself (trimmed):

```
$ archrift check
archrift check archrift: 0 errors · 236 warnings · 5 rules

! no-cycles (warn): 1  no files import each other in a circle
  src/viewer/ui/Inspector.tsx
      src/viewer/ui/Ask.tsx
    → src/viewer/ui/Inspector.tsx
    → src/viewer/ui/Tools.tsx
    → src/viewer/ui/Ask.tsx

! functions-small-logic (warn): 191  functions outside the viewer stay under complexity 10 (older code is above: split what you touch)
  src/analyzer/go/link.ts › linkGo: complexity 462, more than 9
  …

✓ layers-point-down  runtime imports point down the layers: cli, viewer, server, analyzer, core

✓ node-side-without-viewer  the command line, server and analyzers never load the viewer, directly or through other files: …
```

**A rule that matches nothing is broken too.** Otherwise a renamed folder or a
typo would turn it off and it would keep passing. Each pattern is checked:
a `from`, `to` or `scope` no file matches, a `target` or layer the project
doesn't have, a limit on files that hold no function, a measure nothing
carries. Package patterns (`x:npm:…`) may match nothing, since no file using
the package is what a rule against it wants. Exceptions aren't checked: one
that matches nothing excuses nothing, and the violations show.

```
✗ no-lib-cycles (error): matches nothing  src/lib stays acyclic.
  ? scope src/libs/** matches no file
```

`--format json` prints the rules, their violations and the counts, with
`"schemaVersion": 1` first (see [Config](#config-archriftconfigjson)).

## Measure coherence

```bash
archrift coherence ~/src/my-app [--format text|json]
```

`coherence` analyzes the codebase (cached) and reports how many ways it does
each job of a catalog (dates, HTTP calls, shared state, test doubles, javax or
jakarta …): the jobs mixed within a block first, with their migrations from
legacy ways and whether recent files kept to their block's way, then the
blocks by how many extra ways they make a reader learn. The method and the
catalog are in [docs/COHERENCE.md](COHERENCE.md). archrift on itself (trimmed):

```
$ archrift coherence
archrift coherence archrift: 12 concerns · 10 done one way · 0 one way per block · 2 mixed · 4 of 170 files off their block's main way

Mixed: blocks doing one job several ways, least coherent first
  …
  JS · Shared state: state several components share
    Zustand 27 · external store (useSyncExternalStore) 3
    coherence 90 % within blocks, 90 % overall · off their block's main way 3 · on several ways 0 · transitions 0 of 38 links
    mixed in 1 of 1 blocks: src/viewer (Zustand, external store (useSyncExternalStore))
      src/viewer/views/context/Legend.tsx  external store (useSyncExternalStore)
      src/viewer/views/matrix/controls.tsx  external store (useSyncExternalStore)
      src/viewer/views/terrain/controls.tsx  external store (useSyncExternalStore)

One way
  JS · Test framework: Vitest, 77 files
  JS · Asynchronous code: promises (async/await, then), 33 files
  …
```

## Ask before a change, review after

For coding agents and people (docs/QUERY.md). Run from inside a listed
project, and archrift finds it; otherwise add `--root <dir>`. The examples run
in archrift's own repository.

```bash
archrift query ways src/viewer/ui/NewPanel.tsx --job "shared state"
                    # how its block does the job, the way to follow, files that take it, the files that differ
archrift query rules src/cli/new.ts --to src/viewer/store.ts
                    # would that import break a rule? (also: what it may depend on, without --to)
archrift query path src/cli/main.ts src/core/glob.ts       # how one depends on the other
archrift query file src/cli/projects.ts                    # one file at a glance
archrift query crap src/core                               # its riskiest functions: CRAP with the last coverage run
archrift query impact src/core/glob.ts#globToRegExp
                    # what depends on it (a file, folder, function or package), the pages it reaches, the tests to run
archrift diff [--base ref] [--head ref] [--strict] [--format markdown]
                    # the change against its base: rules (new, broken further), cycles, coherence, blocks; exits 1 on a new error
```

A command-line file importing the viewer's store breaks a rule, and the answer
says through which files:

```
$ archrift query rules src/cli/new.ts --to src/viewer/store.ts
src/cli/new.ts → src/viewer/store.ts: not allowed
  ✗ node-side-without-viewer (error): src/viewer/api.ts is reachable in default from src/cli/new.ts: src/cli/new.ts → src/viewer/store.ts → src/viewer/api.ts
  ✗ node-side-without-viewer (error): src/viewer/store.ts is reachable in default from src/cli/new.ts: src/cli/new.ts → src/viewer/store.ts
  …

$ archrift query ways src/viewer --job "shared state"
src/viewer/ (a folder: 155 files, block src/viewer)

JS · Shared state (state several components share): done several ways
  src/viewer: Zustand 27 · external store (useSyncExternalStore) 3 → use Zustand, as src/viewer/store.ts, src/viewer/ui/App.tsx, src/viewer/ui/Ask.tsx do
  differs from its block: src/viewer/views/context/Legend.tsx uses external store (useSyncExternalStore)
  …

$ archrift query impact src/core/glob.ts#globToRegExp
src/core/glob.ts › globToRegExp: 286 files depend on it (13 directly), 19 entry points
  213 production files, 73 test files (71 to run); by steps 1: 13 · 2: 76 · 3: 162 · 4: 33 · 5: 2
  …
```

Paths can be files nobody has written yet. Questions answer as text or
`--format json`, from a fresh analysis (cached: about 2 seconds for archrift's
own 387 files). `diff --format json` carries `"schemaVersion": 1`, as `check`'s
does. docs/QUERY.md also has the lines to put in an agent's CLAUDE.md or
AGENTS.md; `init` prints them with the command you started it with.

## A hook for Claude Code (optional)

The lines in CLAUDE.md ask a coding agent to run `query` before it writes
code. Nothing makes sure it does. This hook asks for it: before Claude Code
writes or edits a code file of an archrift project, archrift puts its notes on
that file into the agent's context.

- **A new file:** the rules of its place (its layer, what it must not depend
  on, its limits), and how its block does each job, with files that do it so.
- **A file that exists:** its rules, what it breaks now, the jobs it does
  differently from its block, and the block's ways.

Each file gets notes once per session. They end with the `query` commands to
ask more, and stay under about 3,000 characters. Claude Code hands them to the
agent beside the result of the write, so the agent reads them right after its
first change to the file. Files that aren't code (TS/JS, Kotlin, Go), files
the config excludes and files outside an archrift project get nothing.

The notes for a new file in archrift's own command line:

```
archrift: architecture notes for src/cli/new-thing.ts (new file, block src/cli, layer cli)
Its rules:
  must not take part in an import cycle  [no-cycles, warn] no files import each other in a circle
  is in layer cli: may depend at runtime on cli, viewer, server, analyzer, core  [layers-point-down, error] …
  must not reach src/viewer/** at runtime, not even through other files  [node-side-without-viewer, error]
  each function: complexity at most 9  [functions-small-logic, warn]
How src/cli does its jobs:
  Asynchronous code: use promises (async/await, then), as src/cli/changes.ts, src/cli/diff.ts do
Ask archrift more: archrift query rules src/cli/new-thing.ts --to <import> --root ~/src/archrift · archrift query ways src/cli/new-thing.ts --job "<job>" --root ~/src/archrift
```

It is off until you install it:

```bash
archrift hook install              # into .claude/settings.local.json of the git top-level: yours, not committed
archrift hook install --shared     # into .claude/settings.json: for everyone who works in the repo
archrift hook status               # installed or not, where, and the command
archrift hook uninstall [--shared] # takes it out again
```

`--dir <folder>` installs into another folder. Claude Code reads the settings
of the folder its session runs in: for a project in a subfolder of a repo,
that's usually the repo's top level (the default), not the project's folder.
Install keeps everything else in the file, and running it twice changes
nothing. Uninstall removes only archrift's entry. The entry runs
`archrift hook pre-write` on Write, Edit and MultiEdit, with a timeout of 15
seconds, with archrift as you started it for `install`: `archrift`,
`npx archrift` or `node <path>/src/cli/main.ts`.

**What it costs,** measured on archrift's own repository (387 files), for the
first write of each file in a session:
- about 0.8 seconds when the project has a written graph (`.archrift/graph.json`,
  from `analyze` or `serve`). The notes may be a little behind the code.
- about 2 seconds without one: a fresh analysis from the cache.
- nothing the first time in a new worktree, which has no cache yet: the hook
  starts an analysis in the background (about 9 seconds here) and says
  nothing. The next file gets notes. An analysis that takes longer than 10
  seconds is left to the background the same way.

The hook never blocks the agent. Whatever goes wrong, it prints nothing and
exits 0 (`ARCHRIFT_HOOK_DEBUG=1` says why on stderr).

## Describe the code

The analysis knows what the code does, not what it is for. `archrift describe`
keeps the words people (or their coding agents) write for it: a short name
when the code's own doesn't say it, and a sentence or two on what a block, a
feature, a folder, a file or a function is for.

```bash
archrift describe                          # how much is described, what went stale, what lost its code
archrift describe todo src/core --max 20   # the next things to describe, each with a digest to write from
archrift describe set src/cli/projects.ts --name "Project list" --summary "The projects the viewer switches between, and where each one's results go."
archrift describe apply words.json         # many at once: { "src/lib/db.ts": { "name": "…", "summary": "…" }, "feature:accounts": "…", "project": "…" }
archrift describe sync                     # entries follow renamed and moved code; the rest of the orphans go
```

- **Where:** `.archrift/descriptions.json` beside the config, meant for git with it (`init`'s `.gitignore` keeps both). A config kept elsewhere gets its descriptions beside it: `descriptions.json` next to a `config.json`, else `<name>.descriptions.json` (`app.json` → `app.descriptions.json`). Keys are node ids (`d:src/lib`, `f:src/lib/db.ts`, `s:src/lib/db.ts#prisma`), features (`feature:accounts`) and `project`.
- **What `todo` lists:** the project, its blocks (the folders its production code splits into, as `init` finds them), its features, the other folders holding production code (largest first), then its production files (most used first); tests stay out. Stale entries come before missing ones. Each item has a digest: a file's exports with their signatures, its routes, what it uses and who uses it (with their descriptions where they have one); a folder's or feature's biggest files.
- **Stale:** each entry remembers the surface of the code it was written for: a file's exports (name, kind, signature) and routes, a function's signature. When that changes, the entry is stale: still shown, marked, until someone checks it (`describe set <path>` with no words marks it as still fitting). Edits inside function bodies don't count. Folders, features and outside nodes never go stale.
- **Moves:** a file's entry keeps a fingerprint of its content, so `sync` carries it to a renamed or moved file (the same content, else the same name and exports), its functions along; a folder goes to the one undescribed folder of the same name. What has no trace is dropped (git keeps it). Entries written by hand get their stamp at the next `sync`.
- **Where it shows:** the inspector (a box under the name, amber when stale), the tooltip, search (a described name scores like the code's own, and every word of a query found in a summary counts: "results go"), `query file` (the file, its block, and each file it uses or that uses it), and `export html` (as they were at export). The toolbar's **described names** switch labels folders, files and the §5 blocks with the names written for them. `serve` reads the file on each request and tells open viewers when it changes.

## Docs and decisions

Projects write about their code: architecture pages, specs, decision records,
reviews. archrift reads those documents and links them to the code, from the
text alone (no model):
- **A document names code** by its path (`src/lib/db.ts`, `../app/src/lib/`,
  a link to it, or a file name only one file has), or by an exported name in
  a code span (`loadConfig`, `ProjectList.add`; a plain word like `config`
  doesn't count).
- **The code cites decisions** by id (`// D34: …`, `ADR-12`). An id counts
  where a document defines it: in a heading, as a table row's first cell, or
  as a bold lead (`**D45 — …**`, `- [x] **R6 …**`). Ids several documents
  define are meant from the one that fits the citing file best: its
  definition shares words with the citing line, it defines the file's other
  ids too, or it names the file or files beside it.

```jsonc
"docs": {
  "include": ["README.md", "docs", "../architecture", "../decisions"],  // default: README.md, ARCHITECTURE.md, docs, doc, adr
  "current": ["README.md", "../architecture"],  // kept true to the code; default: everything included
  "ids": "\\b(?:ADR|D)-?\\d+\\b"                // default: one to three capitals and up to three digits; false: none
}
```

- **What's read:** Markdown, HTML and text files under the folders named
  (dependencies and hidden folders skipped), outside the root too. Documents in
  a `historical`, `archive` or `old` folder are records: never kept current.
- **Where it shows:**
  - `query docs <path | id | document>`: the documents naming a file, folder or function and the ids it cites; where an id is defined and who cites it; what a document names, by section (docs/QUERY.md);
  - `query file`: its ids and the documents naming it;
  - `query overview`: how many there are;
  - the inspector: a **Docs** section on files, folders and functions;
  - `diff` and the **Changes** panel: the places in documents kept current that name code the change removes, or whose exports or signature change. They are worth a look, since they may no longer hold. This is informational and doesn't change the exit code.
- **Cost:** the documents are read with each analysis (0.1 s for archrift's own 7); in watch mode only changed documents are read again.

## Analyze a codebase

```bash
archrift analyze <root> [--config file] [--out file] [--no-cache] [--dump file] [--quiet]

# archrift itself, from its checkout: the config in .archrift/, the graph written beside it
archrift analyze . --dump .archrift/graph.txt
```

It prints a summary (here archrift's own, trimmed):

```
archrift analyze archrift
  387 files (60,226 lines) · 3,882 symbols · 3,510 members · 27 externals · 8 assets
  24,558 edges: references 12,779 · calls 5,163 · type-ref 3,980 · imports 2,312 · renders 113 · instantiates 107 · …
  1 import cycles (largest 3 files) · 244 dead exports · 142 used only by tests
  rules: 0 violations · 236 warnings (archrift check lists them)
  …
```

- **Outputs:** `graph.json` (columnar, see `src/core/serialize.ts`), `graph.sites.json` (where each edge's references are) and `cache/fragments.json`. All three go next to `--out`, whose default is `<root>/.archrift/graph.json` when the project's config is there, else `~/.config/archrift/projects/<name>/graph.json` (the config's `name`, or the folder's).
- **Dump:** `--dump` writes one line per node and per edge, sorted.
- **Large repos:** analysis runs on a worker thread with a heap sized to the project (about 0.8 MB per file, at least 4 GB) and a 64 MB stack. archrift's own 387 files take about 9 s cold and 2 s warm. On a generated 10k-file repo (2.5M lines): 68 s cold, 9 s warm, 5.6 GB peak; the viewer opens in 1.3 s and runs at 60 fps.
- **History:** `--no-history` skips reading git.

## What it extracts

| | |
|---|---|
| **Languages** | TypeScript/JavaScript through the compiler API. Kotlin, Avro schemas and Go through tree-sitter, with names resolved across files without a compiler ([docs/POLYGLOT.md](POLYGLOT.md)). |
| **Nodes** | directories, files, top-level symbols (function, component, hook, class, interface, type, enum, variable, namespace; Go: function, struct, interface, type, variable), class and interface members, externals (`x:npm:`, `x:node:`, `x:jvm:`, `x:go:`, `x:excluded:`), and the system's own infrastructure: message topics (`x:kafka:`) and databases (`x:db:`), tagged `infra` |
| **Edges** | `imports` (static, type-only, side-effect, dynamic, require), `re-exports`, `calls`, `instantiates`, `renders`, `references`, `type-ref`, `extends`, `implements` (also member → interface member), `overrides`, `spawns-worker`, `mocks`; between the parts of a system `http-call`, `publishes`, `subscribes` |
| **Per target** | each build target (e.g. `web`, `desktop` via `moduleSuffixes`) resolves imports on its own. References into a file that a target replaces are redirected to the counterpart file. |
| **Metrics** | LOC, cyclomatic complexity, fan-in/out (tests don't count toward fan-in), instability, external dependencies; from git: commits, churn, authors, last commit, hotspot |
| **Co-change** | `co-changes` edges between files changed together in at least 3 commits (weight: the share of the less often changed file's commits). They never count as dependencies. |
| **Findings** | import cycles, `dead-export`, `test-only` export |

**Languages.** TypeScript and JavaScript are read with the TypeScript
compiler, so every reference is resolved by its type checker. Kotlin is read
with tree-sitter (`src/analyzer/jvm/`, WebAssembly grammars, no native
build), in two cached passes: each file's declarations, then every name
resolved by Kotlin's scoping rules against an index of all declarations
(enclosing types and supertypes, imports, the package; a name declared in
several Gradle modules resolves to the caller's own module first, then the
ones its build file names). Values follow their declared types, so calls on
constructor-injected beans link. Avro schemas (`.avsc`) are read too: their
records are what Kotlin's generated classes resolve to. Go is read the same
way (`src/analyzer/go/`): packages are folders, imports resolve through
`go.mod`, values follow their declared types, and a struct `implements` the
project's interfaces whose methods it has (Go's interfaces are structural).

Framework plugins (`src/analyzer/plugins/`, and Spring in `src/analyzer/jvm/spring.ts`) add the links imports can't show:

| Plugin | Adds |
|---|---|
| **tRPC** | A router's procedures become its members (`accountsRouter.list`, tagged `rpc:accounts.list`, `trpc:query`). `trpc.accounts.list.query()` becomes an `rpc-call` edge to the procedure. |
| **Prisma** | `schema.prisma` becomes a building whose floors are models: fields are members, and relations are edges. `ctx.prisma.account.findMany()` becomes a `queries` edge (read or write, inferred) to `Account`. |
| **Dexie** | The tables of a `Dexie` subclass get kind `table`, and `db.accounts.where(…)` / `.put(…)` become `queries` edges. |
| **React context** | Contexts get kind `context`, with `provides` edges from `<X.Provider>` / `<X value>` and `consumes` edges from `useContext(X)` / `use(X)`. |
| **Next.js** | Pages, layouts and handlers are tagged with their URL (`route:/accounts`, `api:/api/health`). `href="/x"` and `router.push('/x')` become `navigates` edges (inferred) to the page that serves them. |
| **Angular** | Components, directives, pipes, services and modules get those kinds, tagged with their selectors (`selector:app-project-card`) and pipe names. A component's template file joins the graph: an element matching a selector becomes a `renders` edge to that component or directive, and a pipe used becomes a `references` edge. Routed components are tagged with their full path (`route:/projects/:projectId/tasks`; a catch-all is `not-found:/`), read from `forRoot`/`forChild`/`provideRouter` through children, spreads, lazy modules and path constants. `routerLink` and `router.navigate` become `navigates` edges (inferred). `HttpClient` calls are recorded as requests (`GET /v1/orders/{}`) for matching with the handlers that serve them. |
| **NgRx** | An action's type is a topic, tagged `ngrx-action`: the constant or enum member its `type` field holds, or a `createAction` creator. Dispatching an action, or creating one in an effect, `publishes` it. `ofType` in an effect and a reducer's `case` or `on()` `subscribes`. Effects get kind `effect`. |
| **Spring** | Stereotypes get their kinds (`controller`, `service`, `repository`, `entity`, `configuration`, `component`); framework-managed classes are entrypoints, never dead exports. `@GetMapping` & co. (with the class's `@RequestMapping`, constants and string templates resolved) tag handlers `http:GET /v1/orders/{customer}` and their files `api:/v1/orders/{customer}`. A Spring Data repository's methods, declared or inherited (`save`, `findById`), `queries` the entity it stores (read or write); entities are tagged `entity`, `db:sql` or `db:mongodb`, `table:<name>`. `@KafkaListener` and topic sends are recorded for the messaging plugin. |
| **HTTP** | Requests (Angular's `HttpClient`) and handlers (Spring) from any language are matched into `http-call` edges (inferred): a handler fits when its path ends the request's, segment for segment, the longest and most literal winning. |
| **Messaging** | Each Kafka topic becomes a node (`x:kafka:acme.orders`) with `publishes` and `subscribes` edges from the code that sends to it and listens on it. Names are resolved through the module's own configuration (`application*.yml` profiles, `${…}` placeholders, channel bindings); environment and version parts are left out, so one topic meets across environments. |
| **Datastores** | A module's repositories `queries` the databases its datasource URLs name (`x:db:mysql:acme-orders`; only the name is kept, never host or credentials), and scripts that create them declare them. |
| **Schemas** | `meta.databases`: the databases the code declares a schema for, with their tables, columns (the type as declared, primary key, null, unique, generated, and the relation fields the code navigates as virtual columns), foreign keys and indexes. Read from Prisma schemas (a database per datasource), Dexie classes (each table's last `stores()` across the versions), SQL migrations and scripts (MySQL/MariaDB, PostgreSQL, H2: `CREATE`/`ALTER`/`DROP`/`RENAME` applied in Flyway or name order), and JPA entities and Mongo documents (Kotlin). An entity and the SQL table of its name in one module are one table, the SQL's columns winning. Who reads or writes a table: the `queries` edges into its nodes. The **Tables** view draws them. |
| **Pulumi** | The function (or file) that constructs a cloud resource (`new azure.resources.ResourceGroup(…)`) is tagged with its type, `pulumi:azure-native:resources:ResourceGroup`. Read from the syntax and the file's imports, so it works in a light project without the provider's types. |
| **Tests** | Each file gets `testReach` (tests reaching it through runtime imports) and `testedDirectly`. The inspector's **Tested by** names them, and **color → tests reach** shows what nothing tests. |

The fixtures in archrift's repository show each of them on a small project:
`fixtures/fullstack` (Next.js, tRPC, Prisma, Dexie, React context),
`fixtures/angular` (Angular, NgRx), `fixtures/kotlin-spring` (Spring, Avro,
Kafka), `fixtures/go-service`, `fixtures/schemas`, and `fixtures/infra-root`
with `fixtures/infra-mount` (infrastructure, below).

**Schemas.** One database per module (service) and store family, linked to the `x:db:` node the module's configuration names first; a library's entities join the same-named tables of the services that use them.
- **SQL files** group by the engine their folders name (`db/migration/mysql/`). When the module's configuration names a database, only that engine counts, so an H2 copy for tests stays out. A module with migrations ignores its schema scripts (`db/schema-mysql.sql`); one without applies its scripts in name order. Prisma's own `migrations/` repeat its schema and are left out.
- **JPA** names go through Spring's snake_case naming (`orderLine` → `order_line`) unless the module configures the standard strategy. `@Embedded` properties are flattened (renamed by `@AttributeOverride`), and single-table inheritance (the default) puts a subclass in its root's table.
- **Not read:** Java sources, `@JoinTable`, plain `new Dexie()` instances, multi-file Prisma schemas, `USE db` in SQL scripts, `CREATE TABLE … AS SELECT`. Test files' schemas are left out.

A plugin works in two places:
- **During extraction** (per file, cached): it can turn an object literal's properties into members, name kinds, reclassify a resolved reference, and record facts.
- **During assembly:** it resolves those facts into nodes and edges.

Search also finds tRPC paths and routes (`accounts.list`, `/api/health`).

IDs are stable across runs (`f:src/lib/db.ts`, `s:src/lib/db.ts#prisma`,
`s:src/x.ts#Class.method`). They're built from paths and names, never from
positions.

### Infrastructure (the config reader)

When a project has infrastructure files, the config reader (`src/analyzer/infra/`) makes them buildings, in the root and the mounts:

| Files | Symbols | Links (`references`, by subkind) and facts |
|---|---|---|
| **Kubernetes manifests** (any YAML document with `apiVersion`, `kind` and `metadata.name`, also handed to `kubectl apply -f -` in a script's heredoc) | one per resource, `Kind/name`, subkind the kind lowercased (`deployment`, `service`, `ingress` …), tagged `k8s` and `image:<repo/name>` for the images a workload runs | Ingress → its Services (`backend`); Service, PodDisruptionBudget, NetworkPolicy → the workloads whose pod labels match (`selects`); workload → the ConfigMaps, Secrets, claims, SecretProviderClasses and service account it uses (`uses`); RoleBinding → role and service accounts (`binds`); HPA → its target (`scales`). A `KafkaTopic` declares its topic, a Deployment or StatefulSet running a database image its server. |
| **Helm charts** | `Chart.yaml`: the chart (`chart <name> <version>`); `values*.yaml`: the top-level keys (no strings in signatures); `templates/*.tpl`: each named template (`helm-define`) | A dependency → the chart it names (`file://` path or name). Templates are rendered leniently: control lines drop out, `.Chart.Name`, `.Chart.Version` and `.Values.x` from the chart's `values.yaml` are filled in, the rest is `…`. A line that only includes a named template renders that template's resources in the including file (`Deployment/<chart>` from a library chart's `define`), linked to it (`include`). A database chart's values (Bitnami's `auth.database(s)`) declare its databases. |
| **docker-compose** | each service (`compose-service`, signature its image or build) | `depends_on` (`depends-on`), the Dockerfile it builds (`builds`), files it mounts (`uses`) |
| **Shell scripts** | each function | Scripts and YAML/SQL files a command names (`./up.sh`, `source lib.sh`, `helm … -f values.yaml`, `"$(dirname "$0")/x.sh"`), following `cd` (`runs`, `uses`). `kafka-topics … --create --topic X` declares topic X; `CREATE DATABASE` in a `mysql`/`psql` heredoc or `-e` (and `use x` for `mongosh`) declares a database of that engine. |
| **SQL** | `CREATE TABLE` (tagged `table:<name>`), `VIEW`, `DATABASE`, `SCHEMA` | a created database is declared, its engine from the folders (`db/migration/mysql/`); the statements that shape tables (`CREATE`, `ALTER`, `DROP`, `RENAME`, `CREATE INDEX`) are schema facts for `meta.databases` |
| **Dockerfiles** | each stage (`FROM … AS name`, or `stage-<n>`), tagged with its image | a stage built on, or copying from, another (`uses`) |
| **Pipelines, application configuration** | none | Azure Pipelines `template: path` → the file. Spring's `application*.yml` and `src/*/resources/**` are buildings (tag `app-config`); the messaging and datastore plugins read them. |

- **Facts:** topics go on the `messaging` channel and databases on the `datastore` channel as `declare` facts, with the names as written (`acme.$ENV.orders.v1`, `acme_orders_db`): the messaging and datastore plugins make them the topic and database nodes the code's own uses point to.
- **Never read:** folders named `secrets`/`certificates`, key and certificate files, `credentials*`, `.env*`, and SOPS-encrypted files. No value of a variable, an environment entry or a Secret reaches a signature or a fact.
- **Not read:** other YAML is a building without symbols. A project without infrastructure files (only an `application.yml`) doesn't run the reader at all.
- **Cache:** per file by hash in `<out>/cache/config.json`; templates are rendered and names linked on every run.

## Config (`.archrift/config.json`)

```jsonc
{
  "name": "my-app",
  "requires": ">=0.2",                  // the lowest archrift version this config needs
  "mounts": { "infra": "~/src/infra" },  // another folder analyzed with the root, its files under infra/
  "tsconfig": "tsconfig.json",          // default; project references are followed; a folder ("infra/pulumi/") is a light project
  "include": ["src/**"],                // default: what the tsconfig includes
  "exclude": ["src/generated/**"],      // imports into these become x:excluded: nodes
  "tests": ["tests/**", "**/*.test.*"],
  "entrypoints": ["src/app/**/page.tsx"], // exports here are never "dead"
  "layers": [                            // top to bottom; a file joins the first that matches
    { "name": "ui", "match": ["src/app/**", "src/components/**"] },
    { "name": "domain", "match": "src/lib/**" }
  ],
  "groups": [                            // extra ways to group (features, teams …)
    { "name": "billing", "match": ["src/**/billing/**", "src/lib/stripe*"] }
  ],
  "features": {                          // group by feature: found from the pages and API routes
    "merge": { "auth": ["/login", "/verify", "/api/auth"], "dashboard": ["/"] }, // name a feature after route prefixes
    "exclude": ["/api/internal"]         // routes that are no feature (/api/trpc, /api/health … are by default)
  },
  "coherence": {                         // archrift coherence and its view (docs/COHERENCE.md)
    "concerns": [{ "id": "js.http", "paradigms": [{ "id": "api-client", "imports": ["src/lib/api-client.ts"] }] }], // a way's own wrapper, or concerns of your own
    "accept": { "js.persistence": "the offline cache and the server database are two stores by design" } // several ways on purpose
  },
  "targets": { "web": {}, "desktop": { "moduleSuffixes": [".desktop", ""] } }, // first = primary
  "rules": [                             // checked by archrift check and shown in the viewer
    { "name": "payments-seam", "forbid": { "from": "src/**", "to": "x:npm:stripe", "except": "src/lib/payments/**" } },
    { "name": "ui-uses", "allow": { "from": "src/components/**", "to": ["src/components/**", "src/lib/**", "x:npm:*"] } },
    { "name": "services-apart", "apart": ["services/*", "apps/*"] },
    { "name": "web-without-desktop-code", "target": "web",
      "forbidReach": { "from": "tag:entrypoint", "to": "**/*.desktop.ts" } },
    { "name": "routes-sign-in", "requireReach": { "from": "s:src/app/api/**#{GET,POST}", "to": "s:src/lib/auth.ts#requireSession", "except": "src/app/api/webhooks/**" } },
    { "name": "acyclic-lib", "cycles": "forbid", "scope": "src/lib/**" },
    { "name": "layers", "layers": "down", "severity": "warn" },
    { "name": "readable", "severity": "warn", "limit": { "functions": "src/**", "max": { "complexity": 50 } } },
    { "name": "lib-tested", "limit": { "files": "src/lib/**", "except": "tag:test", "min": { "testReach": 1 } } }
  ],
  "docs": { "include": ["README.md", "docs"], "current": ["docs"] },  // documents linked to the code (Docs and decisions)
  "maxSitesPerEdge": 20
}
```

**Versions:**
- `requires` names the lowest archrift version the config needs: `">=0.2"`, `">=0.2.1"`. An older archrift stops with a message saying how to update (`npm i -g archrift@latest`, or `git pull` in a linked checkout) instead of answering wrongly. Until 1.0, a minor version may change the config or the JSON reports; [CHANGELOG.md](../CHANGELOG.md) says how to move.
- `archrift --version` prints the version.
- The JSON of `check --format json` and `diff --format json` starts with `"schemaVersion": 1`. It goes up when a field changes meaning or goes away, not when one is added.

**Rules:**
- **Kinds:**
  - `forbid`: direct dependencies; exceptions go on the dependent side.
  - `allow`: an allowlist; any dependency outside `to` breaks it.
  - `apart`: each folder its globs match (`services/*`: every service) may not depend on another one; files outside them may depend on any. When globs nest, the outermost folder counts. For what `from`/`to` can't say: "another service".
  - `forbidReach`: transitive dependencies over runtime imports, per build target. It reports every source that reaches the file and the shortest path from one of them.
  - `requireReach`: the opposite: each `from` must run some `to` (an API route checks the session, a cron route its secret), through what it calls, renders, creates or queries, directly or through other code. A call into an interface counts for the classes implementing it, and creating a class runs its constructor; an import alone runs nothing.
    - A `from` file passes when any of its code does; with `s:` selectors each function is held to it (`s:src/app/api/**#{GET,POST}`: every handler). A `to` file is reached by reaching any of its code.
    - One violation per `from` that never gets there, with the build targets it fails in. The viewer shows the file (and the function).
  - `cycles`: import cycles.
  - `layers: "down"`: imports that point up the `layers` order.
  - `limit`: bounds on what the analysis measures, for `files` or for the `functions` in them (functions, methods, components, hooks), with `max` and `min`, and `except`.
    - Files: `loc`, `complexity` (cyclomatic, the whole file), `symbols` (declarations), `fanIn` (production files using it), `fanOut`, `externalDeps` (packages), `instability` (fanOut / (fanIn + fanOut)), `testReach` (tests reaching it), `testedDirectly` (tests importing it).
    - Functions: `loc`, `complexity`, `fanIn`, `fanOut`.
    - Git history (churn, commits) can't be limited: it grows with time whatever a change does.
    - One violation per file or function and measure, the furthest out first. A limit has no `target`: a measure belongs to the file.
- **Selectors:**
  - path globs, which also match excluded files
  - `tag:entrypoint`, `tag:use-client`, `tag:test`; in a tag, `*` matches anything (`tag:api:*`: every API route)
  - symbol ids, globs too: `s:src/lib/auth.ts#requireSession`, `s:src/app/api/**#{GET,POST}`
  - `layer:<name>`
  - package ids, such as `x:npm:react`, `x:npm:@scope/*` or `x:node:*`
- **Options:**
  - `severity`: `error` (the default) or `warn`
  - `target`: only this build target
  - `runtimeOnly`: `forbid`, `allow` and `layers` count type-only imports unless this is set
  - `description`

archrift's own config (`.archrift/config.json` in its repository) is a small
real example: five layers, a `forbidReach` rule that keeps the command line,
server and analyzers from loading the viewer, and complexity limits as
warnings.

**History** (all optional; the defaults shown):

```jsonc
"history": {
  "enabled": true,
  "windowDays": 90,          // churn: lines changed this many days before the newest commit
  "maxFilesPerCommit": 30,   // bigger commits (mass edits) don't count toward co-change
  "minSupport": 3,           // a co-change pair needs this many shared commits…
  "minConfidence": 0.3,      // …making up this share of the less often changed file's commits
  "maxPartners": 12          // each file keeps its strongest partners
}
```

When there is no tsconfig, the analyzer builds a project from every JS/TS file
under the root.

**Mounts** join another folder, usually a second repository, to the project:
`"mounts": { "infra": "~/src/infra" }` analyzes `~/src/infra` as `infra/…` (a
relative folder is relative to the root; `fixtures/infra-root` mounts
`../infra-mount`). Excludes, layers, groups and `tsconfig` entries
name its files by that path. Source views, editor links and git history go to
the folder a file really lives in: a mount's commits are read from its own
repository and joined with the root's by time. Snapshots and `--watch` cover the
root only.

**A folder in `tsconfig`** (`"infra/azure/"`) is a light project: every JS/TS
file under it, with the folder's tsconfig options when it has one, and the
packages it imports left unloaded (`noResolve`). Imports still point at the
packages and references between the folder's files resolve, but a package's
types stay unknown. Pulumi projects need this: each one otherwise loads the
25,000 declaration files of `@pulumi/azure-native` (about 10 s and 2.4 GB apiece).

## Known limits

- **Symbol references use one program.** They're resolved with the primary target's program. Other targets get them through the counterpart redirect above, which covers suffix-based platform seams but not arbitrary per-target code.
- **Some properties have no declaration to link to.** This affects properties reached through types that drop declarations: key-remapped mapped types (tRPC's `ctx.prisma`) and index signatures (`process.env.X`).
- **CommonJS exports stay at file level.** Properties of `module.exports = {…}` are attributed to the file node.
- **Globals added elsewhere aren't noticed by the cache.** A cached file doesn't notice a *new* global declaration in another file; use `--no-cache` after adding globals.
- **Live updates at 10k files take ~10 s.** Re-analysis takes 0.5 s, but the graph is re-assembled whole (incremental assembly is the missing piece). On archrift's own 387 files, assembly takes 0.3 s.
- **TypeScript 7:** the analyzer uses TypeScript 6.0's in-process API. TS 7's is faster but still `unstable` and doesn't expose module resolution.
- **Snapshots borrow today's `node_modules`,** and generated code that isn't committed (such as a Prisma client) is missing from them, so imports of it don't resolve there.
- **Kotlin is resolved by name, not by a compiler.** A value whose type is only known by inference (a lambda's `it`, a generic call's result, a fluent builder's next step) leads nowhere: its calls get no edge rather than a wrong one. Java sources aren't read; code generated at build time (JPA metamodel classes, Avro builders) is missing.
- **Coherence sees only the ways it knows.** A way is a package, a prefix or a text pattern in the catalog or the config, counted per file; a project's own wrapper hides its library unless the config names it.
- **Matching HTTP paths and topic names is a guess.** Two services serving the same path both get the call; a URL that arrives as data isn't matched.
- **Unresolved identifier tracing:** set `ARCHRIFT_TRACE_UNRESOLVED=1` to list every identifier that doesn't resolve (TypeScript and Kotlin).

## Development

```bash
npm install
npm run build       # the viewer (dist/viewer), the static viewer for `export html` (dist/static/index.html,
                    # see vite.static.ts), the highlighter it embeds with --source (dist/static/highlight.js),
                    # and lib/: the command line as JavaScript for the npm package (tsconfig.build.json)
npm test            # vitest: fixtures (snapshot + targeted), cache, core, layouts, API, CLI
npm run typecheck   # src + tests
npm run test:e2e    # Playwright: builds the viewer, serves fixtures/plain-ts, fixtures/fullstack and a generated git repo with snapshots, drives them on the GPU
npm run test:pack   # packs the package, installs it into a scratch project and runs the installed command (init, check, query, export, serve)
ARCHRIFT_ROOT=~/src/my-app npm run dev
                    # viewer with hot reload on :4310, same API mounted by a Vite plugin (default root: fixtures/plain-ts)
```

Tests run with `ARCHRIFT_HOME=out/test-home` (`vitest.config.ts`), so they
never touch the project list or results in your home folder.

Code map:
- `bin/archrift.js`: the command. It runs `src/cli/main.ts` in a checkout, and the built `lib/cli/main.js` from the npm package.
- `src/core`: the graph model and algorithms. It uses no Node or DOM APIs. `core/archify/` writes archify's JSON.
- `src/analyzer`: the analyzer.
- `src/cli`: the commands.
- `src/server`: the API (overview, file details, search, source).
- `src/viewer`:
  - `layouts/`: pure functions from graph to boxes
  - `scene/`: the three.js engine
  - `controller.ts`: turns state into what the scene draws
  - `store.ts`: zustand
  - `ui/`: React panels
  - `static/` and `api.static.ts`: the API answered in the browser, for exported pages. In the static build a module with a `.static.ts` sibling is replaced by it.

The fixtures in `fixtures/` are small repos with checked-in expected dumps in
`tests/analyzer/expected/`. When extraction changes on purpose, update them
with `npx vitest run -u` and review the diff.

`scripts/showcase/stills.mjs` takes a screenshot of every view from a running
`archrift serve` on port 4300 (`node scripts/showcase/stills.mjs <out dir> [project]`).
