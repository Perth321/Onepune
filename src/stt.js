const DEEPGRAM_URL = "https://api.deepgram.com/v1/listen";

export function createVoiceTranscriber({
  apiKey = process.env.DEEPGRAM_API_KEY,
  model = process.env.DEEPGRAM_MODEL || "nova-3",
  language = process.env.DEEPGRAM_LANGUAGE || "th",
  fetchImpl = fetch,
} = {}) {
  async function transcribe(wavBuffer) {
    if (!apiKey) {
      return "";
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const url =
        `${DEEPGRAM_URL}?model=${encodeURIComponent(model)}` +
        `&language=${encodeURIComponent(language)}`;
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Token ${apiKey}`,
          "Content-Type": "audio/wav",
        },
        body: wavBuffer,
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = new Error(`Deepgram transcription failed (${response.status})`);
        error.status = response.status;
        throw error;
      }
      const body = await response.json();
      return String(body.results?.channels?.[0]?.alternatives?.[0]?.transcript || "").trim();
    } finally {
      clearTimeout(timer);
    }
  }

  transcribe.available = Boolean(apiKey);
  transcribe.engine = "deepgram";
  transcribe.model = model;
  transcribe.language = language;
  return transcribe;
}
