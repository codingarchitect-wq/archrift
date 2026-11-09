# Ask before changing, review after: `archrift query` and `archrift diff`

*2026-10-23 · status: done (`query` with ways, rules, path, file and, since 2026-11-01, crap; `diff` with text, markdown and JSON, and since 2026-11-01 what imports bring into the entry points; since 2026-11-02 `impact`, `docs` (documents and decision ids) and an optional Claude Code hook that asks for the agent; `diff` names the documents a change may outdate)*

Coding agents write code faster than anyone can review it. Each of their
changes is locally right, but they solve a job the way they happen to know,
not the way the code already does it. They also don't know which folder may
use which. Two commands put archrift's analysis where an agent (or a person)
makes and reviews changes:

- **`archrift query`** answers questions before a change. How does this folder
  keep shared state? May this file import that one? How is A connected to B?
  What is this file? Which of its functions are riskiest to change? What
  depends on it, and which tests should run? Which documents describe it, and
  where is the decision it cites written down?
- **`archrift diff`** says what a change does to the architecture, for a pull
  request or before a commit: the rules it breaks or mends, the import cycles
  it makes or ends, the jobs it starts doing another way, the blocks that
  start depending on each other, the files and packages its imports bring
  into pages that didn't load them, and the places in documents kept current
  that name code it removes or reshapes.

Both analyze the working tree fresh (cached: on archrift itself, about 400
files, an answer takes about 2 seconds), so they see the agent's own
uncommitted edits. Neither uses an LLM.

The commands below are written `archrift …`, as installed with
`npm i -g archrift`. `npx archrift …` runs the same from a project's
`node_modules`, and `node src/cli/main.ts …` from an archrift checkout. The
examples are real answers about archrift's own code, trimmed where they run
long.

## Which project

Run from inside a project folder, and archrift finds it: the listed project
(`~/.config/archrift/projects.json`, the viewer's list) whose root holds the
current folder, with its config and output. Otherwise give `--root <dir>` (and
`--config`), or `--project <name>`. A project whose config is in
`.archrift/config.json` (as `archrift init` writes it) needs neither in a
worktree of its own: run from anywhere in the worktree, archrift takes the
nearest folder up with such a config as the root. Paths are read from the
current folder when they name something from there, else from the project's
root.

A path can be:
- a file or a folder;
- an id (`f:src/core/model.ts`, `s:src/core/ids.ts#packageName`, `x:npm:react`);
- a file name that only one file has (`hook-notes.ts`, or `hook-notes`);
- a package (`three`, `lodash/fp`);
- **a file nobody has written yet**: questions about it are answered from
  where it would be (its block, its layer, the rules its path matches).

## `query ways <path> [--job <words>]`

How the place does each job of the coherence catalog ([COHERENCE.md](COHERENCE.md)),
and the way to follow:
- For each block it covers, the ways its files take and the way to use, with
  up to three files that take it, nearest first.
- **The way to use** is the block's main way. When that way is legacy and the
  project moves to another, it's the newer one.
- Where the block doesn't do the job yet, it's the project's way.
- Files of the place that do the job differently from their block are named.
- Without `--job`: every job its block does, and then the project's way for
  the jobs done elsewhere.

`--job` takes an id (`js.state`, `state`), a label (`Dates`), or plain words
matched against the jobs' descriptions: "share state" finds Shared state,
"wait for results" finds Asynchronous code.

```
$ archrift query ways src/viewer/views/terrain --job "share state"
src/viewer/views/terrain/ (a folder: 6 files, block src/viewer)

JS · Shared state (state several components share): done several ways
  src/viewer: Zustand 27 · external store (useSyncExternalStore) 3 → use Zustand, as src/viewer/views/blocks/Controls.tsx, src/viewer/views/blocks/settings.ts, src/viewer/views/classes/Controls.tsx do
  differs from its block: src/viewer/views/terrain/controls.tsx uses external store (useSyncExternalStore)
  whole project: Zustand 27 · external store (useSyncExternalStore) 3

$ archrift query ways src/cli/report.ts --job "wait for results"
src/cli/report.ts (no file yet; it would be in block src/cli)

JS · Asynchronous code (waiting for results)
  src/cli: promises (async/await, then) 9 → use promises (async/await, then), as src/cli/changes.ts, src/cli/diff.ts, src/cli/export-archify.ts do
```

A legacy way is never the one to use. In `fixtures/kotlin-spring`, one
service file still stamps a `java.util.Date` beside one on `java.time`; a new
file there is told to use `java.time`:

```
$ archrift query ways order-service/src/main/kotlin/com/acme/order/Invoice.kt --job dates --root fixtures/kotlin-spring
order-service/src/main/kotlin/com/acme/order/Invoice.kt (no file yet; it would be in block order-service/src/main/kotlin/com/acme/order)

JVM · Dates (date and time values): done several ways
  order-service/src/main/kotlin/com/acme/order: java.time 1 · java.util.Date / Calendar (legacy) 1 → use java.time, as order-service/src/main/kotlin/com/acme/order/OrderClock.kt does
  whole project: java.time 1 · java.util.Date / Calendar (legacy) 1
```

## `query rules <path> [--to <path>]`

The rules ([GUIDE.md](GUIDE.md#check-architecture-rules)) as they apply to the place:
- what it may depend on (forbid, allow, reach, cycles, its layer), and the limits on its size, complexity or coupling;
- who may depend on it;
- what involving it is broken now.

With `--to`, whether depending on that would break a rule. The dependency (a
runtime import) is added to the graph and every rule is evaluated again: the
violations that weren't there before are the answer, including what it
reaches through other files and the cycles it closes. A folder stands for a
new file in it.

archrift's own config has five rules: no cycles, layers that point down
(cli, viewer, server, analyzer, core), `node-side-without-viewer` (the
command line, server and analyzers never load the viewer, not even through
other files), and two limits on function complexity.

```
$ archrift query rules src/cli/report.ts --to src/core/reach.ts
src/cli/report.ts → src/core/reach.ts: allowed: no rule breaks

$ archrift query rules src/core/model.ts --to src/viewer/store.ts
src/core/model.ts → src/viewer/store.ts: not allowed
  ! no-cycles (warn): 7 files import each other: src/core/descriptions.ts → src/core/first-look.ts → src/core/model.ts → src/core/rules.ts → src/core/serialize.ts → src/viewer/api.ts → src/viewer/store.ts
  ✗ layers-point-down (error): core → viewer points up: src/core/model.ts depends on src/viewer/store.ts
  ✗ node-side-without-viewer (error): src/viewer/api.ts is reachable in default from 38 places: src/core/model.ts → src/viewer/store.ts → src/viewer/api.ts
  ✗ node-side-without-viewer (error): src/viewer/store.ts is reachable in default from 38 places: src/core/model.ts → src/viewer/store.ts
  ✗ node-side-without-viewer (error): src/viewer/world.ts is reachable in default from 38 places: src/core/model.ts → src/viewer/store.ts → src/viewer/world.ts
```

A reviewer sees the layer rule broken by the one line. The rest is what they
would miss: the store brings two more viewer files with it, 38 places on the
node side would then load the viewer (`default` is the build target), and the
import closes a cycle through five files the change doesn't touch.

## `query path <from> <to> [--max n]`

Up to `--max` (default 5) shortest dependency paths, each hop with its kinds:
imports, calls, renders, tRPC calls, queries, HTTP calls, topics. Folders work
at either end. With no path that way, it tries the other.

```
$ archrift query path src/cli/hook.ts src/core/coherence.ts
src/cli/hook.ts depends on src/core/coherence.ts:
2 shortest paths, 2 steps

  src/cli/hook.ts
    → src/core/first-look.ts  (imports, references)
    → src/core/coherence.ts  (calls, imports, references, type-ref)

  src/cli/hook.ts
    → src/core/query.ts  (calls, imports, references, type-ref)
    → src/core/coherence.ts  (imports, references, type-ref)
```

Topics, databases and HTTP calls are hops like any other: in
`fixtures/kotlin-spring`, the path from the controller to `x:db:mysql:acme-orders`
goes through the service and the repository ([POLYGLOT.md](POLYGLOT.md), P3).

## `query file <path>`

One file at a glance:
- its block and layer, lines, complexity, commits, its hotspot rank, the
  tests that reach it;
- what it uses, and who uses it (tests counted);
- its jobs, and whether it differs from its block;
- its rules and what it breaks;
- the exports nothing uses, and those only tests use;
- its functions, riskiest first (as `query crap` ranks them);
- what was written about it and its block (`archrift describe`), and beside
  each file it uses or that uses it, the name (else the summary) written for it;
- the decision ids it cites, each with what its definition says and where,
  and the documents naming it or its functions (config `docs`, below).

## `query docs <path | id | document> [--max n]`

What the project's documents say about the code, read from their text (the
config's `docs`; [GUIDE.md](GUIDE.md#docs-and-decisions)):
- **A file, folder or function** (`src/core/ids.ts#packageName`, or an `s:` id):
  - the decision ids its files cite, with the definition meant and where it is;
  - the documents naming it, a file's functions or anything in a folder,
    with the section and line of each place, documents kept current first.
- **A decision id** (`D34`): where documents define it (heading, table row,
  bold lead) and every file citing it. When several documents define it, it
  shows which one each file means: the definition sharing words with the
  citing line, defining the file's other ids too, or naming the file or files
  beside it.
- **A document** (its path, or the end of it: `GUIDE.md`): the code it names,
  by section; the ids it defines that the code cites; the paths it names that
  no file has.

archrift's own source cites the parts of [POLYGLOT.md](POLYGLOT.md) that way
(`// Spring for the JVM reader (docs/POLYGLOT.md, P3–P4)`), and the
document defines them in its headings:

```
$ archrift query docs src/analyzer/jvm/spring.ts
src/analyzer/jvm/spring.ts: named in 3 documents, cites 2 decision ids

Cites:
  P3 (line 1): P3: the JVM reader (Kotlin, Spring, Avro) — docs/POLYGLOT.md:172
  P4 (line 1): P4: links between services — docs/POLYGLOT.md:202

Named in (kept current first):
  docs/QUERY.md (kept current)
    § query docs <path | id | document> [--max n], line 196: src/analyzer/jvm/spring.ts (5×)
  docs/GUIDE.md (kept current)
    § What it extracts, line 633: src/analyzer/jvm/spring.ts
  docs/POLYGLOT.md (kept current)
    § P3: the JVM reader (Kotlin, Spring, Avro), line 178: src/analyzer/jvm/spring.ts
```

## `query overview` and `query find <words…> [--max n]`

Where an agent starts (the viewer's Ask bar uses them):
- **overview:** the project at a glance: what was written about it
  (`archrift describe`), its size and layers, its blocks (the folders its
  production code splits into, as `init` finds them) and features, each with
  its description, its entry points and how its rules stand.
- **find:** files, folders, functions and routes by name, path, route or
  description: the whole phrase, then each word on its own, things matching
  more of the words first ("tree sitter" finds `src/analyzer/tree-sitter.ts`
  first). Exits 4 when nothing matches.

```
$ archrift query overview
archrift: not described yet (archrift describe)
  395 files, 286 of them production code (46,208 lines); layers, top to bottom: cli > viewer > server > analyzer > core
  entry points: 0 pages, 0 API routes; rules: 5 (3 broken, 0 errors)
  …

Blocks (the folders its production code splits into):
  src/analyzer  72 files, 12,505 lines
  src/cli  19 files, 3,356 lines
  src/core  30 files, 5,235 lines
  src/server  6 files, 662 lines
  src/viewer  147 files, 22,110 lines
```

`--graph <file>` answers any question from a graph already written (such as
`serve`'s) instead of analyzing: in under a second rather than two. The
Ask bar's agent gets its graph and project through `ARCHRIFT_QUERY_GRAPH`,
`ARCHRIFT_QUERY_ROOT` and `ARCHRIFT_QUERY_CONFIG`, so its commands stay short.

## `query crap <path> [--max n]`

The functions, methods, components and hooks of a file or folder (production
code), riskiest to change first: by CRAP, the score of Uncle Bob's crapper,

    CRAP = complexity² × (1 − coverage)³ + complexity

The score is never below the complexity, so a function past the complexity
limits (`functions-small-*`, as `archrift init` sets them up) can't reach
CRAP 10 at any coverage; for one under them, it shows the branches the tests
leave untaken.

- **Complexity** is archrift's own: branches, loops, `catch`, `case`,
  `&&`/`||`/`??`, with nested callbacks counted toward their function (a
  component carries its inline handlers).
- **Coverage** is the share of branch arms the tests took inside the function,
  or of its statements when it has none, from the last coverage run: the
  config's `coverage` (default `coverage/coverage-final.json`, the Istanbul
  file Vitest and Jest write by default).
- A file changed after that run gets complexity only (its lines may have
  moved), as does one the run left out (excluded in the test config).
  Without a run, functions rank by complexity, as here:

```
$ archrift query crap src/core --max 3
src/core/: 336 functions, riskiest first
  no coverage run found (npm run test:coverage writes one): by complexity only

  coherenceModel  src/core/coherence.ts:166  complexity 77
  findFeatures  src/core/features.ts:64  complexity 71
  diffArchitecture  src/core/diff.ts:91  complexity 66
  … 333 more (--max)
```

With a run, each line reads like `CRAP 11.2 · complexity 9 · coverage 70 %`,
or `changed since the coverage run`, and the header says how many functions
are at CRAP 10 or more.

## `query impact <path> [--depth n] [--max n]`

What breaks if this changes? Everything that depends on it, directly or
through other files, and the tests to run after the change (the viewer's
Focus → Impact, for the command line):
- **What it takes:**
  - a file;
  - a folder: its files together, so only what depends on it from outside counts;
  - a function or class, as `<path>#<name>` (`src/core/ids.ts#packageName`) or an `s:` id;
  - a package (`three`).
- **The walk** goes back over every kind of dependency (imports, calls,
  renders, type references, tRPC and HTTP calls, queries, mocks …), file by
  file, all the way or `--depth` steps. Each file comes with its step, the file
  one step closer (`via`), how it depends on that one, and the line of its
  first reference to it.
- **A function or class** is followed more closely on the first step: the
  files using it (or a function of its own file that uses it), and the tests
  mocking its module. Changing one function doesn't count every file that
  imports something else from its file. From there it goes on file by file.
- **What carries nothing on:**
  - A mock, or a link to a page, counts only on the seed itself. A test
    mocking a file further out doesn't run what that file uses, and a link
    works whatever the page's code does.
  - A file that only re-exports (an `index.ts`) is listed but not walked
    through: whoever uses what it passes on refers to the original, and is
    reached from there.
  - Through a message topic, a subscriber depends on the files publishing to it.
- **The summary:**
  - the files per step, production code and tests;
  - the features of the production files;
  - the entry points: pages and API routes by their route, layouts, and the
    config's other entry points (workers, scripts);
  - **the tests to run**: the test files among them, helpers, fixtures and
    setup files aside.

Text lists the first two steps (or as many as `--depth` walks), production
code first, at most `--max` (default 20) files a list, and counts the steps
further; `--format json` has every file. A file not written yet has nothing
depending on it (exit 0); a name nothing has exits 4.

```
$ archrift query impact src/core/model.ts --max 5
src/core/model.ts: 285 files depend on it (187 directly), 19 entry points
  212 production files, 73 test files (71 to run); by steps 1: 187 · 2: 88 · 3: 10

Directly (187):
  src/analyzer/analyze.ts:5  (imports, references, type-ref)
  src/analyzer/assemble.ts:11  (imports, references, type-ref)
  src/analyzer/coherence/paradigms.ts:9  (imports, references, type-ref)
  src/analyzer/docs.ts:12  (imports, references, type-ref)
  src/analyzer/fragment.ts:3  (imports, type-ref)
  … 182 more (--max)

Through them (2 steps, 88):
  src/analyzer/analyze.worker.ts:6  via src/analyzer/analyze.ts  (calls, imports, references, type-ref)
  src/analyzer/cache.ts:8  via src/analyzer/fragment.ts  (imports, references, type-ref)
  src/analyzer/config.ts:9  via src/analyzer/history.ts  (imports, references)
  src/analyzer/go/analyzer.ts:18  via src/analyzer/fragment.ts  (calls, imports, references, type-ref)
  src/analyzer/go/frameworks.ts:42  via src/analyzer/go/model.ts  (imports, references, type-ref)
  … 83 more (--max)

Further: 3 steps: 10 files (--depth 3 lists them, --format json has every file)

Entry points reached (19):
  src/analyzer/analyze.worker.ts
  src/cli/main.ts
  src/viewer/layouts/galaxy.worker.ts
  src/viewer/main.tsx
  src/viewer/views/blocks/index.ts
  … 14 more (--max)

Tests that reach it (run these, 71):
  tests/analyzer/angular.test.ts
  tests/analyzer/cache.test.ts
  tests/analyzer/coherence.test.ts
  tests/analyzer/docs.test.ts
  tests/analyzer/fixtures.test.ts
  … 66 more (--max)
  (2 more test files reach it: helpers, fixtures or setup, which run nothing)
```

`model.ts` holds the graph's types, so nearly everything depends on it. A
function is narrower on the first step: `src/core/ids.ts` has 49 files
depending on it directly, its `packageName` alone 3 (the TypeScript
resolver, `src/core/query.ts` and a test). Both callers are widely used, so
the walk still reaches 151 files, against 189 for the whole file.

**Output and exit codes.** Every question answers as text (default) or
`--format json`. The exit codes:
- 0: an answer (also "not allowed": read `allowed` in the JSON);
- 2: a usage mistake;
- 3: a name several files have (they're listed);
- 4: nothing by that name.

## `archrift diff [root] [--base ref] [--head ref] [--strict]`

**The two sides.**
- **Head:** the working tree, or `--head <ref>`.
- **Base:** `--base <ref>`, else where the branch left the main one (the
  merge base with `main`, `master`, then `origin/HEAD`, `origin/main` or
  `origin/master`). On the main branch itself, that's HEAD, so the diff is
  your uncommitted change, however far ahead of the remote you are. A CI
  checkout has no local main and uses the remote's.
- The base (and a `--head` ref) is analyzed in a worktree beside the
  snapshots' and shares their fragment cache. Packages come from the root's
  `node_modules`, and both sides use today's config.

**What it reports**, each finding saying whether the change touched the file:
- **Rules:** new violations and fixed ones. A violation is the same one on
  both sides by rule and ends (for reach rules, by what's reached; for limits,
  by file or function and measure). A limit already broken that the change
  breaks further (a function past its complexity limit that grows, a minimum
  that falls further) is listed apart, with the measure before and after
  (`↑ … complexity 14 → 16 … (grew)`). Rules the change leaves matching
  nothing, such as a folder renamed under them, are named as well.
- **Import cycles:** new and gone.
- **Coherence**, per job:
  - new and gone ways;
  - files that now do the job differently from their block, with files that
    take the block's way;
  - files back in line;
  - progress: files leaving a legacy way, or new files written the newer way
    in a block that's still legacy. Progress is not a deviation.
- **Blocks:** dependencies between blocks of production code that start or
  stop, with one file dependency that does it.
- **Reach:** what the change's imports bring into the entry points (the
  config's `entrypoints`: pages, routes, workers, scripts …). One import line
  can make every page load dozens of files, and the line diff shows one line.
  Per build target, each entry point's runtime imports are followed before and
  after. A file an entry point loads now and didn't before is pinned on the
  import that brought it in: the first one on its way back to the entry point
  that the base didn't have, which is the line to look at. Per import: the
  files it brings (the ones the change touched are in its line diff and aren't
  counted), the packages the target didn't load at all before, and the entry
  points that now load them. An import bringing fewer than 5 files and no new
  package is ordinary and left out. Imports that are gone are listed with what
  the entry points no longer load. New entry points aren't counted: everything
  a new page loads is new.
- **Docs:** the places in documents kept current (config `docs.current`) that
  name code the change removes (a file, folder or function gone; a path a
  document names that was a file removed), or whose exports or signature
  change. They may no longer hold. Edits inside function bodies don't count.
  This is informational, like Reach.

**Exit code** 1 on a new violation of an error rule, one it breaks further,
or an error rule that now matches nothing. With `--strict`, also on
a new way or a file differing from its block (accepted jobs aside).
`--format markdown` is made for a pull-request comment.

A scratch change to archrift: a new `src/core/labels.ts` imports the
viewer's store, and a new `src/viewer/views/wheel/spin.ts` keeps its state
in a module store of its own:

```
$ archrift diff
archrift diff archrift: HEAD (71c9e3b6) → the working tree, 2 files touched (2 new, 0 removed)

Rules: 4 new violations
  ✗ layers-point-down (error): src/core/labels.ts → src/viewer/store.ts
  ✗ node-side-without-viewer (error): src/core/labels.ts → src/viewer/store.ts → src/viewer/api.ts
  ✗ node-side-without-viewer (error): src/core/labels.ts → src/viewer/store.ts
  ✗ node-side-without-viewer (error): src/core/labels.ts → src/viewer/store.ts → src/viewer/world.ts

Coherence: 1 file that does a job differently from its block
  JS · Shared state
    src/viewer/views/wheel/spin.ts uses external store (useSyncExternalStore); src/viewer uses Zustand (e.g. src/viewer/store.ts, src/viewer/ui/App.tsx)

Blocks: 1 new dependency between blocks
  src/core → src/viewer, through src/core/labels.ts → src/viewer/store.ts
```

It exits 1. Reach, with one line added instead to the arc42 views' shared
colors: `src/viewer/views/arc42-kit/ink.ts` imports `groupColor` from the
Coherence view's model. No rule breaks and no block starts depending on
another, so this section is all the diff says:

```
Reach: 1 import brings 6 files into entry points that didn't load them
  src/viewer/views/arc42-kit/ink.ts → src/viewer/views/coherence/model.ts brings 6 files into 7 entry points
    files: src/core/algorithms.ts, src/core/coherence.ts, src/core/graph-index.ts and 3 more
    entry points: src/viewer/views/blocks/index.ts, src/viewer/views/classes/index.ts and 5 more
```

Each view is an entry point of its own, loaded when it opens. The one line
makes seven views load the Coherence view's model and the coherence
measures behind it. Moving `groupColor` into `src/viewer/colors.ts`, which
those views load already, would not.

**Timing.** On archrift itself, the working tree against HEAD takes about
20 seconds the first time (both sides analyzed cold, the base in a
worktree) and about 4 seconds after that.

**In the viewer.** `archrift serve`'s **Changes** button compares the graph it
shows (the working tree as analyzed; with `--watch`, as it is now) with the
same base, and keeps the base's graph in memory, so the first comparison
takes as long as analyzing the base (about 9 seconds cold on archrift itself)
and the next ones a fraction of a second. The changed files light up
(*color → the change in progress*: new green, changed blue, a warning amber,
a broken rule or new cycle red), and the inspector lists what the diff finds,
each finding on its file (a violation opens as the Rules panel would show it),
then every changed file with its lines added and removed. A changed file's own
inspector says how it changed and what the diff finds in it.

**Why each file changed** comes from the coding agent: after a change it can
write `.archrift/changes.json` (beside the config, left out of git), and the
viewer shows the request and summary over the list and each note beside its
file:

```json
{
  "tasks": [
    {
      "title": "Spinning wheel",
      "request": "Let the wheel view spin on its own",
      "summary": "The wheel view keeps whether it spins and turns a little each frame.",
      "notes": { "src/viewer/views/wheel/spin.ts": "Whether the wheel spins: the toolbar sets it, the scene reads it." }
    }
  ]
}
```

## For agents: what to put in CLAUDE.md or AGENTS.md

`archrift init` prints these lines with the command written the way you ran
it (`archrift`, `npx archrift`, or `node <checkout>/src/cli/main.ts`), and
the line on function size with the limits it sets up. With `archrift` on the
PATH they read:

```markdown
## Architecture checks (archrift)

Before writing code that does a common job (HTTP calls, dates, state, forms,
validation, logging, test doubles …) in a folder, ask how that folder does it
and follow that way:
  archrift query ways <folder or new file> --job "<the job in a few words>"
Before adding an import across folders, check it's allowed:
  archrift query rules <file> --to <the file or package to import>
Before changing a widely used file, function or package, see what depends on
it and which tests to run after the change:
  archrift query impact <file, folder, path#function or package>
Before finishing, check what the change does to the architecture, and fix new
rule violations, limits broken further, and files that do a job differently
from their folder (unless moving off a legacy way); an import that brings many
files or a new package into pages (Reach) deserves a second look:
  archrift diff
A function the diff shows past a complexity limit (new, crossing it, or growing
further) is split under the limit in the same change: 10 in logic, 20 in UI code.
Before writing tests, see which functions the tests leave riskiest:
  archrift query crap <file or folder>
After adding a file or changing what one exports, keep its description in
.archrift/descriptions.json current (a name only when the code's own doesn't say
it, one or two sentences on what it is for):
  archrift describe todo <folder>, then archrift describe set <path> --summary "…"
When a change is done, write what was asked and why each file changed in
.archrift/changes.json ({ "tasks": [{ "title", "request", "summary", "notes":
{ "<path>": "why" } }] }; it replaces the last one): the viewer's Changes panel shows it.
Before changing code a comment ties to a decision (D34, ADR-12), read where it is
defined; after, fix the documents the diff names under Docs:
  archrift query docs <file or id>
```

**Or let a hook ask.** The lines above work when the agent runs the commands.
`archrift hook install` adds a Claude Code hook that asks for it, off until
installed ([GUIDE.md](GUIDE.md#a-hook-for-claude-code-optional)). When the agent first writes or
edits a code file in a session, archrift puts its notes on the file into the
agent's context. Claude Code hands them over with the result of that write, so
they shape the agent's next edits rather than the first one. A new file gets what `query rules` and `query ways` say about
its place: its layer and constraints, and per job of its block the way to use,
with files that take it. A file that exists gets its rules, what it breaks now,
the jobs it does differently from its block (as `query file` says), and the
block's ways in one line. The notes end with the two commands to ask more. They
come from the project's written graph when it has one (under a second),
else from a fresh analysis (about 2 seconds on archrift itself).

## Limits

- **Coherence's limits are the catalog's** ([COHERENCE.md](COHERENCE.md#limits)).
  A job the catalog doesn't know is never asked about.
- **A hypothetical dependency is a runtime import** of the whole file. Rules on
  type-only imports or on single symbols can't be asked this way.
- **The base's mounts are today's.** Folders analyzed with the root (config
  `mounts`) aren't checked out at the base. The same goes for snapshots.
- **No MCP server yet.** Agents call the CLI. The JSON answers are there for a
  server to wrap.
