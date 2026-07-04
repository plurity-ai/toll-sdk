import type { TollBackend, TrackingEvent, SiteConfig, AgentQuestion } from "./types.js";

// ── PlurityBackend ────────────────────────────────────────────────────────────

export interface PlurityBackendOptions {
  siteKey: string;
  serverUrl?: string;
}

/**
 * Default backend — talks to toll.plurity.ai (or a self-hosted instance).
 * The siteKey (stk_...) is used for authentication.
 */
export class PlurityBackend implements TollBackend {
  private readonly serverUrl: string;
  private readonly siteKey: string;

  constructor(options: PlurityBackendOptions) {
    this.siteKey = options.siteKey;
    this.serverUrl = options.serverUrl ?? "https://toll.plurity.ai";
  }

  async sendEvents(siteId: string, events: TrackingEvent[]): Promise<void> {
    const url = `${this.serverUrl}/api/public/${siteId}/events`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Site-Key": this.siteKey,
      },
      body: JSON.stringify(events),
    });

    if (!response.ok) {
      throw new Error(`Failed to send events: ${response.status} ${response.statusText}`);
    }
  }

  async getConfig(siteId: string): Promise<SiteConfig> {
    const url = `${this.serverUrl}/api/public/${siteId}/config`;
    const response = await fetch(url, {
      headers: { "X-Site-Key": this.siteKey },
    });

    if (!response.ok) {
      throw new Error(`Failed to get config: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<SiteConfig>;
  }

  async submitQuestion(siteId: string, question: AgentQuestion): Promise<void> {
    const url = `${this.serverUrl}/api/public/${siteId}/questions`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Site-Key": this.siteKey,
      },
      body: JSON.stringify(question),
    });

    if (!response.ok) {
      throw new Error(`Failed to submit question: ${response.status} ${response.statusText}`);
    }
  }

  async getAnswerContent(siteId: string, slug: string): Promise<string | null> {
    const url = `${this.serverUrl}/api/public/${siteId}/answers/${slug}`;
    const response = await fetch(url, {
      headers: { "X-Site-Key": this.siteKey },
    });

    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`Failed to get answer content: ${response.status} ${response.statusText}`);
    }

    return response.text();
  }

  /**
   * Proxy the full llms.txt from the toll server.
   * The server creates a session and embeds encoded tracking links.
   * The User-Agent is forwarded so the server can identify the agent.
   */
  /**
   * Proxy the full llms.txt from the toll server.
   * siteOrigin — the scheme+host of the site embedding the SDK (e.g. "https://plurity.ai"
   * or "http://localhost:3001"). The toll server uses this as the base URL for encoded
   * short links so they resolve on the customer's middleware, not toll.plurity.ai.
   */
  async getLlmsTxt(siteId: string, userAgent?: string, siteOrigin?: string): Promise<{ content: string; sessionKey?: string }> {
    const url = `${this.serverUrl}/api/public/${siteId}/llms.txt`;
    const headers: Record<string, string> = { "X-Site-Key": this.siteKey };
    if (userAgent) headers["User-Agent"] = userAgent;
    if (siteOrigin) headers["X-Site-Origin"] = siteOrigin;
    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`Failed to get llms.txt: ${response.status} ${response.statusText}`);
    }
    const content = await response.text();
    const sessionKey = response.headers.get("x-plurity-session-key") ?? undefined;
    return { content, sessionKey };
  }

  /**
   * Resolve a /r/{encoded} short link via the toll server.
   * siteOrigin — the scheme+host of the customer's site. If the target URL's domain
   * matches the site's registered domain, the server rewrites it to siteOrigin so
   * local dev redirects stay on localhost instead of going to the production URL.
   */
  async convertSession(sessionKey: string, cookieId?: string): Promise<{ visitorCookieId: string | null }> {
    const url = `${this.serverUrl}/api/public/session-convert`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionKey, cookieId }),
    });
    if (!response.ok) {
      throw new Error(`Failed to convert session: ${response.status}`);
    }
    return response.json() as Promise<{ visitorCookieId: string | null }>;
  }

  async resolveRedirect(encoded: string, cookieId?: string, siteOrigin?: string): Promise<{ targetUrl: string; visitorCookieId: string | null }> {
    const url = `${this.serverUrl}/api/public/redirect-info`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ encoded, cookieId, siteOrigin }),
    });
    if (!response.ok) {
      throw new Error(`Failed to resolve redirect: ${response.status}`);
    }
    return response.json() as Promise<{ targetUrl: string; visitorCookieId: string | null }>;
  }
}

// ── LocalBackend ──────────────────────────────────────────────────────────────

export interface LocalBackendOptions {
  config: Omit<SiteConfig, "siteId" | "cacheTtlMs"> & {
    cacheTtlMs?: number;
  };
  eventSink?: (events: TrackingEvent[]) => void;
}

/**
 * Fully local backend — no network calls.
 * For air-gapped, regulated, or self-managed environments.
 */
export class LocalBackend implements TollBackend {
  private readonly localConfig: LocalBackendOptions["config"];
  private readonly eventSink?: (events: TrackingEvent[]) => void;

  constructor(options: LocalBackendOptions) {
    this.localConfig = options.config;
    this.eventSink = options.eventSink;
  }

  async sendEvents(_siteId: string, events: TrackingEvent[]): Promise<void> {
    if (this.eventSink) {
      this.eventSink(events);
    }
    // No-op if no eventSink provided
  }

  async getConfig(siteId: string): Promise<SiteConfig> {
    return {
      siteId,
      cacheTtlMs: this.localConfig.cacheTtlMs ?? 300_000,
      ...this.localConfig,
    };
  }

  async submitQuestion(_siteId: string, _question: AgentQuestion): Promise<void> {
    // No-op for local backend — questions are not tracked locally
  }

  async getAnswerContent(_siteId: string, _slug: string): Promise<string | null> {
    // No-op for local backend
    return null;
  }
}
