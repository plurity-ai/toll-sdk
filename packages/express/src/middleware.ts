import type { Request, Response, NextFunction } from "express";
import { Toll } from "@plurity/toll";
import type { TollConfig, IncomingRequest } from "@plurity/toll";

export type TollExpressConfig = TollConfig & {
  siteId: string;
};

/**
 * Creates an Express middleware that detects AI agents and buffers tracking events.
 * Non-blocking — always calls next().
 */
export function createTollMiddleware(config: TollExpressConfig) {
  const toll = new Toll(config);

  return function tollMiddleware(
    req: Request,
    _res: Response,
    next: NextFunction
  ): void {
    const protocol = req.protocol ?? "http";
    const host = req.hostname;
    const url = `${protocol}://${host}${req.originalUrl}`;

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") {
        headers[key] = value;
      } else if (Array.isArray(value)) {
        headers[key] = value[0] ?? "";
      }
    }

    const incomingRequest: IncomingRequest = {
      url,
      method: req.method,
      headers,
      ip: req.ip ?? undefined,
    };

    toll.track(incomingRequest);
    next();
  };
}

export type LlmsTxtHandlerConfig = {
  siteId: string;
  backend: TollConfig["backend"];
};

/**
 * Creates an Express route handler that serves /llms.txt.
 * Mount at: app.get('/llms.txt', createLlmsTxtHandler({ siteId, backend }))
 */
export function createLlmsTxtHandler(config: LlmsTxtHandlerConfig) {
  const toll = new Toll({ siteId: config.siteId, backend: config.backend });

  return async function llmsTxtHandler(
    _req: Request,
    res: Response
  ): Promise<void> {
    try {
      const result = await toll.getLlmsTxt();
      res
        .status(200)
        .set("Content-Type", "text/plain; charset=utf-8")
        .set("Cache-Control", "public, max-age=300, stale-while-revalidate=3600")
        .send(result.content);
    } catch {
      res
        .status(503)
        .set("Content-Type", "text/plain")
        .send("# llms.txt temporarily unavailable\n");
    }
  };
}
