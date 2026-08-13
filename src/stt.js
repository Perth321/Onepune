const DEEPGRAM_URL = "https://api.deepgram.com/v1/listen";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_TIMEOUT_MS = 30_000;
const GEMINI_TRANSCRIPTION_PROMPT = [
  "Transcribe the provided WAV audio exactly as spoken.",
  "Return only the transcript in the original spoken language.",
  "Do not translate, explain, summarize, identify speakers, add timestamps, or use Markdown.",
  "If there is no intelligible speech, return an empty response.",
].join(" ");

function providerError(provider, message, status, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.provider = provider;
  if (status !== undefined) error.status = status;
  return error;
}

async function withTimeout(provider, timeoutMs, request) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await request(controller.signal);
  } catch (error) {
    if (error?.name === "AbortError") {
      throw providerError(provider, `${provider} transcription timed out`, 408, error);
    }
    if (!error?.provider) error.provider = provider;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(response, provider) {
  try {
    return await response.json();
  } catch (error) {
    throw providerError(provider, `${provider} returned invalid JSON`, response.status, error);
  }
}

function geminiTranscript(body) {
  const candidates = Array.isArray(body?.candidates) ? body.candidates : [];
  for (const candidate of candidates) {
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    const text = parts
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("")
      .trim();
    if (text) return text;
  }
  return "";
}

export function createVoiceTranscriber({
  apiKey = process.env.DEEPGRAM_API_KEY,
  deepgramApiKey = apiKey,
  model = process.env.DEEPGRAM_MODEL || "nova-3",
  language = process.env.DEEPGRAM_LANGUAGE || "th",
  geminiApiKey = process.env.GEMINI_API_KEY,
  geminiModel = process.env.GEMINI_STT_MODEL || "gemini-2.5-flash",
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  async function transcribeDeepgram(wavBuffer) {
    return withTimeout("Deepgram", timeoutMs, async (signal) => {
      const url =
        `${DEEPGRAM_URL}?model=${encodeURIComponent(model)}` +
        `&language=${encodeURIComponent(language)}`;
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Token ${deepgramApiKey}`,
          "Content-Type": "audio/wav",
        },
        body: wavBuffer,
        signal,
      });
      if (!response.ok) {
        throw providerError(
          "Deepgram",
          `Deepgram transcription failed (${response.status})`,
          response.status,
        );
      }
      const body = await readJson(response, "Deepgram");
      return String(body.results?.channels?.[0]?.alternatives?.[0]?.transcript || "").trim();
    });
  }

  async function transcribeGemini(wavBuffer) {
    return withTimeout("Gemini", timeoutMs, async (signal) => {
      const url = `${GEMINI_URL}/${encodeURIComponent(geminiModel)}:generateContent`;
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": geminiApiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                { text: GEMINI_TRANSCRIPTION_PROMPT },
                {
                  inlineData: {
                    mimeType: "audio/wav",
                    data: Buffer.from(wavBuffer).toString("base64"),
                  },
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 512,
          },
        }),
        signal,
      });
      if (!response.ok) {
        throw providerError(
          "Gemini",
          `Gemini transcription failed (${response.status})`,
          response.status,
        );
      }
      return geminiTranscript(await readJson(response, "Gemini"));
    });
  }

  async function transcribe(wavBuffer) {
    const providers = [];
    if (deepgramApiKey) providers.push(transcribeDeepgram);
    if (geminiApiKey) providers.push(transcribeGemini);
    if (!providers.length) return "";

    const errors = [];
    for (const provider of providers) {
      try {
        return await provider(wavBuffer);
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length === 1) throw errors[0];
    const error = new AggregateError(errors, "All voice transcription providers failed");
    const lastError = errors.at(-1);
    error.provider = lastError?.provider;
    error.status = lastError?.status;
    throw error;
  }

  transcribe.available = Boolean(deepgramApiKey || geminiApiKey);
  transcribe.engine = deepgramApiKey ? "deepgram" : geminiApiKey ? "gemini" : "none";
  transcribe.engines = [deepgramApiKey && "deepgram", geminiApiKey && "gemini"].filter(Boolean);
  transcribe.model = model;
  transcribe.language = language;
  transcribe.geminiModel = geminiModel;
  return transcribe;
}
