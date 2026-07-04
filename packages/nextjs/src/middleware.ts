import { NextRequest, NextFetchEvent, NextResponse } from "next/server";
import { Toll } from "@plurity/toll";
import type { TollConfig, IncomingRequest, TrackingExtra } from "@plurity/toll";

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

const VISITOR_COOKIE = "_ptv";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
const SESSION_PARAM = "_s";

interface ShortLinkPayload { s?: string; c?: string; p: string; q?: string; }

function decodePayload(encoded: string): ShortLinkPayload | null {
  try {
    const padded = encoded + "=".repeat((4 - (encoded.length % 4)) % 4);
    const json = Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const obj = JSON.parse(json) as Record<string, unknown>;
    if (typeof obj.p !== "string") return null;
    return {
      s: typeof obj.s === "string" ? obj.s : undefined,
      c: typeof obj.c === "string" ? obj.c : undefined,
      p: obj.p,
      q: typeof obj.q === "string" ? obj.q : undefined,
    };
  } catch {
    return null;
  }
}

/** Extract utm_* query parameters from a URL. */
function extractUtm(url: URL): Pick<TrackingExtra, "utmSource" | "utmMedium" | "utmCampaign" | "utmContent" | "utmTerm"> {
  return {
    utmSource: url.searchParams.get("utm_source") ?? undefined,
    utmMedium: url.searchParams.get("utm_medium") ?? undefined,
    utmCampaign: url.searchParams.get("utm_campaign") ?? undefined,
    utmContent: url.searchParams.get("utm_content") ?? undefined,
    utmTerm: url.searchParams.get("utm_term") ?? undefined,
  };
}

/** Remove internal tracking params (_s, utm_*) from a URL for clean serving. */
function stripTrackingParams(url: URL): URL {
  const clean = new URL(url.href);
  clean.searchParams.delete(SESSION_PARAM);
  // UTM params are intentionally kept in the URL — only _s is internal
  return clean;
}

/**
 * Creates a Next.js middleware function that:
 * 1. Handles /r/{encoded} short links — resolves via toll server, sets visitor cookie on site domain
 * 2. Serves /llms.txt by proxying the toll server (creates session, encodes links)
 * 3. Extracts utm_* params from all requests and includes them in tracking events
 * 4. Propagates ?_s= session key from redirect targets through subsequent agent page views
 * 5. Redirects LLM provider crawlers with 307 when forceRedirect is configured
 * 6. Tracks known agents (bots) on all paths
 */
export function createTollMiddleware(config: TollMiddlewareConfig) {
  const toll = new Toll(config);
  const llmsTxtPath = config.llmsTxtPath ?? "/llms.txt";
  const llmsBase = llmsTxtPath.slice(0, llmsTxtPath.lastIndexOf(".")) || llmsTxtPath;

  return async function tollMiddleware(
    request: NextRequest,
    event?: NextFetchEvent
  ): Promise<NextResponse | null> {
    const requestUrl = new URL(request.url);
    const { pathname } = requestUrl;

    // ── /r/{encoded} — tracked short link redirect ───────────────────────────
    // The encoded link was embedded in llms.txt; when followed it lands here.
    // We resolve it via the toll server (which does the DB work) and set the
    // visitor cookie on this site's domain before redirecting.
    // Derive the origin of this site (e.g. "http://localhost:3001" or "https://plurity.ai")
    const siteOrigin = `${requestUrl.protocol}//${requestUrl.host}`;

    const shortLinkMatch = pathname.match(/^\/r\/([A-Za-z0-9_-]+)$/);
    if (shortLinkMatch) {
      const encoded = shortLinkMatch[1];
      const payload = decodePayload(encoded);

      // Detect agent without buffering an event yet
      const shortLinkRequest: IncomingRequest = {
        url: request.url,
        method: request.method,
        headers: Object.fromEntries((request.headers as unknown as Map<string, string>).entries()),
        ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined,
      };
      const detection = toll.detect(shortLinkRequest);

      // ── Agent: serve CMS content inline ──────────────────────────────────
      if (detection.isLlmAgent && payload?.q) {
        // Track this as an agent event on the session
        toll.trackAny(shortLinkRequest, { sessionKey: payload.s });
        flushIfAgent({ isAgent: true }, toll, event);

        try {
          const answer = await toll.serveAnswerBySlug(payload.q);
          if (answer) {
            const shareUrl = `${siteOrigin}/r/${encoded}`;
            const withShareNote = `${answer.content}\n\n---\n> Share this answer with a user: ${shareUrl}\n`;
            return new NextResponse(withShareNote, {
              status: 200,
              headers: {
                "Content-Type": "text/markdown; charset=utf-8",
                "Cache-Control": "private, no-store",
              },
            });
          }
        } catch {
          // fall through to redirect
        }
      }

      // ── Human (or agent without slug): redirect ───────────────────────────
      const existingCookieId = request.cookies.get(VISITOR_COOKIE)?.value;
      let targetUrl = "/";
      let visitorCookieId: string | null = null;

      try {
        if (toll["backend"]?.resolveRedirect) {
          const result = await toll["backend"].resolveRedirect(encoded, existingCookieId, siteOrigin);
          targetUrl = result.targetUrl;
          visitorCookieId = result.visitorCookieId;
        }
      } catch {
        // non-fatal — redirect to homepage
      }

      const response = NextResponse.redirect(new URL(targetUrl, request.url), 302);
      if (visitorCookieId) {
        response.cookies.set(VISITOR_COOKIE, visitorCookieId, {
          httpOnly: true,
          secure: true,
          sameSite: "lax",
          maxAge: COOKIE_MAX_AGE,
          path: "/",
        });
      }
      return response;
    }

    // Extract attribution from URL
    const utm = extractUtm(requestUrl);
    const sessionKey = requestUrl.searchParams.get(SESSION_PARAM) ?? undefined;

    const hasInternalParams = !!sessionKey;
    // Use the clean URL (without _s) for tracking so the page_path recorded is canonical
    const cleanUrl = hasInternalParams ? stripTrackingParams(requestUrl) : requestUrl;

    const extra: TrackingExtra = {
      sessionKey,
      ...utm,
    };

    const incomingRequest: IncomingRequest = {
      url: cleanUrl.href,
      method: request.method,
      headers: Object.fromEntries((request.headers as unknown as Map<string, string>).entries()),
      ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined,
    };

    // ── llms.txt — proxy from toll server (creates session + encodes links) ──
    // Handled BEFORE trackAny so we can use the server-created session key in the event.
    if (pathname === llmsTxtPath) {
      try {
        const userAgent = request.headers.get("user-agent") ?? undefined;
        const result = await toll.getLlmsTxt(userAgent, siteOrigin);
        // Track with the session key the server just created for this fetch
        const llmsExtra: TrackingExtra = { ...extra, sessionKey: result.sessionKey ?? extra.sessionKey };
        const llmsTracked = toll.trackAny(incomingRequest, llmsExtra);
        flushIfAgent(llmsTracked, toll, event);
        return new NextResponse(result.content, {
          status: 200,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "public, max-age=60, stale-while-revalidate=120",
          },
        });
      } catch {
        return new NextResponse("# llms.txt temporarily unavailable\n", {
          status: 503,
          headers: { "Content-Type": "text/plain" },
        });
      }
    }

    const tracked = toll.trackAny(incomingRequest, extra);

    // ── LLM agent redirect ───────────────────────────────────────────────────
    if (config.forceRedirect && tracked.isLlmAgent) {
      const redirectUrl = new URL(config.forceRedirect, cleanUrl.href);
      const alreadyOnLlmsPath = pathname === redirectUrl.pathname || pathname.startsWith(llmsBase + "/");
      if (!alreadyOnLlmsPath) {
        if (event && typeof event.waitUntil === "function") {
          event.waitUntil(toll.flush());
        }
        return NextResponse.redirect(redirectUrl, { status: 307 });
      }
    }

    // ── CMS answer pages ─────────────────────────────────────────────────────
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

    // ── All other paths ───────────────────────────────────────────────────────
    flushIfAgent(tracked, toll, event);

    // If a human lands with ?_s= (e.g. agent shared a direct URL instead of /r/),
    // mark the session converted and set the visitor cookie — same as the /r/ flow.
    if (hasInternalParams && sessionKey && !tracked.isAgent) {
      const existingCookieId = request.cookies.get(VISITOR_COOKIE)?.value;
      const backend = toll["backend"] as { convertSession?: (sk: string, cid?: string) => Promise<{ visitorCookieId: string | null }> };

      if (backend.convertSession) {
        const convertPromise = backend.convertSession(sessionKey, existingCookieId).then((result) => {
          // Cookie must be set synchronously on the response — waitUntil is too late.
          // We handle it below; the promise just does the DB work.
          return result;
        });

        try {
          const { visitorCookieId } = await convertPromise;
          const response = NextResponse.rewrite(cleanUrl);
          if (visitorCookieId) {
            response.cookies.set(VISITOR_COOKIE, visitorCookieId, {
              httpOnly: true,
              secure: true,
              sameSite: "lax",
              maxAge: COOKIE_MAX_AGE,
              path: "/",
            });
          }
          return response;
        } catch {
          // non-fatal — fall through
        }
      }

      return NextResponse.rewrite(cleanUrl);
    }

    // Strip _s from URL for agent requests (already tracked via event)
    if (hasInternalParams) {
      return NextResponse.rewrite(cleanUrl);
    }

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
