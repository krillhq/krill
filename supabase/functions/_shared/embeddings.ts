// Embeddings with Voyage AI (voyage-code-3, 1024 dimensions). They're computed outside the function:
// generating them inside (gte-small) exhausted the Edge Functions' CPU limit.
const ENDPOINT = "https://api.voyageai.com/v1/embeddings";
const MODEL = "voyage-code-3";
const DIMENSIONS = 1024;
const MAX_INPUTS = 128;
const MAX_CHARS_PER_REQUEST = 240_000; // ~80K tokens, under the 120K-per-request limit
const MAX_RETRIES = 3;

// Voyage is optional: without VOYAGE_API_KEY all rules are sent without vector search
// and reviews skip the code index (helper catalog and similar-code search).
export const embeddingsEnabled = Boolean(Deno.env.get("VOYAGE_API_KEY"));

// "document" for what's stored, "query" for what's searched; null to compare code with code
export type InputType = "document" | "query" | null;

export async function embedMany(texts: string[], inputType: InputType): Promise<number[][]> {
  const result: number[][] = [];
  for (const batch of batches(texts)) {
    const vectors = await request(batch, inputType);
    result.push(...vectors);
  }
  return result;
}

export async function embed(text: string, inputType: InputType): Promise<number[]> {
  return (await embedMany([text], inputType))[0];
}

function* batches(texts: string[]): Generator<string[]> {
  let batch: string[] = [];
  let chars = 0;
  for (const text of texts) {
    if (batch.length > 0 && (batch.length === MAX_INPUTS || chars + text.length > MAX_CHARS_PER_REQUEST)) {
      yield batch;
      batch = [];
      chars = 0;
    }
    batch.push(text);
    chars += text.length;
  }
  if (batch.length > 0) yield batch;
}

async function request(input: string[], inputType: InputType): Promise<number[][]> {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${Deno.env.get("VOYAGE_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ input, model: MODEL, input_type: inputType, output_dimension: DIMENSIONS }),
    });
    if (response.ok) {
      const { data } = (await response.json()) as { data: { embedding: number[]; index: number }[] };
      return data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    }
    // 429 (rate limit) and 5xx are transient: retry with growing backoff
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= MAX_RETRIES) {
      throw new Error(`Voyage ${response.status}: ${await response.text()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
  }
}
