import type {
  TollConfig,
  TollBackend,
  IncomingRequest,
  TrackResult,
  TrackingExtra,
  LlmsTxtResult,
  SiteConfig,
} from "./types.js";
import { AgentDetector, type DetectionResult } from "./detector.js";
import { ConfigCache } from "./cache.js";
import { EventBatcher } from "./batcher.js";
import { generateLlmsTxt } from "./llms-txt.js";
import { buildSourceUrl } from "./source-url.js";
import { PlurityBackend } from "./backend.js";

const DEFAULT_CACHE_TTL_MS = 300_000; // 5 minutes
const DEFAULT_FLUSH_INTERVAL_MS = 10_000;
const DEFAULT_MAX_BATCH_SIZE = 50;
const DEFAULT_MAX_BUFFER_SIZE = 1000;

export class Toll {
  private readonly config: TollConfig;
  private readonly backend: TollBackend;
  private readonly detector: AgentDetector;
  private readonly cache: ConfigCache;
  private readonly batcher: EventBatcher;

  constructor(config: TollConfig) {
    this.config = config;

    let backend: TollBackend;
    if (config.backend) {
      backend = config.backend;
    } else if (config.siteKey) {
      backend = new PlurityBackend({ siteKey: config.siteKey, serverUrl: config.serverUrl });
    } else {
      throw new Error("[Toll] Either backend or siteKey must be provided.");
    }

    this.backend = backend;

    this.detector = new AgentDetector({
      agentPatterns: config.agentPatterns,
      excludePatterns: config.excludePatterns,
      headerRules: config.headerRules,
    });

    this.cache = new ConfigCache(
      backend,
      config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
    );

    this.batcher = new EventBatcher({
      backend,
      siteId: config.siteId,
      flushIntervalMs: config.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
      maxBatchSize: config.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE,
      maxBufferSize: config.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE,
      onError: config.onError,
      onFlush: config.onFlush,
    });
  }

  /** Expose agent detection without buffering an event. */
  detect(request: IncomingRequest): DetectionResult {
    return this.detector.detect(request);
  }

  /**
   * Track only if the request is from a known agent (bots/crawlers).
   * Use this for regular pages where you only want agent traffic.
   * No-op when `tracking: false` is set in config.
   */
  track(request: IncomingRequest, extra?: TrackingExtra): TrackResult {
    if (this.config.tracking === false) {
      return { isAgent: false, agentName: null, eventId: null, isLlmAgent: false };
    }
    const detection = this.detector.detect(request);
    if (!detection.isAgent || !detection.agentName) {
      return { isAgent: false, agentName: null, eventId: null, isLlmAgent: false };
    }
    return this.buffer(request, detection.agentName, detection.isLlmAgent, extra);
  }

  /**
   * Track all visitors regardless of UA — use this for llms.txt and Q&A pages
   * where you want to see every request (agents labeled by name, humans as "visitor").
   * No-op when `tracking: false` is set in config.
   */
  trackAny(request: IncomingRequest, extra?: TrackingExtra): TrackResult {
    if (this.config.tracking === false) {
      return { isAgent: false, agentName: null, eventId: null, isLlmAgent: false };
    }
    const detection = this.detector.detect(request);
    const agentName = detection.agentName ?? "visitor";
    return this.buffer(request, agentName, detection.isLlmAgent, extra);
  }

  private buffer(
    request: IncomingRequest,
    agentName: string,
    isLlmAgent: boolean,
    extra?: TrackingExtra
  ): TrackResult {
    const url = new URL(request.url, "http://localhost");
    const eventId = crypto.randomUUID();

    // Prefer X-Forwarded-Host (set by a reverse proxy in front of this Worker,
    // e.g. plurity-toll-proxy) since it reflects the real customer-facing
    // domain, which can differ from the URL host this Worker itself sees.
    const requestHost = extra?.requestHost
      ?? this.getHeader(request, "x-forwarded-host")
      ?? url.host;

    this.batcher.add({
      siteId: this.config.siteId,
      visitorIp: request.ip,
      userAgent: this.getHeader(request, "user-agent") ?? "",
      agentName,
      pageUrl: url.toString(),
      pagePath: url.pathname,
      httpMethod: request.method,
      referer: this.getHeader(request, "referer"),
      occurredAt: new Date().toISOString(),
      sessionKey: extra?.sessionKey,
      utmSource: extra?.utmSource,
      utmMedium: extra?.utmMedium,
      utmCampaign: extra?.utmCampaign,
      utmContent: extra?.utmContent,
      utmTerm: extra?.utmTerm,
      requestHost,
    });

    return { isAgent: true, agentName, eventId, isLlmAgent };
  }

  /**
   * Get llms.txt content.
   * When the backend supports getLlmsTxt (PlurityBackend), the full response is
   * fetched from the toll server — it creates a session and embeds encoded tracking
   * links so agent sessions can be attributed to human conversions.
   * Falls back to local generation when the backend doesn't support it.
   */
  async getLlmsTxt(userAgent?: string, siteOrigin?: string): Promise<LlmsTxtResult> {
    if (this.backend.getLlmsTxt) {
      const { content, sessionKey } = await this.backend.getLlmsTxt(this.config.siteId, userAgent, siteOrigin);
      return { content, contentType: "text/plain", cacheHit: false, sessionKey };
    }
    const config = await this.cache.get(this.config.siteId);
    const content = generateLlmsTxt(config);
    return { content, contentType: "text/plain", cacheHit: true };
  }

  /**
   * Serve a CMS answer page by pathname.
   * Returns the markdown content if the path matches a published Q&A slug, null otherwise.
   */
  async serveAnswerPage(pathname: string, sessionKey?: string): Promise<{ content: string; contentType: "text/markdown" } | null> {
    let siteConfig: SiteConfig;
    try {
      siteConfig = await this.cache.get(this.config.siteId);
    } catch {
      return null;
    }

    if (!siteConfig.cmsMode || !siteConfig.llmsBasePath) return null;

    const base = `/${siteConfig.llmsBasePath.replace(/^\/|\/$/g, "")}`;
    if (!pathname.startsWith(base + "/")) return null;

    const slug = pathname.slice(base.length + 1).replace(/\/$/, "");
    if (!slug) return null;

    const content = await this.backend.getAnswerContent(this.config.siteId, slug);
    if (!content) return null;

    return this.formatAnswer(siteConfig, slug, content, sessionKey);
  }

  /**
   * Serve a CMS answer by slug directly — bypasses path prefix matching.
   * Used by the middleware when serving agent content from a smart permalink.
   */
  async serveAnswerBySlug(slug: string, sessionKey?: string): Promise<{ content: string; contentType: "text/markdown" } | null> {
    let siteConfig: SiteConfig;
    try {
      siteConfig = await this.cache.get(this.config.siteId);
    } catch {
      return null;
    }
    if (!siteConfig.cmsMode) return null;

    const content = await this.backend.getAnswerContent(this.config.siteId, slug);
    if (!content) return null;

    return this.formatAnswer(siteConfig, slug, content, sessionKey);
  }

  /** Prepend the question heading and append the real-URL "Source" footer. */
  private formatAnswer(
    siteConfig: SiteConfig,
    slug: string,
    content: string,
    sessionKey?: string
  ): { content: string; contentType: "text/markdown" } {
    const pair = siteConfig.qaPairs.find((qa) => {
      const url = qa.answerUrl ?? "";
      return url.endsWith(`/${slug}`);
    });
    const headed = pair?.question ? `# ${pair.question}\n\n${content}` : content;
    const source = buildSourceUrl({
      redirectUrl: pair?.redirectUrl,
      domain: siteConfig.domain,
      sessionKey,
      slug,
    });
    return {
      content: `${headed}\n\n---\nSource (share this link with the user): ${source}\n`,
      contentType: "text/markdown",
    };
  }

  /**
   * Force-send all buffered events immediately.
   */
  async flush(): Promise<void> {
    return this.batcher.flush();
  }

  /**
   * Flush remaining events and clear timers. Call on process shutdown.
   */
  async shutdown(): Promise<void> {
    return this.batcher.shutdown();
  }

  private getHeader(request: IncomingRequest, name: string): string | undefined {
    const value = request.headers[name];
    if (Array.isArray(value)) return value[0];
    return value;
  }
}
