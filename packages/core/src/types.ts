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

export interface TrackResult {
  isAgent: boolean;
  agentName: string | null;
  eventId: string | null;
}

export interface LlmsTxtResult {
  content: string;
  contentType: "text/plain";
  cacheHit: boolean;
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
}
