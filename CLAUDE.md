# CLAUDE.md

archrift: a codebase's architecture as a 3D map (three.js viewer), rules that fail CI, and answers for coding agents (`query`, `diff`, a Claude Code hook). Analyzers for TypeScript/JavaScript (the TS compiler API), Kotlin and Go (tree-sitter wasm), infrastructure files. Runs on the user's machine. MIT, npm package `archrift`, repo github.com/codingarchitect-wq/archrift. User docs: README.md, docs/GUIDE.md; design: docs/QUERY.md, docs/COHERENCE.md, docs/POLYGLOT.md, docs/ARC42-GENERIC.md.

## Commands

```bash
npm install
node src/cli/main.ts <command> …   # run from source (Node ≥ 22.18 strips the types); `npm link` makes it the `archrift` command
npm run build            # viewer (Vite → dist/viewer, dist/static) + lib/ (tsc, the CLI as JavaScript for the package)
npm test                 # Vitest (~50 s)
npx vitest run tests/cli/hook.test.ts   # one file
npm run typecheck
npm run test:e2e         # Playwright, real WebGL (builds first)
npm run test:pack        # packs the package, installs it into a scratch project, runs the installed command
npm run dev              # Vite dev server on 4310 over fixtures/plain-ts (ARCHRIFT_ROOT=<folder> for another)
```

## Layout

- `src/cli/` commands (`main.ts` is the entry; `self.ts` how archrift runs itself), `src/server/` the local HTTP API + SSE, `src/analyzer/` readers and plugins, `src/core/` the graph model, rules, query, diff (pure), `src/viewer/` React panels + three.js scene; view plug-ins in `src/viewer/views/<id>/` (contract: `views/README.md`).
- `bin/archrift.js` runs `src/` in a checkout and `lib/` from the npm package (Node refuses to strip types under node_modules). The package ships `bin/ lib/ dist/` only (`files` in package.json).
- archrift's own architecture: `.archrift/config.json` (layers cli > viewer > server > analyzer > core; `node-side-without-viewer`: the CLI/server/analyzers never load the viewer, only `src/viewer/url-state.ts`, because `tsconfig.build.json` compiles them without it).

## Conventions

- No formatter config: never run prettier (its defaults rewrite whole files). The style is roughly no semicolons, single quotes, long lines, `arrow-parens: avoid`; match the file you edit.
- Imports carry `.ts` extensions; only erasable TypeScript (no enums, namespaces, parameter properties).
- Paths at run time: never hardcode `.ts`. A file beside the module: `path.extname(import.meta.filename)` (see `src/analyzer/isolated.ts`); the entry: `ENTRY` in `src/cli/self.ts`. Package resources (`dist/`, `package.json`) are found relative to `import.meta.dirname`, the same depth in `src/` and `lib/`.
- State: a project's `.archrift/` (config + descriptions committed; results gitignored), else archrift's home `~/.config/archrift/` (`homeDir()` in `src/cli/projects.ts`; `ARCHRIFT_HOME` moves it). `ARCHRIFT_CACHE` moves every project's results out of the project (`defaultOut`). Caches are written with `writeCache` (`src/analyzer/cache-write.ts`): a folder archrift may not write (sandboxed agents) is a warning, never a crash. Worktrees for older commits only through `inWorktree` (`src/analyzer/worktrees.ts`: locked with the pid, removed on signals, stale ones swept). `.archviz/` (former name) is read when there's no `.archrift/`. Nothing is ever written into the archrift package folder.
- Tests: Vitest sets `ARCHRIFT_HOME=out/test-home`, Playwright `out/e2e/home`; tests that run a command always pass `--out`/`--projects` so they never touch a real project or the user's home. Fixtures live in this repo, so analyses of them pass `history: false` / `--no-history`; history tests build their own repo (`tests/helpers/history-repo.ts`).
- Printed commands (init's agent lines, the hook's notes, the hook command) come from `invokedAs()`: the command the user started archrift with.
- `check --format json` / `diff --format json` carry `schemaVersion` (`JSON_SCHEMA_VERSION`, `src/cli/output.ts`): other tools parse them; raise it when a field changes meaning or goes away.
- A config key added to `ConfigSchema` (`src/analyzer/config.ts`, strict) needs a running `serve` restarted: the hub parses configs with the schema it started with.

## Gotchas

- TypeScript is pinned `~6.0`: 7.x is Go-native and has no in-process checker API.
- `web-tree-sitter@0.27` loads only modern grammar packages' own wasm (`@tree-sitter-grammars/tree-sitter-kotlin`, `tree-sitter-go`); older `tree-sitter-wasms` fail silently. Tree-sitter nodes are new objects per access: compare `.id`.
- Bump `VERSION` in `src/analyzer/jvm/analyzer.ts` / `go/analyzer.ts` when their pass output changes (their caches key on it).
- zustand v5 selectors must never return fresh arrays/objects (`?? []` loops React): select plain state, derive in render.
- E2E: each checkout can move its ports with `ARCHRIFT_E2E_PORT`; `window.__archrift` (ready, idle, select, setOptions, scene, camera) drives tests and screenshots (`scripts/showcase/stills.mjs`).
- The analysis runs on a worker thread with a 64 MB stack and a sized heap: TypeScript's checker overflows Node's default stack on some codebases.

## Releasing

Version 0.x: a minor may change the config or the JSON reports (CHANGELOG.md says how to move). `npm version minor` (or patch), update CHANGELOG.md, `git push --follow-tags`: `.github/workflows/release.yml` tests and publishes with provenance (npm trusted publishing). CI runs on GitHub's runners only, never self-hosted ones (a public repo's fork PRs could run code on them).

## Architecture checks (archrift on itself)

Before finishing a change, see what it does to the architecture and fix new rule violations: `node src/cli/main.ts diff`. Before importing across `src/` folders: `node src/cli/main.ts query rules <file> --to <file or package>`. A function the diff shows past a complexity limit (new, crossing it, or growing) is split under it in the same change: 10 outside the viewer, 20 in it (existing code above the limits is a warning, not a reason to grow it).
