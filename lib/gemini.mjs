import { GoogleGenerativeAI } from "@google/generative-ai";

const MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const GEMINI_TIMEOUT_MS = Math.max(8000, Number(process.env.GEMINI_TIMEOUT_MS || 30000));
const GEMINI_RETRIES = Math.max(1, Number(process.env.GEMINI_RETRIES || 3));

export function getGeminiApiKey() {
  return process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || "";
}

/**
 * @returns {{ complete: (prompt: string, opts?: { temperature?: number, maxTokens?: number }) => Promise<string> } | null}
 */
export function createGeminiClient() {
  const key = getGeminiApiKey();
  if (!key) return null;
  const genAI = new GoogleGenerativeAI(key);
  const model = genAI.getGenerativeModel({
    model: MODEL,
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 8192,
    },
  });

  return {
    async complete(prompt, opts = {}) {
      let lastErr = null;
      for (let attempt = 1; attempt <= GEMINI_RETRIES; attempt++) {
        try {
          const m = genAI.getGenerativeModel({
            model: MODEL,
            generationConfig: {
              temperature: opts.temperature ?? 0.2,
              maxOutputTokens: opts.maxTokens ?? 8192,
            },
          });
          const result = await Promise.race([
            m.generateContent(prompt),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error(`Gemini timeout after ${GEMINI_TIMEOUT_MS}ms`)), GEMINI_TIMEOUT_MS)
            ),
          ]);
          return result.response.text();
        } catch (e) {
          lastErr = e;
          const msg = String(e?.message || e);
          const retryable = /429|503|quota|rate|timeout|deadline/i.test(msg);
          if (!retryable || attempt >= GEMINI_RETRIES) break;
          await new Promise((r) => setTimeout(r, 700 * attempt));
        }
      }
      throw lastErr || new Error("Gemini completion failed");
    },
  };
}
