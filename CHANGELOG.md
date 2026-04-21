# Changelog

## 1.0.0 (2026-04-21)


### Features

* add FTS5 provider and hybrid RRF search ([bee8cf7](https://github.com/samfoy/pi-session-search/commit/bee8cf702f768f990a33fad7734abf2b99f9ecb8))
* add Mistral and OpenAI-compatible embedding providers ([7f9a50f](https://github.com/samfoy/pi-session-search/commit/7f9a50f36f9446561ded96f7d9ad395ad8e7a291)), closes [#3](https://github.com/samfoy/pi-session-search/issues/3)
* fix FTS side-car population, assistant text in embeddings, session primer injection ([338bd87](https://github.com/samfoy/pi-session-search/commit/338bd8781afffb2f28d972602a1b2932b0dca4ee))
* FTS5 baseline + hybrid RRF search (zero-config by default) ([63c873d](https://github.com/samfoy/pi-session-search/commit/63c873d2b7086ecf978167277cf4fd51227932c8))
* initial release ([228a1a5](https://github.com/samfoy/pi-session-search/commit/228a1a55c31d63433e9a502bb151a9b6d1963295))


### Bug Fixes

* apply review improvements ([2ce5260](https://github.com/samfoy/pi-session-search/commit/2ce5260df4a27849530e04dc5006159d74a25858))
* BOM handling, path traversal guard, busy timeout, smarter re-indexing ([e47e1e6](https://github.com/samfoy/pi-session-search/commit/e47e1e6407e48c145514c6a57bc6c86ca59dd6cd))
* dead code in parser, deduplicate helpers, add tests ([d7595c5](https://github.com/samfoy/pi-session-search/commit/d7595c5ee7054b8ff757f02d113dce48734dbf3a))
* increase sync timeout to 600s for large session counts ([a40d8e4](https://github.com/samfoy/pi-session-search/commit/a40d8e4dda0e3262bc0abe980a010d033c1f80f8))
* make indexing non-blocking so session startup doesn't hang ([d03544a](https://github.com/samfoy/pi-session-search/commit/d03544a1ef34b2cc5253af0bf99188a93f0f97a1))
* use HTTP/1.1 for Bedrock and non-blocking startup sync ([19dfb73](https://github.com/samfoy/pi-session-search/commit/19dfb734e335b4c7af3aaa395a7fe790966d5d0f))
* use unscoped package name ([91af753](https://github.com/samfoy/pi-session-search/commit/91af75363840c5c4bce29657f5659b9b85f48224))


### Performance Improvements

* base64 embeddings, strip heavy fields, INDEX_VERSION 3 ([3274587](https://github.com/samfoy/pi-session-search/commit/3274587334e44d3b21af40a1a4be239e53a146ac))


### Reverts

* use default HTTP/2 for Bedrock embedder ([48e864f](https://github.com/samfoy/pi-session-search/commit/48e864f1f2a4e7a0f45cc674e98dc3830f57c760))
