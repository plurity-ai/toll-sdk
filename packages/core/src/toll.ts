import type {
  TollConfig,
  TollBackend,
  IncomingRequest,
  TrackResult,
  LlmsTxtResult,
  SiteConfig,
} from "./types.js";
import { AgentDetector } from "./detector.js";
import { ConfigCache } from "./cache.js";
import { EventBatcher } from "./batcher.js";
import { generateLlmsTxt } from "./llms-txt.js";
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

  /**
   * Track only if the request is from a known agent (bots/crawlers).
   * Use this for regular pages where you only want agent traffic.
   */
  track(request: IncomingRequest): TrackResult {
    const detection = this.detector.detect(request);
    if (!detection.isAgent || !detection.agentName) {
      return { isAgent: false, agentName: null, eventId: null };
    }
    return this.buffer(request, detection.agentName);
  }

  /**
   * Track all visitors regardless of UA — use this for llms.txt and Q&A pages
   * where you want to see every request (agents labeled by name, humans as "visitor").
   */
  trackAny(request: IncomingRequest): TrackResult {
    const agentName = this.detector.detectAny(request);
    return this.buffer(request, agentName);
  }

  private buffer(request: IncomingRequest, agentName: string): TrackResult {
    const url = new URL(request.url, "http://localhost");
    const eventId = crypto.randomUUID();

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
    });

    return { isAgent: true, agentName, eventId };
  }

  /**
   * Get the current llms.txt content (cached, non-blocking after first load).
   */
  async getLlmsTxt(): Promise<LlmsTxtResult> {
    const config = await this.cache.get(this.config.siteId);
    const content = generateLlmsTxt(config);
    return { content, contentType: "text/plain", cacheHit: true };
  }

  /**
   * Serve a CMS answer page by pathname.
   * Returns the markdown content if the path matches a published Q&A slug, null otherwise.
   */
  async serveAnswerPage(pathname: string): Promise<{ content: string; contentType: "text/markdown" } | null> {
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

    // Find the question text from cached config to prepend as H1
    const pair = siteConfig.qaPairs.find(qa => {
      const url = qa.answerUrl ?? "";
      return url.endsWith(`/${slug}`);
    });
    const headed = pair?.question
      ? `# ${pair.question}\n\n${content}`
      : content;

    return { content: headed, contentType: "text/markdown" };
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
