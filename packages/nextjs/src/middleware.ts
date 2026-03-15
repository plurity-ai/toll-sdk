import type { NextRequest, NextFetchEvent } from "next/server";
import { NextResponse } from "next/server";
import { Toll } from "@plurity/toll";
import type { TollConfig, IncomingRequest } from "@plurity/toll";

export type TollMiddlewareConfig = Omit<TollConfig, "siteId"> & {
  siteId: string;
  llmsTxtPath?: string;
  /**
   * Additional paths (string exact match or RegExp) where ALL visitors are
   * tracked regardless of UA — not just known bots.
   * The llmsTxtPath and any CMS answer pages are always tracked for all visitors
   * by default.
   */
  trackAllPaths?: (string | RegExp)[];
};

/**
 * Creates a Next.js middleware function that:
 * 1. Serves /llms.txt and CMS answer pages from cached Q&A config
 * 2. Tracks ALL visitors on llms paths (bots labeled by name, humans as "visitor")
 * 3. Tracks only known agents (bots) on all other paths
 */
export function createTollMiddleware(config: TollMiddlewareConfig) {
  const toll = new Toll(config);
  const llmsTxtPath = config.llmsTxtPath ?? "/llms.txt";
  const extraTrackAllPaths = config.trackAllPaths ?? [];

  return async function tollMiddleware(
    request: NextRequest,
    event?: NextFetchEvent
  ): Promise<NextResponse | null> {
    const { pathname } = request.nextUrl;

    const incomingRequest: IncomingRequest = {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries((request.headers as unknown as Map<string, string>).entries()),
      ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined,
    };

    // ── llms.txt — serve + track all visitors ────────────────────────────────
    if (pathname === llmsTxtPath) {
      trackAndFlush(toll.trackAny(incomingRequest), toll, event);
      try {
        const result = await toll.getLlmsTxt();
        return new NextResponse(result.content, {
          status: 200,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
          },
        });
      } catch {
        return new NextResponse("# llms.txt temporarily unavailable\n", {
          status: 503,
          headers: { "Content-Type": "text/plain" },
        });
      }
    }

    // ── CMS answer pages — serve + track all visitors ─────────────────────────
    try {
      const answer = await toll.serveAnswerPage(pathname);
      if (answer) {
        trackAndFlush(toll.trackAny(incomingRequest), toll, event);
        return new NextResponse(answer.content, {
          status: 200,
          headers: {
            "Content-Type": "text/markdown; charset=utf-8",
            "Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
          },
        });
      }
    } catch {
      // non-fatal — fall through
    }

    // ── Extra trackAllPaths — track all visitors ───────────────────────────────
    const isExtraTrackAll = extraTrackAllPaths.some(p =>
      typeof p === "string" ? pathname === p : p.test(pathname)
    );
    if (isExtraTrackAll) {
      trackAndFlush(toll.trackAny(incomingRequest), toll, event);
      return null;
    }

    // ── All other paths — track all visitors (raw UA stored, evaluate later) ──
    trackAndFlush(toll.trackAny(incomingRequest), toll, event);

    return null;
  };
}

function trackAndFlush(
  result: { isAgent: boolean },
  toll: Toll,
  event?: NextFetchEvent
): void {
  if (!result.isAgent) return;
  const flushPromise = toll.flush();
  if (event && typeof event.waitUntil === "function") {
    event.waitUntil(flushPromise);
  }
}
