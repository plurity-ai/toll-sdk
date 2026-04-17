// Capture currentScript immediately — it becomes null after the script finishes executing
const _currentScript = document.currentScript as HTMLScriptElement | null;

interface TollEvent {
  type: string;
  label?: string;
  url?: string;
  [key: string]: unknown;
}

interface EventPayload {
  siteId: string;
  userAgent: string;
  agentName: string;
  pageUrl: string;
  pagePath: string;
  httpMethod: string;
  referer?: string;
  occurredAt: string;
  customFields: {
    eventType: string;
    eventLabel?: string;
    targetUrl?: string;
    [key: string]: unknown;
  };
}

type TrackingMode = "all" | "tagged" | "manual";

// ─── Config read from script tag ───────────────────────────────────────────

const siteId = _currentScript?.dataset.siteId ?? "";
const siteKey = _currentScript?.dataset.siteKey ?? "";
const mode: TrackingMode =
  (_currentScript?.dataset.mode as TrackingMode) ?? "all";
const serverUrl =
  _currentScript?.dataset.serverUrl?.replace(/\/$/, "") ??
  "https://toll.plurity.ai";

// ─── Helpers ────────────────────────────────────────────────────────────────

function isOptedOut(): boolean {
  try {
    return localStorage.getItem("toll_opt_out") !== null;
  } catch {
    return false;
  }
}

function send(payload: EventPayload[]): void {
  const url = `${serverUrl}/api/public/${siteId}/events`;
  const body = JSON.stringify(payload);
  const headers = {
    "Content-Type": "application/json",
    "X-Site-Key": siteKey,
  };

  if (typeof fetch !== "undefined") {
    // Fire-and-forget — intentionally no await, no error surface
    void fetch(url, { method: "POST", headers, body, keepalive: true }).catch(
      () => undefined
    );
  } else if (typeof navigator !== "undefined" && navigator.sendBeacon) {
    const blob = new Blob([body], { type: "application/json" });
    navigator.sendBeacon(url, blob);
  }
}

function buildPayload(
  eventType: string,
  extra?: { label?: string; targetUrl?: string; [key: string]: unknown }
): EventPayload {
  const customFields: EventPayload["customFields"] = { eventType };
  if (extra?.label) customFields.eventLabel = extra.label;
  if (extra?.targetUrl) customFields.targetUrl = extra.targetUrl;

  // Copy any additional custom keys from extra
  if (extra) {
    for (const key of Object.keys(extra)) {
      if (key !== "label" && key !== "targetUrl") {
        customFields[key] = extra[key];
      }
    }
  }

  const referer = document.referrer || undefined;

  return {
    siteId,
    userAgent: navigator.userAgent,
    agentName: "visitor",
    pageUrl: window.location.href,
    pagePath: window.location.pathname,
    httpMethod: "GET",
    ...(referer !== undefined ? { referer } : {}),
    occurredAt: new Date().toISOString(),
    customFields,
  };
}

// ─── Tagged-mode element detection ──────────────────────────────────────────

interface TaggedResult {
  found: boolean;
  label?: string;
  extra?: Record<string, string>;
}

// Reserved data-toll-* keys that are not forwarded as custom fields
const RESERVED = new Set(["siteId", "siteKey", "mode", "serverUrl", "track", "label"]);

function collectTollData(el: Element): Record<string, string> {
  const result: Record<string, string> = {};
  for (const attr of Array.from(el.attributes)) {
    if (attr.name.startsWith("data-toll-")) {
      // Convert data-toll-my-field → myField (camelCase)
      const key = attr.name
        .slice("data-toll-".length)
        .replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      if (!RESERVED.has(key)) {
        result[key] = attr.value;
      }
    }
  }
  return result;
}

function findTaggedAncestor(el: Element | null, maxLevels: number): TaggedResult {
  let current = el;
  for (let i = 0; i <= maxLevels && current !== null; i++) {
    if (current.hasAttribute("data-toll-track")) {
      const label =
        current.getAttribute("data-toll-label") ??
        current.getAttribute("data-toll-track") ??
        undefined;
      const extra = collectTollData(current);
      return { found: true, label: label || undefined, extra };
    }
    current = current.parentElement;
  }
  return { found: false };
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function track(event: TollEvent): void {
  if (!siteId || !siteKey) return;
  if (isOptedOut()) return;

  const { type, label, url, ...rest } = event;
  const extra: Record<string, unknown> = { ...rest };
  if (label) extra.label = label;
  if (url) extra.targetUrl = url;

  send([buildPayload(type, extra)]);
}

// ─── Auto-init ───────────────────────────────────────────────────────────────

function init(): void {
  if (!siteId || !siteKey) {
    console.warn(
      "[PlurityToll] Missing data-site-id or data-site-key on the script tag. Tracking disabled."
    );
    return;
  }

  if (isOptedOut()) return;

  // Always fire a pageview
  send([buildPayload("pageview")]);

  if (mode === "manual") return;

  // ── Delegated click listener ────────────────────────────────────────────
  document.addEventListener(
    "click",
    (e: MouseEvent) => {
      if (isOptedOut()) return;

      const target = e.target as Element | null;
      if (!target) return;

      // Only care about <a>, <button>, and [type=submit]
      const anchor = target.closest("a");
      const button = target.closest("button, [type='submit']");
      const interactable = anchor ?? button;
      if (!interactable) return;

      if (mode === "tagged") {
        const result = findTaggedAncestor(interactable, 3);
        if (!result.found) return;
        const targetUrl = anchor?.href ?? undefined;
        send([buildPayload("click", { label: result.label, targetUrl, ...result.extra })]);
      } else {
        // mode === "all"
        const targetUrl = anchor?.href ?? undefined;
        const label =
          interactable.getAttribute("data-toll-label") ??
          interactable.getAttribute("aria-label") ??
          interactable.textContent?.trim().slice(0, 80) ??
          undefined;
        const extra = collectTollData(interactable);
        send([buildPayload("click", { label: label || undefined, targetUrl, ...extra })]);
      }
    },
    { passive: true }
  );

  // ── Delegated form submit listener ────────────────────────────────────────
  document.addEventListener(
    "submit",
    (e: SubmitEvent) => {
      if (isOptedOut()) return;

      const form = e.target as HTMLFormElement | null;
      if (!form) return;

      if (mode === "tagged") {
        const result = findTaggedAncestor(form, 3);
        if (!result.found) return;
        send([buildPayload("submit", { label: result.label, ...result.extra })]);
      } else {
        const label =
          form.getAttribute("data-toll-label") ??
          form.getAttribute("name") ??
          form.getAttribute("id") ??
          undefined;
        const extra = collectTollData(form);
        send([buildPayload("submit", { label: label || undefined, ...extra })]);
      }
    },
    { passive: true }
  );
}

// Run init once the DOM is available
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
