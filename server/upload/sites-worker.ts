import { handleHostedRequest } from "../server/upload/worker.mjs";
import viewerHtml from "../public/index.html?raw";
import libraryHtml from "../public/library.html?raw";
import handler from "vinext/server/fetch-handler";
import { runWithConnectorBinding } from "../lib/connector-context";
import type { ConnectorBinding } from "../lib/connector-contract.mjs";

const worker = {
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext<{ CONNECTORS?: ConnectorBinding }>) {
    const api = await handleHostedRequest(request, env);
    if (api) return api;
    const url = new URL(request.url);
    if (["GET", "HEAD"].includes(request.method)) {
      // Serving index.html via ASSETS can redirect to / and strip a party code.
      const html =
        url.pathname === "/" || url.pathname === "/index.html" || /^\/[A-Z0-9]{7}\/?$/.test(url.pathname)
          ? viewerHtml
          : ["/library", "/library/", "/library.html"].includes(url.pathname)
            ? libraryHtml
            : null;
      if (html !== null)
        return new Response(request.method === "HEAD" ? null : html, {
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" },
        });
      return env.ASSETS.fetch(request);
    }
    let binding = ctx.props?.CONNECTORS;
    // Local preview emulates the same request-scoped capability. This branch and
    // the auxiliary service binding are absent from production builds.
    if (import.meta.env.DEV && !binding && env.CONNECTORS) {
      const preview = env.CONNECTORS;
      const expiresAt = Date.now() + 60_000;
      binding = {
        async getContext() {
          if (Date.now() >= expiresAt) return { status: "request_context_expired" };
          return preview.getContext?.() ?? { status: "binding_unavailable" };
        },
        async invoke(connectorId, actionName, args) {
          if (Date.now() >= expiresAt) {
            return { status: "request_context_expired", message: "This request has expired. Please try again." };
          }
          return preview.invoke(connectorId, actionName, args);
        },
      };
    }
    return runWithConnectorBinding(binding, () => handler.fetch(request, env, ctx));
  },
};

export default worker;
