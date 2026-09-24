# Changelog

## 1.6.0

The first npm release since 1.4.3. It also ships everything listed under 1.5.0, which reached GitHub but never npm.

### Fixed

- Startup indexing no longer freezes pi's UI ([#16](https://github.com/samfoy/pi-session-search/issues/16)).
  The session index now loads, syncs and answers queries on a worker thread (`dist/index-worker.js`).
  Measured on synthetic corpora of 3,000 and 10,000 sessions (73 MB and 245 MB of JSONL): the first run
  used to block pi's event loop for 1.1 s and 3.6 s, and a warm start for 0.16 s and 0.53 s (repeated by
  the 5-minute periodic sync). Neither now blocks the main thread for more than 50 ms after `session_start`.
  The first sync itself takes as long as in 1.4.3: 1.1 s and 3.5 s.
- If a tool is called before the first sync finishes, it answers from the saved index and says
  `index warming`. If the saved index hasn't loaded yet, it says so and asks you to try again.
- The session primer is sent with `triggerTurn: false`. When it arrives while a turn is already
  streaming, it is appended after that turn instead of steering it.
- The hybrid-mode JSON index is written atomically (temp file plus rename).
- Two pi processes syncing at once (pi-conductor starts child sessions together) no longer index every
  new session twice in the FTS index. The first time 1.6.0 opens an index, it also removes duplicates that
  earlier releases left behind, keeping each session's newest row. If another process holds the write lock
  at that moment, the cleanup waits for a later open or sync, and loading goes ahead without it.
- A sync that fails partway rolls back its unfinished batch. Before, the open transaction made every
  later sync fail, so the index stopped updating until pi restarted.
- If the index worker crashes, you get one notification instead of two. It and the tools'
  "Session index unavailable" text now end with "Run /reload to restart indexing." Init failures that
  /reload can't fix, such as a Node build without FTS5, keep their own advice.
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
