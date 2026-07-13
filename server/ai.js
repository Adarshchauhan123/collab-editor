// Day 5+: "Ask AI" coding help, backed by Google's Gemini API — free,
// no-card tier (Google AI Studio issues API keys with no billing setup
// required). See README for the 2-minute key setup.
//
// Same proxy reasoning as the Wandbox execution client and Mongo layer:
// the API key is a secret and must never reach the browser, so the server
// is the only thing that ever talks to Gemini directly.
//
// Access to this feature is gated per-room in index.js (host-only by
// default, host can open it to everyone) — this file only knows how to
// make one kind of request: "here's some code and a question, give help."
// It doesn't know or care who's allowed to ask.

const GEMINI_MODEL = "gemini-3.5-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

function buildPrompt({ question, code, language }) {
  const codeBlock = code && code.trim() ? `\n\nTheir current ${language || ""} code:\n\`\`\`\n${code}\n\`\`\`` : "";
  return (
    "You are a concise coding assistant helping someone inside a live pair-programming tool. " +
    "Answer their question directly, and if a code change would help, show it clearly. " +
    "Keep the explanation short — a few sentences plus code, not an essay." +
    codeBlock +
    `\n\nTheir question: ${question}`
  );
}

const REQUEST_TIMEOUT_MS = 45000; // see comment below on why 45s, not 20s

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// One attempt at the actual HTTP call. Split out from askAI so retrying
// (below) is just "call this again" instead of duplicating the whole
// fetch/timeout/parse dance.
async function attemptRequest({ apiKey, question, code, language }) {
  // 45s, not 20s: gemini-3.5-flash has "thinking" (extended reasoning)
  // enabled by default, and a genuinely thoughtful answer to a coding
  // question can take noticeably longer than a simple prompt would --
  // 20s was cutting some real, in-progress requests off early.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(GEMINI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: buildPrompt({ question, code, language }) }] }],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      return { ok: false, status: res.status, error: `AI service returned ${res.status}: ${text.slice(0, 200)}` };
    }

    const data = await res.json();
    const answer = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!answer) {
      return { ok: false, status: res.status, error: "AI service returned an empty response." };
    }

    return { ok: true, answer };
  } catch (err) {
    if (err.name === "AbortError") {
      return { ok: false, error: `AI request timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds.` };
    }
    return { ok: false, error: "Failed to reach the AI service." };
  } finally {
    clearTimeout(timeoutId);
  }
}

// Returns { answer } on success, or { error } on failure. Never throws —
// callers (the socket handler in index.js) can just check which key is
// present rather than wrapping every call in try/catch themselves.
//
// Retries automatically (twice, with a short backoff) ONLY on a 503 --
// that specific status is Gemini's own "this model is overloaded right
// now, temporary, try again" signal, which clears up within a few seconds
// often enough that silently retrying beats making someone manually hit
// "Ask" again. Every other failure (bad key, timeout, network error)
// returns immediately -- retrying those wouldn't help.
async function askAI({ question, code, language }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { error: "The AI helper isn't configured yet — ask the project owner to add a GEMINI_API_KEY (see README)." };
  }

  const delays = [1500, 3000]; // two retries, backing off
  let lastError = "Failed to reach the AI service.";

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    const result = await attemptRequest({ apiKey, question, code, language });
    if (result.ok) return { answer: result.answer };
    lastError = result.error;
    if (result.status !== 503 || attempt === delays.length) break;
    await sleep(delays[attempt]);
  }

  return { error: lastError };
}

module.exports = { askAI };
