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
 * 1. Redirects LLM provider crawlers with 307 when forceRedirect is configured
 * 2. Serves /llms.txt and CMS answer pages from cached Q&A config
 * 3. Tracks ALL visitors on llms paths (bots labeled by name, humans as "visitor")
 * 4. Tracks known agents (bots) on all other paths
 */
export function createTollMiddleware(config: TollMiddlewareConfig) {
  const toll = new Toll(config);
  const llmsTxtPath = config.llmsTxtPath ?? "/llms.txt";
  // Derive the CMS base path from llmsTxtPath: "/llms.txt" → "/llms"
  const llmsBase = llmsTxtPath.slice(0, llmsTxtPath.lastIndexOf(".")) || llmsTxtPath;

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

    // Detect once and reuse across all branches to avoid double-tracking.
    const tracked = toll.trackAny(incomingRequest);

    // ── LLM agent redirect — before serving anything else ────────────────────
    // Skip if already on the redirect target to avoid infinite redirect loops.
    if (config.forceRedirect && tracked.isLlmAgent) {
      const redirectUrl = new URL(config.forceRedirect, request.url);
      const alreadyOnLlmsPath = pathname === redirectUrl.pathname || pathname.startsWith(llmsBase + "/");
      if (!alreadyOnLlmsPath) {
        if (event && typeof event.waitUntil === "function") {
          event.waitUntil(toll.flush());
        }
        return NextResponse.redirect(redirectUrl, { status: 307 });
      }
    }

    // ── llms.txt — serve + flush ──────────────────────────────────────────────
    if (pathname === llmsTxtPath) {
      flushIfAgent(tracked, toll, event);
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

    // ── CMS answer pages — serve + flush ──────────────────────────────────────
    try {
      const answer = await toll.serveAnswerPage(pathname);
      if (answer) {
        flushIfAgent(tracked, toll, event);
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

    // ── All other paths — flush if agent ──────────────────────────────────────
    flushIfAgent(tracked, toll, event);

    return null;
  };
}

function flushIfAgent(
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
