export const DEFAULT_SESSION_TITLE = "New chat";
export const LEGACY_DEFAULT_TITLES = new Set(["New session", "New chat"]);

const TITLE_SYSTEM =
  "Generate a concise chat title of 3 to 5 words summarizing the user's message. " +
  "Reply with title text only — no quotes, punctuation, or explanation.";

const PROVIDER_BASES: Record<string, string> = {
  groq: "https://api.groq.com/openai/v1",
  openai: "https://api.openai.com/v1",
};

export function normalizeTitle(
  raw: string,
  fallback: string = DEFAULT_SESSION_TITLE,
): string {
  let cleaned = raw.replace(/\s+/g, " ").trim().replace(/^["'`]+|["'`]+$/g, "");
  cleaned = cleaned.replace(/[.!?:;]+$/, "").trim();
  if (!cleaned) return fallback;
  const words = cleaned.split(" ");
  if (words.length > 8) return fallback;
  if (words.length > 5) cleaned = words.slice(0, 5).join(" ");
  if (cleaned.length > 40) {
    cleaned = cleaned.slice(0, 40).replace(/\s+\S*$/, "").trim();
  }
  return cleaned || fallback;
}

export async function generateSessionTitle(
  message: string,
  model: string,
): Promise<string> {
  const text = message.replace(/\s+/g, " ").trim();
  if (!text) return DEFAULT_SESSION_TITLE;

  const slash = model.indexOf("/");
  if (slash <= 0) return DEFAULT_SESSION_TITLE;
  const provider = model.slice(0, slash);
  const modelName = model.slice(slash + 1);
  const envPrefix = provider.toUpperCase();
  const apiKey = process.env[`${envPrefix}_API_KEY`];
  if (!apiKey) return DEFAULT_SESSION_TITLE;

  const base =
    process.env[`${envPrefix}_API_BASE`] ||
    PROVIDER_BASES[provider] ||
    PROVIDER_BASES.openai;

  try {
    const resp = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelName,
        messages: [
          { role: "system", content: TITLE_SYSTEM },
          { role: "user", content: text.slice(0, 2000) },
        ],
        max_tokens: 24,
        temperature: 0.2,
      }),
    });
    if (!resp.ok) return DEFAULT_SESSION_TITLE;
    const body = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = body.choices?.[0]?.message?.content?.trim() ?? "";
    const title = normalizeTitle(raw);
    return LEGACY_DEFAULT_TITLES.has(title) ? DEFAULT_SESSION_TITLE : title;
  } catch {
    return DEFAULT_SESSION_TITLE;
  }
}
