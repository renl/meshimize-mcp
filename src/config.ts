import { z } from "zod";

const ConfigSchema = z.object({
  apiKey: z
    .string({
      required_error: "MESHIMIZE_API_KEY is required",
      invalid_type_error: "MESHIMIZE_API_KEY must be a string",
    })
    .min(1, "MESHIMIZE_API_KEY is required"),
  baseUrl: z
    .string()
    .url()
    .default("https://api.meshimize.com")
    .refine(
      (val) => {
        try {
          const url = new URL(val);
          const isOriginOnly =
            (url.pathname === "/" || url.pathname === "") && !url.search && !url.hash;
          const isHttpScheme = url.protocol === "http:" || url.protocol === "https:";
          return isOriginOnly && isHttpScheme;
        } catch {
          return false;
        }
      },
      {
        message: "MESHIMIZE_BASE_URL must be an origin-only HTTP(S) URL (no path, query, or hash)",
      },
    ),
  wsUrl: z
    .string()
    .url()
    .optional()
    .refine(
      (val) => {
        if (!val) return true;
        try {
          const url = new URL(val);
          return url.protocol === "ws:" || url.protocol === "wss:";
        } catch {
          return false;
        }
      },
      {
        message: "MESHIMIZE_WS_URL must use ws:// or wss:// scheme",
      },
    ),
  bufferSize: z.coerce.number().int().positive().default(1000),
  heartbeatIntervalMs: z.coerce.number().int().positive().default(30000),
  reconnectIntervalMs: z.coerce.number().int().positive().default(5000),
  maxReconnectAttempts: z.coerce.number().int().nonnegative().default(10),
  joinTimeoutMs: z.coerce.number().int().positive().default(600000),
  maxPendingJoins: z.coerce.number().int().positive().default(50),
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
    joinTimeoutMs: process.env.MESHIMIZE_JOIN_TIMEOUT_MS,
    maxPendingJoins: process.env.MESHIMIZE_MAX_PENDING_JOINS,
  };

  const config = ConfigSchema.parse(raw);

  // Derive wsUrl from baseUrl if not explicitly provided
  if (!config.wsUrl) {
    const url = new URL(config.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/api/v1/ws/websocket";
    config.wsUrl = url.toString();
  }

  return config;
}
