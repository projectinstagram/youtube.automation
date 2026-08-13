// Semantic keyword validation via embeddings - an ADDITIONAL signal alongside the
// LLM verifier, not a replacement for it (embeddings are noisy for short phrases
// and miss things an LLM catches via reasoning, like "podcast" being implied by
// "podcast studio setting" despite low lexical/semantic overlap with a single word).
//
// Threshold calibrated against real test data before wiring this in: embedding
// nemotron-3-embed-1b against a real evidence transcript, clearly-supported
// keywords scored 0.24-0.50 cosine similarity, clearly-unrelated/hallucinated
// keywords (e.g. "bitcoin" injected into unrelated startup content) scored
// 0.06-0.12 - a wide, clean gap. 0.15 sits in that gap.

import { fetchWithTimeout } from '@/lib/gemini/fetchWithTimeout';

const NVIDIA_EMBEDDINGS_URL = 'https://integrate.api.nvidia.com/v1/embeddings';
const EMBEDDING_MODEL = 'nvidia/nemotron-3-embed-1b';
const SIMILARITY_THRESHOLD = 0.15;
const EMBEDDING_TIMEOUT_MS = 8_000;

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

async function getEmbedding(text: string, inputType: 'query' | 'passage'): Promise<number[]> {
  const apiKey = requireEnv('NVIDIA_API_KEY');
  const response = await fetchWithTimeout(NVIDIA_EMBEDDINGS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: [text], input_type: inputType }),
  }, EMBEDDING_TIMEOUT_MS);

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Embeddings API error ${response.status}: ${errText.slice(0, 300)}`);
  }

  const json = await response.json();
  return json.data[0].embedding;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Flags keywords with low semantic similarity to the combined evidence text.
 * Returns only the ones below threshold (the caller merges these with the LLM
 * verifier's own invalid_keywords rather than trusting embeddings alone).
 */
export async function semanticKeywordCheck(
  keywords: string[],
  evidenceText: string
): Promise<{ keyword: string; similarity: number }[]> {
  if (!evidenceText.trim() || keywords.length === 0) return [];

  const evidenceEmbedding = await getEmbedding(evidenceText, 'passage');

  const flagged: { keyword: string; similarity: number }[] = [];
  for (const keyword of keywords) {
    const keywordEmbedding = await getEmbedding(keyword, 'query');
    const similarity = cosineSimilarity(evidenceEmbedding, keywordEmbedding);
    if (similarity < SIMILARITY_THRESHOLD) {
      flagged.push({ keyword, similarity: Math.round(similarity * 1000) / 1000 });
    }
  }
  return flagged;
}
