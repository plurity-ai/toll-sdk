export interface BuildSourceUrlOptions {
  /** The human-facing landing URL (QAPair.redirectUrl). Falls back to the site domain root. */
  redirectUrl?: string;
  /** Site domain, used for the fallback root. */
  domain: string;
  sessionKey?: string;
  slug?: string;
}

/**
 * Build the real, human-facing "Source" URL an agent should cite/hand back to
 * the user: the actual redirect_url (or site root), tagged with the fixed
 * utm_* convention plus _s for session attribution. No short-link wrapping.
 */
export function buildSourceUrl({ redirectUrl, domain, sessionKey, slug }: BuildSourceUrlOptions): string {
  const rawDomain = domain.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const scheme = rawDomain.startsWith("localhost") ? "http" : "https";
  const humanUrl = redirectUrl || `${scheme}://${rawDomain}/`;

  try {
    const u = new URL(humanUrl);
    u.searchParams.set("utm_source", "llms_txt");
    u.searchParams.set("utm_medium", "agent");
    if (slug) u.searchParams.set("utm_content", slug);
    if (sessionKey) u.searchParams.set("_s", sessionKey);
    return u.href;
  } catch {
    return humanUrl;
  }
}
