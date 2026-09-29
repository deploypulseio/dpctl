/**
 * The API answers errors with `{"message": "..."}`. Printing the envelope makes every refusal, an
 * expired key or a read-only key among them, read like a bug in the CLI rather than an answer from
 * the server. Anything that is not that shape is passed through untouched.
 */
export function messageFromResponseText(text: string): string {
  if (!text) return text;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.message === "string" && parsed.message) return parsed.message;
  } catch {
    /* not JSON */
  }
  return text;
}
