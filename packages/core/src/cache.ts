import type { SiteConfig, TollBackend } from "./types.js";

interface CacheEntry {
  config: SiteConfig;
  fetchedAt: number;
  ttlMs: number;
}

/**
 * In-memory config cache with stale-while-revalidate semantics.
 * Serves stale config while refreshing in the background.
 */
export class ConfigCache {
  private cache = new Map<string, CacheEntry>();
  private readonly backend: TollBackend;
  private readonly defaultTtlMs: number;
  private inflight = new Map<string, Promise<SiteConfig>>();

  constructor(backend: TollBackend, defaultTtlMs: number) {
    this.backend = backend;
    this.defaultTtlMs = defaultTtlMs;
  }

  async get(siteId: string): Promise<SiteConfig> {
    const entry = this.cache.get(siteId);
    const now = Date.now();

    if (entry) {
      const age = now - entry.fetchedAt;
      if (age < entry.ttlMs) {
        // Fresh — return immediately
        return entry.config;
      }
      // Stale — serve stale, refresh in background
      this.refreshInBackground(siteId);
      return entry.config;
    }

    // No cache — must fetch synchronously
    return this.fetchAndCache(siteId);
  }

  private refreshInBackground(siteId: string): void {
    if (this.inflight.has(siteId)) return; // already refreshing
    this.fetchAndCache(siteId).catch(() => {
      // Errors in background refresh are swallowed — stale config keeps serving
    });
  }

  private async fetchAndCache(siteId: string): Promise<SiteConfig> {
    if (this.inflight.has(siteId)) {
      return this.inflight.get(siteId)!;
    }

    const promise = this.backend.getConfig(siteId).then((config) => {
      this.cache.set(siteId, {
        config,
        fetchedAt: Date.now(),
        ttlMs: config.cacheTtlMs ?? this.defaultTtlMs,
      });
      this.inflight.delete(siteId);
      return config;
    });

    this.inflight.set(siteId, promise);
    return promise;
  }
}
