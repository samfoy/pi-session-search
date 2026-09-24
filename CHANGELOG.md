# Changelog

## 1.6.0

The first npm release since 1.4.3. It also ships everything listed under 1.5.0, which reached GitHub but never npm.

### Fixed

- Startup indexing no longer freezes pi's UI ([#16](https://github.com/samfoy/pi-session-search/issues/16)).
  The session index now loads, syncs and answers queries on a worker thread (`dist/index-worker.js`).
  Measured on 4,917 session files (1.16 GB): the first run used to block pi's event loop for about 9 s,
  and a warm start for about 1 s (repeated by the 5-minute periodic sync). Neither now blocks the main thread
  for more than 50 ms after `session_start`.
- If a tool is called before the first sync finishes, it answers from the saved index and says
  `index warming`. If the saved index hasn't loaded yet, it says so and asks you to try again.
- The session primer is sent with `triggerTurn: false`. When it arrives while a turn is already
  streaming, it is appended after that turn instead of steering it.
- The hybrid-mode JSON index is written atomically (temp file plus rename).
- `pi install git:github.com/samfoy/pi-session-search` works again. The `prepare` script ran esbuild under
  `npm install --omit=dev`; it is now `prepack`, and `dist/` stays committed.

### Changed

- The peer dependency and imports move from `@sinclair/typebox` to `typebox` (TypeBox 1.x), which is what
  current pi provides.
- `engines.node` is now `>=22.19.0`, pi's own floor. 1.4.3 declared `>=24`. The full test suite passes on
  Node 22.19.0, whose `node:sqlite` includes FTS5.
- CI now runs the typecheck (`npm run check`), the tests and the build, and checks that the committed `dist/`
  is current. Releases publish from `publish.yml` through npm trusted publishing.
- `package-lock.json` is regenerated against registry.npmjs.org. The old lockfile made `npm ci` fail in
  the release workflow, which is why 1.5.0 never reached npm.
- LICENSE copyright holder corrected to Sam Painter.

## 1.5.0 (GitHub only, never published to npm)

### Added

- `fusion: "vector-primary"` config option for hybrid search. It keeps the cosine ranking and appends up to five
  FTS-only hits instead of RRF-blending them. This suits non-English corpora where FTS carries little signal
  ([#14](https://github.com/samfoy/pi-session-search/issues/14)). The default is still `"rrf"`.

### Fixed

- OpenAI-compatible embedders that omit `index: 0` in responses (for example Gemini) no longer fail every
  search ([#13](https://github.com/samfoy/pi-session-search/issues/13)).
