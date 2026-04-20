const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

function hashEmbedding(text, dims = 256) {
  const vec = new Array(dims).fill(0);
  const tokens = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
  for (const tok of tokens) {
    let h = 2166136261;
    for (let i = 0; i < tok.length; i++) {
      h ^= tok.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    vec[Math.abs(h) % dims] += 1;
  }
  const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / mag);
}

export class OpenAIEmbeddingClient {
  async embed(text) {
    const resp = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: String(text || "").slice(0, 8000),
      }),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      throw new Error(`OpenAI embeddings ${resp.status}: ${t.slice(0, 200)}`);
    }
    const data = await resp.json();
    return data?.data?.[0]?.embedding || [];
  }

  async embedBatch(texts) {
    const resp = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: (texts || []).map((t) => String(t || "").slice(0, 8000)),
      }),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      throw new Error(`OpenAI embeddings ${resp.status}: ${t.slice(0, 200)}`);
    }
    const data = await resp.json();
    return Array.isArray(data?.data) ? data.data.map((d) => d.embedding || []) : [];
  }
}

function shouldFallbackToLocal(err) {
  const msg = String(err?.message || err);
  return /OpenAI embeddings (429|503)|quota|rate limit|exceeded your current quota|billing details/i.test(msg);
}

class ResilientEmbeddingClient {
  constructor(primary, fallback) {
    this.primary = primary;
    this.fallback = fallback;
    this.forceFallback = false;
    this.didWarn = false;
  }

  async initialize() {
    if (this.fallback?.initialize) await this.fallback.initialize();
  }

  async embed(text) {
    if (this.forceFallback) return this.fallback.embed(text);
    try {
      return await this.primary.embed(text);
    } catch (e) {
      if (!shouldFallbackToLocal(e)) throw e;
      this.forceFallback = true;
      if (!this.didWarn) {
        this.didWarn = true;
        console.warn("⚠ OpenAI embeddings unavailable; falling back to local embeddings for this run.");
      }
      return this.fallback.embed(text);
    }
  }

  async embedBatch(texts) {
    if (this.forceFallback) return this.fallback.embedBatch(texts);
    try {
      return await this.primary.embedBatch(texts);
    } catch (e) {
      if (!shouldFallbackToLocal(e)) throw e;
      this.forceFallback = true;
      if (!this.didWarn) {
        this.didWarn = true;
        console.warn("⚠ OpenAI embeddings unavailable; falling back to local embeddings for this run.");
      }
      return this.fallback.embedBatch(texts);
    }
  }
}

export class LocalEmbeddingClient {
  async initialize() {
    return;
  }

  async embed(text) {
    return hashEmbedding(text);
  }

  async embedBatch(texts) {
    return (texts || []).map((t) => hashEmbedding(t));
  }
}

export function createEmbeddingClient(provider = "openai") {
  const p = String(provider || "openai").toLowerCase();
  if (p === "openai" && OPENAI_API_KEY) {
    return new ResilientEmbeddingClient(new OpenAIEmbeddingClient(), new LocalEmbeddingClient());
  }
  return new LocalEmbeddingClient();
}

