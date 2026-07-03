import type { IncomingRequest, HeaderRule } from "./types.js";

// Known AI agent user-agent patterns
const BUILT_IN_AGENT_PATTERNS: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /GPTBot/i, name: "GPTBot" },
  { pattern: /ClaudeBot/i, name: "ClaudeBot" },
  { pattern: /Claude-Web/i, name: "ClaudeWeb" },
  { pattern: /PerplexityBot/i, name: "PerplexityBot" },
  { pattern: /Googlebot/i, name: "Googlebot" },
  { pattern: /Bingbot/i, name: "Bingbot" },
  { pattern: /DuckDuckBot/i, name: "DuckDuckBot" },
  { pattern: /anthropic-ai/i, name: "AnthropicAI" },
  { pattern: /ChatGPT-User/i, name: "ChatGPT" },
  { pattern: /OAI-SearchBot/i, name: "OAI-SearchBot" },
  { pattern: /YouBot/i, name: "YouBot" },
  { pattern: /Diffbot/i, name: "Diffbot" },
  { pattern: /facebookexternalhit/i, name: "FacebookBot" },
  { pattern: /Twitterbot/i, name: "Twitterbot" },
  { pattern: /LinkedInBot/i, name: "LinkedInBot" },
  { pattern: /Slackbot/i, name: "Slackbot" },
  { pattern: /TelegramBot/i, name: "TelegramBot" },
  { pattern: /WhatsApp/i, name: "WhatsAppBot" },
  { pattern: /Applebot/i, name: "Applebot" },
  { pattern: /SemrushBot/i, name: "SemrushBot" },
  { pattern: /AhrefsBot/i, name: "AhrefsBot" },
  { pattern: /MJ12bot/i, name: "MajesticBot" },
  { pattern: /DataForSeoBot/i, name: "DataForSeoBot" },
  { pattern: /ia_archiver/i, name: "WaybackMachine" },
];

/**
 * Agent names that represent LLM providers/AI assistants fetching content to
 * answer user questions. Excludes search-engine indexers (Googlebot, Bingbot,
 * DuckDuckBot) and social/SEO crawlers so those are never redirected.
 */
export const LLM_AGENT_NAMES = new Set([
  "GPTBot",
  "ClaudeBot",
  "ClaudeWeb",
  "PerplexityBot",
  "AnthropicAI",
  "ChatGPT",
  "OAI-SearchBot",
  "YouBot",
]);

export interface DetectionResult {
  isAgent: boolean;
  agentName: string | null;
  /** True only for LLM provider crawlers — excludes search indexers and social bots. */
  isLlmAgent: boolean;
}

export class AgentDetector {
  private readonly customPatterns: Array<{ pattern: RegExp; name: string }>;
  private readonly excludePatterns: RegExp[];
  private readonly headerRules: HeaderRule[];

  constructor(options: {
    agentPatterns?: RegExp[];
    excludePatterns?: RegExp[];
    headerRules?: HeaderRule[];
  } = {}) {
    this.customPatterns = (options.agentPatterns ?? []).map((p, i) => ({
      pattern: p,
      name: `CustomAgent${i + 1}`,
    }));
    this.excludePatterns = options.excludePatterns ?? [];
    this.headerRules = options.headerRules ?? [];
  }

  detect(request: IncomingRequest): DetectionResult {
    const ua = this.getHeader(request, "user-agent") ?? "";

    // Check header rules first
    for (const rule of this.headerRules) {
      const headerValue = this.getHeader(request, rule.header.toLowerCase());
      if (rule.exists && headerValue !== undefined) {
        const agentName = rule.header;
        return { isAgent: true, agentName, isLlmAgent: LLM_AGENT_NAMES.has(agentName) };
      }
      if (rule.value && headerValue === rule.value) {
        const agentName = `${rule.header}:${rule.value}`;
        return { isAgent: true, agentName, isLlmAgent: LLM_AGENT_NAMES.has(agentName) };
      }
    }

    // Check custom include patterns
    for (const { pattern, name } of this.customPatterns) {
      if (pattern.test(ua)) {
        if (this.isExcluded(ua)) return { isAgent: false, agentName: null, isLlmAgent: false };
        return { isAgent: true, agentName: name, isLlmAgent: LLM_AGENT_NAMES.has(name) };
      }
    }

    // Check built-in patterns
    for (const { pattern, name } of BUILT_IN_AGENT_PATTERNS) {
      if (pattern.test(ua)) {
        if (this.isExcluded(ua)) return { isAgent: false, agentName: null, isLlmAgent: false };
        return { isAgent: true, agentName: name, isLlmAgent: LLM_AGENT_NAMES.has(name) };
      }
    }

    return { isAgent: false, agentName: null, isLlmAgent: false };
  }

  /** Returns the detected agent name from UA, or "visitor" if not a known agent. */
  detectAny(request: IncomingRequest): string {
    const result = this.detect(request);
    return result.agentName ?? "visitor";
  }

  private isExcluded(ua: string): boolean {
    return this.excludePatterns.some(p => p.test(ua));
  }

  private getHeader(request: IncomingRequest, name: string): string | undefined {
    const value = request.headers[name];
    if (Array.isArray(value)) return value[0];
    return value;
  }
}
