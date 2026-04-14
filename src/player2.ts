/**
 * P2 Claw — Player2 API client.
 *
 * Wraps the OpenAI SDK to point at the local Player2 App
 * running at http://127.0.0.1:4315. Provides helpers for
 * health checks, joule balance, profile listing, and a
 * periodic health ping (recommended by Player2 every 60s).
 */

import OpenAI from "openai";

const PLAYER2_BASE = "http://127.0.0.1:4315/v1";
const HEALTH_PING_INTERVAL_MS = 60_000; // 60 seconds

let _client: OpenAI | null = null;
let _resolvedKey: string = "";
let _healthInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Initialises the Player2 client. Must be called once at boot.
 */
export function initPlayer2(apiKey: string): void {
  _resolvedKey = apiKey;
  _client = createClient(PLAYER2_BASE);
}

/**
 * Creates an OpenAI-compatible client for a given base URL.
 */
function createClient(baseURL: string): OpenAI {
  return new OpenAI({
    baseURL,
    apiKey: "p2claw", // Required by SDK but unused by Player2
    defaultHeaders: {
      "player2-game-key": _resolvedKey,
    },
  });
}

/**
 * Returns the default client. Throws if not yet initialised.
 */
export function getClient(): OpenAI {
  if (!_client) {
    throw new Error("Player2 client not initialised. Call initPlayer2() first.");
  }
  return _client;
}

/**
 * Returns a client configured for a specific Player2 AI profile.
 * Profile base URLs follow the pattern:
 *   http://127.0.0.1:4315/<profile-name>/v1
 */
export function getProfileClient(profileName: string): OpenAI {
  const baseURL = `http://127.0.0.1:4315/${profileName}/v1`;
  return createClient(baseURL);
}

// ── Direct API helpers (not covered by OpenAI SDK) ──────────────

interface HealthResponse {
  client_version: string;
}

interface JoulesResponse {
  joules: number;
  patron_tier: string;
  user_id: string;
}

export interface AiProfile {
  id: string;
  name: string;
  base_url: string;
}

/**
 * Checks if the Player2 App is running and healthy.
 */
export async function checkHealth(): Promise<HealthResponse> {
  const res = await fetch(`${PLAYER2_BASE}/health`, {
    headers: { "player2-game-key": _resolvedKey },
  });
  if (!res.ok) {
    throw new Error(`Player2 health check failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as HealthResponse;
}

/**
 * Returns the user's joule balance and patron tier.
 */
export async function getJoules(): Promise<JoulesResponse> {
  const res = await fetch(`${PLAYER2_BASE}/joules`, {
    headers: { "player2-game-key": _resolvedKey },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch joules: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as JoulesResponse;
}

/**
 * Lists all AI config profiles (Patron feature).
 */
export async function listProfiles(): Promise<AiProfile[]> {
  const res = await fetch(`http://127.0.0.1:4315/v1/ai_profiles`, {
    headers: { "player2-game-key": _resolvedKey },
  });
  if (!res.ok) {
    throw new Error(`Failed to list profiles: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as AiProfile[];
}

/**
 * Runs a simple chat completion smoke test to verify the LLM pipeline works.
 * Asks the model to respond with a single word.
 */
export async function smokeTestCompletion(): Promise<string> {
  const client = getClient();
  const response = await client.chat.completions.create({
    model: "gpt-4o-mini", // Player2 ignores this and routes to user's selected model
    messages: [
      {
        role: "system",
        content: "Respond with exactly one word: 'operational'. Nothing else.",
      },
      {
        role: "user",
        content: "Status check.",
      },
    ],
    max_tokens: 10,
  });

  const content = response.choices[0]?.message?.content ?? "";
  return content.trim();
}

/**
 * Starts the periodic health ping (every 60s).
 * Player2 uses these pings to calculate time-spent for revenue share.
 */
export function startHealthPing(): void {
  if (_healthInterval) return; // Already running

  _healthInterval = setInterval(async () => {
    try {
      await checkHealth();
      // Silent success — this is a background heartbeat
    } catch (err) {
      console.warn("⚠️  Health ping failed — Player2 App may be offline");
    }
  }, HEALTH_PING_INTERVAL_MS);

  // Don't let the interval prevent Node from exiting
  _healthInterval.unref();

  console.log(`   ✓ Health ping started (every ${HEALTH_PING_INTERVAL_MS / 1000}s)`);
}

/**
 * Stops the periodic health ping.
 */
export function stopHealthPing(): void {
  if (_healthInterval) {
    clearInterval(_healthInterval);
    _healthInterval = null;
  }
}

// ── Speech-to-Text via Whisper ──────────────────────────────────

interface WhisperTranscriptionResponse {
  text: string;
}

/**
 * Transcribes audio using Player2's Whisper-compatible STT endpoint.
 *
 * Accepts an in-memory Buffer (typically .ogg from Telegram voice messages)
 * and returns the transcribed text. No disk I/O — the buffer is wrapped in
 * a Blob and sent as multipart/form-data.
 *
 * @param audioBuffer - Raw audio data (Opus/OGG, MP3, WAV, etc.)
 * @param filename - Filename hint for the Whisper endpoint (e.g. "voice.ogg")
 * @returns The transcribed text
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  filename: string
): Promise<string> {
  const formData = new FormData();
  // Uint8Array wrapper satisfies BlobPart in strict TS (Buffer's
  // ArrayBufferLike includes SharedArrayBuffer which Blob rejects)
  const blob = new Blob([new Uint8Array(audioBuffer)]);
  formData.append("file", blob, filename);
  formData.append("model", "whisper-1"); // Player2 routes to user's selected STT model

  const res = await fetch(`${PLAYER2_BASE}/stt/whisper/audio/transcriptions`, {
    method: "POST",
    headers: { "player2-game-key": _resolvedKey },
    body: formData,
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    throw new Error(
      `STT transcription failed: ${res.status} ${res.statusText}${errorText ? ` — ${errorText}` : ""}`
    );
  }

  const data = (await res.json()) as WhisperTranscriptionResponse;
  return data.text?.trim() ?? "";
}
