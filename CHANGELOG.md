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
