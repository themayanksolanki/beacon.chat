import type { MessageRow } from "./db/database";

const DEFAULT_MODEL = "llama3.2";
const DEFAULT_OLLAMA_URL = "http://localhost:11434";
const REQUEST_TIMEOUT_MS = 30000;
const MAX_HISTORY_MESSAGES = 10;

const OLLAMA_URL =
  process.env.EXPO_PUBLIC_TEST_BOT_OLLAMA_URL ?? process.env.EXPO_PUBLIC_OLLAMA_URL ?? DEFAULT_OLLAMA_URL;
const OLLAMA_MODEL = process.env.EXPO_PUBLIC_TEST_BOT_MODEL ?? process.env.EXPO_PUBLIC_OLLAMA_MODEL ?? DEFAULT_MODEL;

type TestBotHistoryMessage = Pick<MessageRow, "direction" | "plaintext">;

interface OllamaChatResponse {
  message?: { content?: unknown };
  response?: unknown;
}

function offlineReply(input: string): string {
  const text = input.trim();
  if (text.endsWith("?") || /\b(can|could|should|how|what|why|when|where|which)\b/i.test(text)) {
    return "I can help with that, but I'm having trouble thinking right now. Try again in a moment.";
  }
  if (/\b(hi|hello|hey)\b/i.test(text)) {
    return "Hey! I'm Dora. Ready when you are. 😊";
  }
  return "I'm having trouble thinking right now. Try again in a moment.";
}

function normalizeReply(reply: string, originalText: string): string {
  const trimmed = reply.trim();
  if (!trimmed || trimmed === originalText.trim()) return offlineReply(originalText);
  return trimmed;
}

export async function generateTestBotReply(input: string, history: TestBotHistoryMessage[]): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const recentHistory = history
    .filter((message) => message.plaintext.trim().length > 0)
    .slice(-MAX_HISTORY_MESSAGES)
    .map((message) => ({
      role: message.direction === "outgoing" ? "user" : "assistant",
      content: message.plaintext,
    }));
  const promptHistory = recentHistory.filter(
    (message, index) =>
      index !== recentHistory.length - 1 || message.role !== "user" || message.content.trim() !== input.trim()
  );

  try {
    const response = await fetch(`${OLLAMA_URL.replace(/\/$/, "")}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        messages: [
          {
            role: "system",
            content:
              "You are Dora inside a chat app. Reply naturally, briefly, and helpfully. Do not simply repeat the user message.",
          },
          ...promptHistory,
          { role: "user", content: input },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) return offlineReply(input);

    const data = (await response.json()) as OllamaChatResponse;
    const reply =
      typeof data.message?.content === "string"
        ? data.message.content
        : typeof data.response === "string"
          ? data.response
          : "";
    return normalizeReply(reply, input);
  } catch (err) {
    console.warn("[test-bot] AI reply failed", err);
    return offlineReply(input);
  } finally {
    clearTimeout(timeout);
  }
}
