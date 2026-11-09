# Coherence: how many ways the code does each job

*2026-10-22 · status: done (catalog, `archrift coherence`, the Coherence view) · results for archrift itself below*

After the essay [Decoherence](https://maevyn.codes/decoherence). It calls the
main form of technical debt *decoherence*: the accumulation of "locally valid
but mutually incompatible or redundant models". Two date libraries, three HTTP
clients, field and constructor injection: each choice made sense where it was
made, together they make every change pay for translating between them.

The essay's points that this measures:
- **Decoherence grows with change, not with time.** Code left alone stays as
  coherent as it was; each change either adds a model or removes one.
- **Its simulation:** components are nodes, colored by their paradigm. A
  feature walks part of the graph, and the walk costs more for more edges, more
  color changes and longer paths. Below a certain coherence the system falls
  into a trap where features take ever longer; above it, the colors gather
  again.
- **Its advice:** stop and recohere when decoherence is high, and finish a
  recoherence: one left half done starts the cycle again.

## From the essay to the graph

| Essay | archrift |
|---|---|
| A paradigm (a node's color) | A **way** to do a job: a library or a code pattern (`java.time`, `RestTemplate`, field injection) |
| A model one job is done in | A **concern**: the job, per stack (`JVM · Dates`, `JS · Test doubles`) |
| Components | Files, grouped into **blocks**: the config's groups (services), the toolbar's grouping, or the folders where the code splits |
| Color changes on a walk | **Transitions**: a dependency between two files that do the job with no way in common |
| A trap, or recoherence | **Recent work**: did the newest fifth of the files (by first commit) keep to their block's way? |

### What a file is tagged with

The analyzer tags each file with the ways it uses
(`paradigm:jvm.dates=java-util-date`, src/analyzer/coherence/). A file uses a
way when:
- it **imports** one of the way's packages or prefixes. That is the specifier
  as written (`date-fns`, `org.junit.jupiter.api.Test`), or the project file
  it resolves to (a project's own wrapper, through the config);
- or, for a pattern way, its **text** matches (`@Autowired lateinit var`,
  `new BehaviorSubject`, `| async`), in the languages the pattern is written
  for.

Test concerns (test framework, test doubles, assertions, end-to-end tests) look
at test files only, the others at production code only. Angular's concerns look
at files that import `@angular/*` and at component templates.

### What is measured (src/core/coherence.ts)

Per concern:
- **Ways in use,** most files first; the first is the **main way**.
- **Coherence:** the share of its files on the main way alone.
  - **Within blocks:** the share on their own block's main way alone. A service
    on WebFlux beside services on Spring MVC is coherent within blocks.
- **Kind:**
  - **one way;**
  - **one way per block:** the blocks differ, but none mixes;
  - **mixed:** some block does the job several ways. This is the decoherence
    that costs.
- **Files off their block's way** (strays), and **files on several ways**
  (where code translates between models).
- **Transitions** among the dependencies between its files.
- **Migration:** when a legacy way (moment, `java.util.Date`, `javax.*`,
  JUnit 4, untyped forms) meets a newer one, the share done and the files left.
  Without a legacy mark, the **newest way**: the one whose files were written
  last.
- **Recent work:** the files first committed after the 80th percentile of all
  first commits, so a project that went quiet a year ago still has a recent
  past and a bulk import stays old. **Converging:** every recent file is on its
  block's way. **Spreading:** some recent file isn't.

Per block, its **load**: the extra ways a reader has to learn there, which is
Σ over the mixed concerns of (ways in the block − 1).

Concerns a project marks **accepted** (with the reason) are shown, but they
count neither as mixed nor toward strays and loads.

### The catalog (src/analyzer/coherence/catalog.ts)

| Stack | Concerns |
|---|---|
| JS | dates, HTTP calls, shared state, forms, validation, asynchronous code, database access, logging, UI components, styling, charts, translations, notifications, icons, utility belt; tests: framework, doubles, end-to-end |
| Angular | ending subscriptions, injecting dependencies, building blocks (NgModules or standalone) |
| JVM | dates, Java EE namespace (javax or jakarta), HTTP calls, web stack, SQL access, messaging clients, JSON, asynchronous code, logging, configuration, injecting dependencies, utility belt; tests: framework, doubles, assertions |
| Go | logging, JSON, Kafka clients; tests: assertions |

A project adds its own concerns, or more imports and patterns for a catalog
way, and accepts concerns it does several ways on purpose:

```jsonc
"coherence": {
  "concerns": [
    // the project's own HTTP helper counts as fetch for the files that import it
    { "id": "js.http", "paradigms": [{ "id": "fetch", "imports": ["src/lib/http.ts"] }] },
    // a concern of its own: imports (a prefix, a project file or /regex/) or a text pattern;
    // in JavaScript and TypeScript a text pattern reads the code only, "strings": true reads strings too
    { "id": "events", "label": "Events", "paradigms": [
      { "id": "bus", "imports": ["@acme/bus"] },
      { "id": "emitter", "text": "new EventEmitter\\(" },
      { "id": "template-events", "text": "\\(\\w+\\)=\"on[A-Z]", "strings": true }
    ] }
  ],
  "accept": { "js.charts": "D3 for the custom diagrams, Chart.js for the plain charts" }
}
```

## Using it

- **Command line:** `archrift coherence [root] [--config <file>] [--format json]`
  analyzes the project (cached) and prints the report:
  - the mixed concerns, least coherent within blocks first, each with its ways,
    migration, recent work, mixing blocks and up to 12 files off their block's way;
  - the concerns done one way per block, the accepted ones, and the ones done one way;
  - the blocks by load.
- **The Coherence view** (last button in the toolbar) has two modes,
  **City** and **Clouds**. The toolbar's **edges** option picks the lines in
  both:
  - **auto:** the view's own lines only. In the city, that's the transitions
    of the job picked; the automatic grey arcs between all dependencies stay
    out, so with nothing selected and no job picked there are no lines. In the
    clouds, it's every dependency between the dots.
  - **all:** in the city, every dependency as an arc as well; in the clouds,
    the same as auto.
  - **selection:** only the lines around the selected file (none without a
    selection).
  - **violations:** only the dependencies that break a rule, in red; in the
    city, the transitions step aside for them.
  - **none:** no lines; the clouds show only their dots.
  - **City, no job picked:** each file glows by how many jobs it does
    differently from its folder (or group), from calm blue to red; dark files
    do none of the jobs. Each block says how many extra ways it makes a reader
    learn.
  - **City, a job picked in the toolbar's report:** each building takes the
    color of its way, with the main way blue and a file on several ways
    magenta. Arcs mark the transitions, colored from one way to the other, and
    blocks that mix the job say how many ways they mix.
  - **Clouds** draws the essay's pictures. Files are dots, pulled together by
    their dependencies, and each service or folder gathers into a lobe. One
    layout serves every cloud, so the same file sits in the same place in each.
    - **No job picked:** one small cloud per job done several ways (jobs of
      the tests only while the tests are shown), side by side. In each, the
      files doing the job take their way's color over a faint outline of the
      rest. A coherent job is a cloud whose colors gather into lobes; a mixed
      one is speckled. A click anywhere in a cloud opens it.
    - **A job picked:** its cloud alone, big. Grey lines join its files that
      depend on each other within one way; lines in both ways' colors are
      transitions.
    - **Color the dots by way** (as above: the culprits stand out) **or by
      folder / group** (like the minimap: every dot in its group's color, so
      the lobes stand out, the job's files bright and the rest faint). By
      group, the culprits, the files that do the job differently from their
      group, are ringed, and transitions are drawn in the rings' color.
    - The layout is worked out in a worker, so the page stays responsive on a
      large system, and the mode and the coloring are remembered in the
      browser.
  - **The report** says what a job and a way are, then ranks the jobs the way
    the command does, each as a bar of its ways (legacy ones hatched), under
    column headings.
    - A job's details hold its migration, recent work and mixing blocks.
    - They also list the files that do the job differently from their block;
      a click selects one. In a small folder the majority wins, so a listed
      file isn't necessarily the wrong one.
  - **The key** explains the colors of the mode shown. For a test job, it
    offers to show the tests. Over the clouds it first says how to read one,
    after the essay's legend: a **dot** is a file doing some job, its
    **size** its lines of code, its **color** the way it does the cloud's job
    (or its group), a **line** a dependency; files close together depend on
    each other, and a lobe is a folder or group.
  - **Where the clouds differ from the essay's pictures:**

    | Essay | Clouds |
    | --- | --- |
    | Nodes: the system's components | One dot per file, only the files doing some job of the catalog (the rest would only add grey) |
    | Node size: the component's size | Lines of code through a cube root, so a 3,000-line file doesn't hide its neighbors: the biggest dot is about twice the smallest, and every file over about 940 lines gets it |
    | Node color: the component's dominant paradigm | The way the file does one job, so one cloud per job: a file can take `java.time` for dates and WebClient for HTTP, and has no single paradigm. A file doing a job two ways is magenta: the tags say which ways a file uses, not how much of each, so there is no dominant one to pick |
    | Edges: connections | The viewer's file dependencies (imports, calls, references, topics) between the dotted files; a path through a file left out isn't drawn |
    | (placement not described) | Dependencies pull files together, and each folder or group is anchored on a spiral so it forms a lobe; the essay's pictures change over time, the clouds show one moment (the timeline moves it) |
    | (none) | Coloring by group and the rings around culprits are this tool's own |
- For a system of services, a saved view of the Coherence view grouped by
  service, without the background arcs, is a good way in.

## Results on archrift itself (2026-11-09)

`archrift coherence .` in the archrift checkout, whose config adds no
concerns of its own (trimmed):

```
archrift coherence archrift: 9 concerns · 8 done one way · 0 one way per block · 1 mixed · 3 of 172 files off their block's main way
recent work: files first committed after 2026-11-09 (the newest fifth)

Mixed: blocks doing one job several ways, least coherent first
  JS · Shared state: state several components share
    Zustand 27 · external store (useSyncExternalStore) 3
    coherence 90 % within blocks, 90 % overall · off their block's main way 3 · on several ways 0 · transitions 0 of 38 links
    …
    mixed in 1 of 1 blocks: src/viewer (Zustand, external store (useSyncExternalStore))
      src/viewer/views/context/Legend.tsx  external store (useSyncExternalStore)
      src/viewer/views/matrix/controls.tsx  external store (useSyncExternalStore)
      src/viewer/views/terrain/controls.tsx  external store (useSyncExternalStore)

One way
  JS · Test framework: Vitest, 80 files
  JS · Asynchronous code: promises (async/await, then), 33 files
  JS · End-to-end tests: Playwright, 25 files
  JS · Styling: imported stylesheets, 8 files
  JS · Charts: D3, 2 files
  JS · HTTP calls: fetch, 1 file
  JS · Logging: console, 1 file
  JS · Validation: Zod, 1 file
```

- **Shared state is the one real mix.** The viewer keeps its state in one
  Zustand store (27 files). Three views read small stores of their own
  through `useSyncExternalStore`: the context view's legend, the matrix
  view's and the terrain view's controls. No dependency joins the two models
  (0 transitions), so no code translates between them. The decision left is
  whether a view's own state belongs in the shared store, or the concern is
  accepted.
- **The catalog doesn't count as using what it describes.**
  `src/analyzer/coherence/catalog.ts` spells out the patterns ways are
  recognized by (`FormControl`, `ngModel`, `$localize`, `alert(`), in
  regular expressions and labels. Text patterns read a script's code only,
  so it does no forms, translations or notifications.
- **Done one way:** Vitest and Playwright for the tests, promises for
  asynchronous code, imported stylesheets, D3 (the galaxy layout and the
  Coherence clouds), Zod (the config), and `fetch` in a single file: the
  viewer's requests to the server all go through `src/viewer/api.ts`.
- **Recent work says nothing yet.** The repository starts with two commits
  on one day, so every file has the same first commit and none counts as
  recent.

**Reading it through the essay.** One model per job, and a seam (the
viewer's `api.ts`) keeps the requests to the server in one place. The trap is
far away; the views' own stores are the one decision to make before they
multiply.

## Limits

- **It only sees the ways it knows.** A catalog entry or a config entry has to
  name a way. Two hand-written date helpers, or two internal event buses,
  stay invisible until the config names them.
- **Files are counted, not uses.** A file that imports moment once counts as
  much as one built on it.
- **A wrapper hides its library.** Only the wrapper imports the package, so
  its callers count for no way unless the config adds the wrapper to the way
  (as the `js.http` entry in the config above does).
- **Transitions are dependencies, not data flow.** Two files that inject
  differently and depend on each other translate nothing. Transitions mean
  most for value models (dates, state, async).
- **Text patterns are approximations.** Constructor injection is a Spring
  stereotype whose class takes `val` parameters. Tailwind is recognized by
  common utility classes in `className`. In JavaScript and TypeScript a text
  pattern reads the code only: comments, strings and regular expressions are
  left out, so a file that spells a pattern out (a label, a comment, the
  catalog itself) doesn't use it. The ways that live in strings read them too
  (`strings: true`: Angular templates, `$localize` texts, class names, import
  lines). The scanner reads JSX text as code, and other languages' files
  whole.
- **Recent work is relative:** the newest fifth of the files, by first commit
  (renames followed). It says which way new code took, not how fast the
  decoherence grows. A repository whose files all came in one commit has no
  recent work yet.
