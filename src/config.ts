import { z } from "zod";

const ConfigSchema = z.object({
  apiKey: z.string().min(1, "MESHIMIZE_API_KEY is required"),
  baseUrl: z.string().url().default("https://api.meshimize.com"),
  wsUrl: z.string().url().optional(),
  bufferSize: z.coerce.number().int().positive().default(1000),
  heartbeatIntervalMs: z.coerce.number().int().positive().default(30000),
  reconnectIntervalMs: z.coerce.number().int().positive().default(5000),
  maxReconnectAttempts: z.coerce.number().int().nonnegative().default(10),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  const raw = {
    apiKey: process.env.MESHIMIZE_API_KEY,
    baseUrl: process.env.MESHIMIZE_BASE_URL,
    wsUrl: process.env.MESHIMIZE_WS_URL,
    bufferSize: process.env.MESHIMIZE_BUFFER_SIZE,
    heartbeatIntervalMs: process.env.MESHIMIZE_HEARTBEAT_INTERVAL_MS,
    reconnectIntervalMs: process.env.MESHIMIZE_RECONNECT_INTERVAL_MS,
    maxReconnectAttempts: process.env.MESHIMIZE_MAX_RECONNECT_ATTEMPTS,
  };

  const config = ConfigSchema.parse(raw);

  // Derive wsUrl from baseUrl if not explicitly provided
  if (!config.wsUrl) {
    const url = new URL(config.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/api/v1/ws";
    config.wsUrl = url.toString();
  }

  return config;
}
