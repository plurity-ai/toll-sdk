import { Toll } from "@plurity/toll";
import type { IncomingRequest, TrackingExtra } from "@plurity/toll";

export interface TollWorkerConfig {
  /** Site ID from toll.plurity.ai */
  siteId: string;
  /** Site key (stk_...) — keep this secret, use via env var */
  siteKey: string;
  /** Override the toll server URL — useful for local testing. Defaults to https://toll.plurity.ai */
  serverUrl?: string;
  /**
   * Cloudflare static assets binding (env.ASSETS).
   * All non-toll paths are forwarded here.
   */
  assets: Fetcher;
  /** Path to serve as llms.txt. Defaults to "/llms.txt" */
  llmsTxtPath?: string;
  /**
   * When set, LLM provider crawlers (GPTBot, ClaudeBot, PerplexityBot, etc.) receive a
   * 307 Temporary Redirect to this URL. Search-engine indexers (Googlebot, Bingbot, …)
   * and social/SEO bots are never redirected. Tracking still fires before the redirect.
   */
  forceRedirect?: string;
  /** Called when a flush to the toll server fails — use for error logging. */
  onError?: (err: Error) => void;
  /**
   * Whether to read/set the `_ptv` visitor cookie for cross-session attribution.
   * Defaults to `true`. The cookie is set unconditionally whenever the backend
   * resolves a visitor id — there is no per-request consent check — so set this
   * to `false` unless the site has an explicit consent mechanism in front of it.
   */
  visitorCookie?: boolean;
}

const VISITOR_COOKIE = "_ptv";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
const SESSION_PARAM = "_s";
const CAMPAIGN_PARAM = "_c";

interface ShortLinkPayload {
  s?: string;
  c?: string;
  p: string;
  q?: string;
}

function decodePayload(encoded: string): ShortLinkPayload | null {
  try {
    const padded = encoded + "=".repeat((4 - (encoded.length % 4)) % 4);
    const json = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
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

function getCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, v] = part.trim().split("=");
    if (k?.trim() === name) return v?.trim();
  }
  return undefined;
}

function cookieHeader(name: string, value: string, maxAge: number, secure: boolean): string {
  const secureFlag = secure ? "; Secure" : "";
  return `${name}=${value}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}; Path=/${secureFlag}`;
}

function extractUtm(url: URL): Pick<TrackingExtra, "utmSource" | "utmMedium" | "utmCampaign" | "utmContent" | "utmTerm"> {
  return {
    utmSource: url.searchParams.get("utm_source") ?? undefined,
    utmMedium: url.searchParams.get("utm_medium") ?? undefined,
    utmCampaign: url.searchParams.get("utm_campaign") ?? undefined,
    utmContent: url.searchParams.get("utm_content") ?? undefined,
    utmTerm: url.searchParams.get("utm_term") ?? undefined,
  };
}

function toIncomingRequest(request: Request, url: URL): IncomingRequest {
  const headers: Record<string, string> = {};
  request.headers.forEach((v, k) => { headers[k] = v; });
  return {
    url: url.href,
    method: request.method,
    headers,
    ip:
      request.headers.get("cf-connecting-ip") ??
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      undefined,
  };
}

/**
 * Drop-in Cloudflare Worker handler for plurity toll.
 *
 * Call this from your Worker's `fetch` handler. It intercepts:
 *   - `/llms.txt`         → proxied from toll server with session-encoded links
 *   - `/r/{encoded}`      → legacy short link redirect; sets _ptv visitor cookie
 *   - `?_s=`/`?_c=`       → converts the session / bumps campaign click count on landing
 *   - all other paths     → forwarded to your static assets (Webflow/Framer origin)
 *
 * @example
 * ```ts
 * import { handleToll } from "@plurity/toll-cloudflare";
 *
 * export default {
 *   async fetch(request, env, ctx) {
 *     return handleToll(request, ctx, {
 *       siteId: env.SITE_ID,
 *       siteKey: env.SITE_KEY,
 *       assets: env.ASSETS,
 *       visitorCookie: false, // only enable once a real consent mechanism gates it
 *     });
 *   },
 * };
 * ```
 */
export async function handleToll(
  request: Request,
  ctx: ExecutionContext,
  config: TollWorkerConfig
): Promise<Response> {
  const toll = new Toll({
    siteId: config.siteId,
    siteKey: config.siteKey,
    serverUrl: config.serverUrl,
    onError: config.onError,
  });

  const requestUrl = new URL(request.url);
  const { pathname } = requestUrl;
  const siteOrigin = `${requestUrl.protocol}//${requestUrl.host}`;
  const isSecure = requestUrl.protocol === "https:";
  const llmsTxtPath = config.llmsTxtPath ?? "/llms.txt";
  const cookiesEnabled = config.visitorCookie !== false;

  // ── /r/{encoded} — tracked short link redirect ─────────────────────────────
  const shortLinkMatch = pathname.match(/^\/r\/([A-Za-z0-9_-]+)$/);
  if (shortLinkMatch) {
    const encoded = shortLinkMatch[1];
    const payload = decodePayload(encoded);
    const detection = toll.detect(toIncomingRequest(request, requestUrl));

    // Agent: serve CMS answer content inline instead of redirecting
    if (detection.isLlmAgent && payload?.q) {
      toll.trackAny(toIncomingRequest(request, requestUrl), { sessionKey: payload.s });
      ctx.waitUntil(toll.flush()); // always flush — Worker context terminates after response

      try {
        const answer = await toll.serveAnswerBySlug(payload.q);
        if (answer) {
          const shareUrl = `${siteOrigin}/r/${encoded}`;
          const content = `${answer.content}\n\n---\n> Share this answer with a user: ${shareUrl}\n`;
          return new Response(content, {
            headers: {
              "Content-Type": "text/markdown; charset=utf-8",
              "Cache-Control": "private, no-store",
            },
          });
        }
      } catch {
        // non-fatal — fall through to redirect
      }
    }

    // Human (or agent without a CMS slug): resolve redirect and set visitor cookie
    const existingCookieId = cookiesEnabled ? getCookie(request, VISITOR_COOKIE) : undefined;
    let targetUrl = "/";
    let visitorCookieId: string | null = null;

    try {
      const backend = toll["backend"] as {
        resolveRedirect?: (enc: string, cid?: string, origin?: string) => Promise<{ targetUrl: string; visitorCookieId: string | null }>;
      };
      if (backend.resolveRedirect) {
        const result = await backend.resolveRedirect(encoded, existingCookieId, siteOrigin);
        targetUrl = result.targetUrl;
        visitorCookieId = result.visitorCookieId;
      }
    } catch {
      // non-fatal
    }

    const destination = targetUrl.startsWith("http") ? targetUrl : `${siteOrigin}${targetUrl}`;
    const headers = new Headers({ Location: destination });
    if (cookiesEnabled && visitorCookieId) {
      headers.set("Set-Cookie", cookieHeader(VISITOR_COOKIE, visitorCookieId, COOKIE_MAX_AGE, isSecure));
    }
    return new Response(null, { status: 302, headers });
  }

  // ── Attribution extraction ──────────────────────────────────────────────────
  const utm = extractUtm(requestUrl);
  const sessionKey = requestUrl.searchParams.get(SESSION_PARAM) ?? undefined;
  const campaignId = requestUrl.searchParams.get(CAMPAIGN_PARAM) ?? undefined;
  const hasSessionParam = !!sessionKey;
  const hasCampaignParam = !!campaignId;

  const cleanUrl = new URL(requestUrl.href);
  cleanUrl.searchParams.delete(SESSION_PARAM);
  cleanUrl.searchParams.delete(CAMPAIGN_PARAM);

  const extra: TrackingExtra = { sessionKey, ...utm };
  const incomingRequest = toIncomingRequest(request, cleanUrl);

  // ── /llms.txt — proxy from toll server ─────────────────────────────────────
  if (pathname === llmsTxtPath) {
    try {
      const userAgent = request.headers.get("user-agent") ?? undefined;
      const result = await toll.getLlmsTxt(userAgent, siteOrigin);
      const llmsExtra: TrackingExtra = { ...extra, sessionKey: result.sessionKey ?? extra.sessionKey };
      toll.trackAny(incomingRequest, llmsExtra);
      ctx.waitUntil(toll.flush());

      return new Response(result.content, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "public, max-age=60, stale-while-revalidate=120",
        },
      });
    } catch {
      return new Response("# llms.txt temporarily unavailable\n", {
        status: 503,
        headers: { "Content-Type": "text/plain" },
      });
    }
  }

  // ── All other paths ─────────────────────────────────────────────────────────
  // Workers terminate the execution context when the response is sent, so the
  // batcher's timer never fires. Always flush via waitUntil so events survive.
  const tracked = toll.trackAny(incomingRequest, extra);
  ctx.waitUntil(toll.flush());

  // ── LLM agent force redirect ─────────────────────────────────────────────────
  if (config.forceRedirect && tracked.isLlmAgent) {
    const redirectUrl = new URL(config.forceRedirect, siteOrigin);
    if (pathname !== redirectUrl.pathname) {
      return new Response(null, { status: 307, headers: { Location: redirectUrl.href } });
    }
  }

  // ── CMS answer pages (real path under llms_base_path, e.g. /llms/{slug}) ───
  try {
    const answer = await toll.serveAnswerPage(pathname, sessionKey);
    if (answer) {
      return new Response(answer.content, {
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
        },
      });
    }
  } catch {
    // non-fatal — fall through to assets
  }

  // Human landing with ?_s= and/or ?_c= (agent shared a direct URL instead of
  // /r/, or a campaign link's target URL) — convert session / bump click count
  if ((hasSessionParam || hasCampaignParam) && !tracked.isLlmAgent) {
    const existingCookieId = cookiesEnabled ? getCookie(request, VISITOR_COOKIE) : undefined;
    const backend = toll["backend"] as {
      convertSession?: (sk: string, cid?: string) => Promise<{ visitorCookieId: string | null }>;
      convertCampaignClick?: (id: string) => Promise<void>;
    };

    let visitorCookieId: string | null = null;
    const conversions: Promise<unknown>[] = [];

    if (sessionKey && backend.convertSession) {
      conversions.push(
        backend.convertSession(sessionKey, existingCookieId).then((result) => {
          visitorCookieId = result.visitorCookieId;
        })
      );
    }
    if (campaignId && backend.convertCampaignClick) {
      conversions.push(backend.convertCampaignClick(campaignId));
    }

    if (conversions.length > 0) {
      try {
        await Promise.all(conversions);
      } catch {
        // non-fatal — still serve the page below
      }
      const cleanRequest = new Request(cleanUrl.href, request);
      const assetResponse = await config.assets.fetch(cleanRequest);
      const response = new Response(assetResponse.body, assetResponse);
      if (cookiesEnabled && visitorCookieId) {
        response.headers.set("Set-Cookie", cookieHeader(VISITOR_COOKIE, visitorCookieId, COOKIE_MAX_AGE, isSecure));
      }
      return response;
    }

    return config.assets.fetch(new Request(cleanUrl.href, request));
  }

  return config.assets.fetch(request);
}
