// ── Core types ────────────────────────────────────────────────────────────────

export interface TrackingEvent {
  siteId: string;
  visitorIp?: string;
  userAgent: string;
  agentName: string;
  pageUrl: string;
  pagePath: string;
  httpMethod: string;
  statusCode?: number;
  referer?: string;
  qaPairId?: string;
  occurredAt: string; // ISO 8601
  customFields?: Record<string, unknown>;
  // Session + UTM attribution (populated by middleware)
  sessionKey?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmTerm?: string;
}

export interface QAPair {
  id: string;
  question: string;
  answerUrl: string;
  answerSummary?: string;
  sortOrder: number;
  isPublished: boolean;
}

export interface SiteConfig {
  siteId: string;
  siteName: string;
  domain: string;
  qaPairs: QAPair[];
  cacheTtlMs: number;
  agentRules?: AgentRule[];
  cmsMode?: boolean;
  llmsBasePath?: string;
}

export interface AgentQuestion {
  questionText: string;
  agentName: string;
  visitorIp?: string;
  pageUrl?: string;
}

export interface AgentRule {
  type: "ua_pattern" | "header_exists" | "header_value";
  pattern?: string;
  header?: string;
  value?: string;
}

export interface IncomingRequest {
  url: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
}

/** Extra attribution context passed into track/trackAny, populated by middleware. */
export interface TrackingExtra {
  sessionKey?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmTerm?: string;
}

export interface TrackResult {
  isAgent: boolean;
  agentName: string | null;
  eventId: string | null;
  isLlmAgent: boolean;
}

export interface LlmsTxtResult {
  content: string;
  contentType: "text/plain";
  cacheHit: boolean;
  /** Session key created by the toll server for this fetch — use when tracking the event. */
  sessionKey?: string;
}

export interface HeaderRule {
  header: string;
  exists?: boolean;
  value?: string;
}

// ── Config ────────────────────────────────────────────────────────────────────

export interface TollConfig {
  siteId: string;

  // Simple setup — just provide siteKey and PlurityBackend is created automatically.
  // For self-hosted instances also set serverUrl.
  siteKey?: string;
  serverUrl?: string;

  // Advanced — explicit backend (overrides siteKey/serverUrl).
  // Use LocalBackend for air-gapped environments or custom event sinks.
  backend?: TollBackend;

  // Agent detection
  agentPatterns?: RegExp[];    // additional UA patterns to treat as agents (beyond built-in list)
  excludePatterns?: RegExp[];  // UA patterns to exclude from tracking (even if in built-in list)
  headerRules?: HeaderRule[];

  // Batching
  flushIntervalMs?: number;
  maxBatchSize?: number;
  maxBufferSize?: number;

  // Caching
  cacheTtlMs?: number;

  // Disable event tracking entirely — llms.txt and CMS answer pages still work.
  // Useful when you only want the hosted Q&A/llms.txt features without collecting traffic data.
  tracking?: boolean;

  // When set, LLM provider crawlers (GPTBot, ClaudeBot, PerplexityBot, etc.) receive a
  // 307 Temporary Redirect to this URL. Search-engine indexers (Googlebot, Bingbot, …)
  // and social/SEO bots are never redirected. Tracking still fires before the redirect.
  forceRedirect?: string;

  // Callbacks
  onError?: (error: Error) => void;
  onFlush?: (count: number) => void;
}

// ── Backend interface ─────────────────────────────────────────────────────────

export interface TollBackend {
  sendEvents(siteId: string, events: TrackingEvent[]): Promise<void>;
  getConfig(siteId: string): Promise<SiteConfig>;
  submitQuestion(siteId: string, question: AgentQuestion): Promise<void>;
  getAnswerContent(siteId: string, slug: string): Promise<string | null>;
  /** Optional: proxy the full llms.txt from the server (creates session, encodes links). */
  getLlmsTxt?(siteId: string, userAgent?: string, siteOrigin?: string): Promise<{ content: string; sessionKey?: string }>;
  /** Optional: call the server's redirect-info API (used by middleware for /r/ paths). */
  resolveRedirect?(encoded: string, cookieId?: string, siteOrigin?: string): Promise<{ targetUrl: string; visitorCookieId: string | null }>;
  /** Optional: mark a session as converted when a human lands with ?_s= outside of /r/ flow. */
  convertSession?(sessionKey: string, cookieId?: string): Promise<{ visitorCookieId: string | null }>;
}
