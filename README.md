# pi-session-search

Index, summarize, and search past [pi](https://github.com/badlogic/pi-mono) coding sessions. Works out of the box with zero configuration — FTS5 keyword search is always on, with optional semantic embeddings for hybrid search.

## Features

- **Zero-config search** — FTS5 keyword search works immediately, no API keys or embedder needed
- **Hybrid search** — When an embedder is configured, combines cosine similarity + BM25 via Reciprocal Rank Fusion for best-of-both-worlds retrieval
- **Browse & filter** — List sessions by project, date range, archive status (`session_list`)
- **Read conversations** — View the full conversation from any past session (`session_read`)
- **Auto-indexing** — Parses JSONL session files on startup, tracks changes incrementally
- **Archive support** — Indexes both `~/.pi/agent/sessions/` and `~/.pi/agent/sessions-archive/`
- **Multiple embedders** — OpenAI, Mistral, AWS Bedrock, local Ollama, or any OpenAI-compatible API

## Install

```bash
pi install pi-session-search
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["npm:pi-session-search"]
}
```

Requires **Node 22.5+** (`node:sqlite` is used for FTS5). Node 24+ is recommended — `node:sqlite` is stable there. On Node 22 you'll see an `ExperimentalWarning` which is harmless.

## Setup

**No setup required for keyword search.** FTS5-backed search works immediately after install.

To enable hybrid search (keyword + semantic), run `/session-embeddings-setup` in pi to configure an embedding provider:

- **OpenAI** — Uses `text-embedding-3-small` (needs `OPENAI_API_KEY`)
- **Mistral** — Uses `mistral-embed` (needs `MISTRAL_API_KEY`)
- **Bedrock** — Uses Titan Embeddings v2 (needs AWS credentials)
- **Ollama** — Uses `nomic-embed-text` (needs local Ollama running)
- **OpenAI-compatible** — Any provider with a `/v1/embeddings` endpoint (Together, Fireworks, vLLM, LiteLLM, etc.)

Config is stored at `~/.pi/session-search/config.json`. The `embedder` field is optional — omit it for FTS5-only mode.

### OpenAI-compatible providers

Many embedding providers expose an OpenAI-compatible `/v1/embeddings` endpoint. Use `"type": "openai-compatible"` with a `baseUrl`:

```json
{
  "embedder": {
    "type": "openai-compatible",
    "baseUrl": "https://api.together.xyz",
    "apiKey": "your-key",
    "model": "togethercomputer/m2-bert-80M-8k-retrieval",
    "dimensions": 768
  }
}
```

This works with Together, Fireworks, vLLM, LiteLLM, Anyscale, and any other provider that implements the OpenAI embeddings format.

## Usage

### Search
```
session_search(query="how did we debug the Lambda timeout")
session_search(query="CI pipeline configuration", limit=5)
```

### Browse sessions
```
session_list(project="Rosie", after="2026-03-01")
session_list(archived=true, limit=20)
```

### Read a session
```
session_read(session="<file-path-or-uuid>")
session_read(session="<id>", offset=50, limit=50)
```

## Commands

| Command | Description |
|---------|-------------|
| `/session-embeddings-setup` | Configure embedding provider for hybrid search |
| `/session-sync` | Force an immediate incremental re-sync |
| `/session-reindex` | Force full re-index of all sessions |

## How It Works

### FTS5-only mode (default)

1. On startup, discovers all `.jsonl` session files
2. Parses each session to extract: user messages, tool calls, files modified, compaction summaries
3. Indexes content into an FTS5 virtual table with Porter stemming
4. Queries use BM25 ranking with implicit AND across search terms

### Hybrid mode (with embedder configured)

1. Everything above, plus generates an embedding vector for each session
2. At query time, runs both cosine similarity and FTS5 BM25
3. Fuses the two ranked lists via **Reciprocal Rank Fusion** (k=60)
4. Sessions that both signals agree on rank highest; single-signal matches still surface

RRF is parameter-free and robust — it discards raw scores (which are incomparable across rankers) and uses only rank positions. Agreement between signals becomes the strongest relevance indicator.

### Why hybrid?

FTS misses semantic matches ("dagger injection" won't find sessions about "dependency injection refactoring" if the exact words aren't there). Cosine misses precise tokens (CR numbers, error codes, file paths all hash to nearby embedding regions). The two failure modes are disjoint — combining them recovers what each misses alone.

Tested against a 2,159-session corpus: hybrid surfaces **75% more relevant documents** than FTS alone, with the top results dominated by sessions both signals independently found.

### Indexing

- Index stored at `~/.pi/session-search/index/`
- Incremental sync on startup + every 5 minutes
- Two separate SQLite DBs: `sessions-fts.db` (pure-FTS mode) and `hybrid-fts.db` (side-car for embedder mode)
- Switching modes doesn't corrupt state

## Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | Required for OpenAI embedder |
| `MISTRAL_API_KEY` | Required for Mistral embedder |

## License

MIT
