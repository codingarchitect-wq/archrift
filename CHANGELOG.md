# Changelog

archrift follows [semantic versioning](https://semver.org/). Until 1.0, a minor
version (0.x.0) may change the config or the JSON reports; the notes below say
how to move. `"requires": ">=0.x"` in a project's `.archrift/config.json` makes
an older archrift stop with a message instead of answering wrongly.

## 0.1.0 (unreleased)

The first release as archrift (formerly archviz, a tool inside another project).

- Installs from npm (`npm i -g archrift`, `npx archrift`): the command line, the
  server and the viewer, built; no install scripts.
- A project's folder is `.archrift/`; a `.archviz/` folder from the former name
  is still read when there is no `.archrift/`.
- The project list and the results of projects without a `.archrift/` of their
  own live in `~/.config/archrift/` (`$XDG_CONFIG_HOME/archrift`;
  `ARCHRIFT_HOME` moves it).
- `requires` in the config, `archrift --version`.
- `check --format json` and `diff --format json` carry `schemaVersion: 1`.
- Printed commands (init's lines for agents, the hook's notes) use the command
  archrift was started with: `archrift`, `npx archrift` or `node <path>`.
- `ARCHRIFT_CACHE` moves every project's results (graph, cache, snapshots,
  saved views) to `$ARCHRIFT_CACHE/<name>/`: nothing is written into the
  project. A cache archrift may not write (a sandbox, a read-only checkout) is
  a warning, no longer a crash.
- Coherence's text patterns read a script's code only, not its comments,
  strings or regular expressions: a file that spells a way out (a label, a
  comment) no longer counts as using it. A paradigm with `"strings": true`
  reads strings too (templates, class names, import lines).
- A decision id counts as cited in a script's comments and strings only: a
  type or variable named like one (`P2`) is no citation.
- `query ways --job` with a job the project doesn't do lists the jobs it
  does, with their ids.
- The worktree `diff` and `snapshot` check older commits out in is removed on
  Ctrl-C and SIGTERM too, and one a killed run left is removed by the next
  run (each is locked with its process id, so a parallel run's stays).
