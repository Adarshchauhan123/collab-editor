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

// Returns { answer } on success, or { error } on failure. Never throws —
// callers (the socket handler in index.js) can just check which key is
// present rather than wrapping every call in try/catch themselves.
async function askAI({ question, code, language }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { error: "The AI helper isn't configured yet — ask the project owner to add a GEMINI_API_KEY (see README)." };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);

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
      return { error: `AI service returned ${res.status}: ${text.slice(0, 200)}` };
    }

    const data = await res.json();
    const answer = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!answer) {
      return { error: "AI service returned an empty response." };
    }

    return { answer };
  } catch (err) {
    if (err.name === "AbortError") {
      return { error: "AI request timed out after 20 seconds." };
    }
    return { error: "Failed to reach the AI service." };
  } finally {
    clearTimeout(timeoutId);
  }
}

module.exports = { askAI };
