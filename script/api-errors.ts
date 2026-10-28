/**
 * The API answers errors with `{"message": "..."}`. Printing the envelope makes every refusal, an
 * expired key or a read-only key among them, read like a bug in the CLI rather than an answer from
 * the server. Anything that is not that shape is passed through untouched, apart from HTML entities.
 */
export function messageFromResponseText(text: string): string {
  if (!text) return text;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.message === "string" && parsed.message) return decodeHtmlEntities(parsed.message);
    const fieldErrors = describeFieldErrors(parsed);
    if (fieldErrors) return decodeHtmlEntities(fieldErrors);
  } catch {
    /* not JSON */
  }
  return decodeHtmlEntities(text);
}

/**
 * The API's request validation answers with a list instead of the envelope:
 * `[{"field":"name","message":"Field is invalid"}]`. Read as "The name field is invalid." Null for anything
 * that is not such a list, so it is passed through as before.
 */
function describeFieldErrors(parsed: unknown): string | null {
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const sentences: string[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry.message !== "string" || !entry.message.trim()) return null;
    const message = entry.message.trim();
    const field = typeof entry.field === "string" && entry.field.trim() ? entry.field.trim() : null;
    const rest = /^field\s+/i.test(message) ? message.replace(/^field\s+/i, "") : null;
    const sentence = field ? (rest ? `The ${field} field ${rest}` : `${field}: ${message}`) : message;
    sentences.push(/[.!?]$/.test(sentence) ? sentence : `${sentence}.`);
  }
  return sentences.join(" ");
}

const NAMED_ENTITIES: { [name: string]: string } = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/**
 * The API escapes user-supplied names it echoes into error text (the Expo routes answer in plain text),
 * so `a&b` arrives as `a&amp;b`. A terminal is not HTML: print what the user typed. One pass, so
 * `&amp;lt;` becomes `&lt;` and not `<`.
 */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (entity: string, body: string): string => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? entity : named;
  });
}
