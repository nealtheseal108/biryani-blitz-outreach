/** Extract JSON array or object from LLM text (markdown fences tolerated). */

export function extractJSONArray(text) {
  const clean = String(text || "")
    .replace(/```json\n?|```\n?/g, "")
    .trim();
  const start = clean.indexOf("[");
  const end = clean.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(clean.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function extractJSONObject(text) {
  const clean = String(text || "")
    .replace(/```json\n?|```\n?/g, "")
    .trim();
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(clean.slice(start, end + 1));
  } catch {
    return null;
  }
}
