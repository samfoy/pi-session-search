/**
 * Embedding interface + factory. Reuses the same provider patterns as
 * pi-knowledge-search but lives in this package to avoid a hard dependency.
 */

export interface Embedder {
  embed(text: string, signal?: AbortSignal): Promise<number[]>;
  embedBatch(
    texts: string[],
    signal?: AbortSignal
  ): Promise<(number[] | null)[]>;
}

export interface EmbedderConfig {
  type: "openai" | "bedrock" | "ollama";
  // OpenAI
  apiKey?: string;
  model?: string;
  // Bedrock
  profile?: string;
  region?: string;
  // Ollama
  url?: string;
  // Shared
  dimensions?: number;
}

const DEFAULTS: Record<string, Partial<EmbedderConfig>> = {
  openai: { model: "text-embedding-3-small", dimensions: 512 },
  bedrock: {
    model: "amazon.titan-embed-text-v2:0",
    region: "us-east-1",
    profile: "default",
    dimensions: 512,
  },
  ollama: { model: "nomic-embed-text", url: "http://localhost:11434" },
};

export function createEmbedder(config: EmbedderConfig): Embedder {
  const defaults = DEFAULTS[config.type] ?? {};
  const merged = { ...defaults, ...config };

  switch (merged.type) {
    case "openai":
      return new OpenAIEmbedder(
        merged.apiKey || process.env.OPENAI_API_KEY || "",
        merged.model!,
        merged.dimensions!
      );
    case "bedrock":
      return new BedrockEmbedder(
        merged.profile!,
        merged.region!,
        merged.model!,
        merged.dimensions!
      );
    case "ollama":
      return new OllamaEmbedder(merged.url!, merged.model!);
    default:
      throw new Error(`Unknown embedder type: ${merged.type}`);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function truncate(text: string, maxChars = 12000): string {
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

async function parallelMap<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number,
  signal?: AbortSignal
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      if (signal?.aborted) throw new Error("Aborted");
      const idx = cursor++;
      results[idx] = await fn(items[idx]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );
  return results;
}

// ─── OpenAI ──────────────────────────────────────────────────────────

class OpenAIEmbedder implements Embedder {
  constructor(
    private apiKey: string,
    private model: string,
    private dimensions: number
  ) {}

  async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    const [result] = await this.embedBatch([text], signal);
    if (!result) throw new Error("Embedding failed");
    return result;
  }

  async embedBatch(
    texts: string[],
    signal?: AbortSignal
  ): Promise<(number[] | null)[]> {
    const BATCH = 100;
    const results: (number[] | null)[] = new Array(texts.length).fill(null);

    for (let i = 0; i < texts.length; i += BATCH) {
      if (signal?.aborted) throw new Error("Aborted");
      const batch = texts.slice(i, i + BATCH).map((t) => truncate(t));

      const res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input: batch,
          model: this.model,
          dimensions: this.dimensions,
        }),
        signal,
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`OpenAI ${res.status}: ${body.slice(0, 200)}`);
      }

      const json = (await res.json()) as {
        data: { embedding: number[]; index: number }[];
      };
      for (const item of json.data) {
        results[i + item.index] = item.embedding;
      }
    }
    return results;
  }
}

// ─── Bedrock ─────────────────────────────────────────────────────────

class BedrockEmbedder implements Embedder {
  private clientPromise: Promise<any>;

  constructor(
    profile: string,
    region: string,
    private model: string,
    private dimensions: number
  ) {
    this.clientPromise = (async () => {
      const { BedrockRuntimeClient } = await import(
        "@aws-sdk/client-bedrock-runtime"
      );
      const { fromIni } = await import("@aws-sdk/credential-providers");
      return new BedrockRuntimeClient({
        region,
        credentials: fromIni({ profile }),
      });
    })();
  }

  async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    const [result] = await this.embedBatch([text], signal);
    if (!result) throw new Error("Embedding failed");
    return result;
  }

  async embedBatch(
    texts: string[],
    signal?: AbortSignal
  ): Promise<(number[] | null)[]> {
    const client = await this.clientPromise;
    return parallelMap(
      texts,
      async (text) => {
        const { InvokeModelCommand } = await import(
          "@aws-sdk/client-bedrock-runtime"
        );
        const body = JSON.stringify({
          inputText: truncate(text),
          dimensions: this.dimensions,
          normalize: true,
        });
        const cmd = new InvokeModelCommand({
          modelId: this.model,
          contentType: "application/json",
          accept: "application/json",
          body: new TextEncoder().encode(body),
        });
        const res = await client.send(cmd);
        const parsed = JSON.parse(new TextDecoder().decode(res.body));
        if (!parsed.embedding) throw new Error("No embedding in response");
        return parsed.embedding;
      },
      10,
      signal
    );
  }
}

// ─── Ollama ──────────────────────────────────────────────────────────

class OllamaEmbedder implements Embedder {
  constructor(
    private url: string,
    private model: string
  ) {
    this.url = url.replace(/\/$/, "");
  }

  async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    const res = await fetch(`${this.url}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, input: truncate(text) }),
      signal,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Ollama ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as { embeddings: number[][] };
    return json.embeddings[0];
  }

  async embedBatch(
    texts: string[],
    signal?: AbortSignal
  ): Promise<(number[] | null)[]> {
    return parallelMap(
      texts,
      async (text) => {
        try {
          return await this.embed(text, signal);
        } catch {
          return null;
        }
      },
      4,
      signal
    );
  }
}
