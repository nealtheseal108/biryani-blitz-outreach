import { GoogleGenerativeAI } from "@google/generative-ai";

const MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

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
      const m = genAI.getGenerativeModel({
        model: MODEL,
        generationConfig: {
          temperature: opts.temperature ?? 0.2,
          maxOutputTokens: opts.maxTokens ?? 8192,
        },
      });
      const result = await m.generateContent(prompt);
      return result.response.text();
    },
  };
}
