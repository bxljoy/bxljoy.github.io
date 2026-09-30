---
title: "Next.js on the server: data access, Server Actions, Proxy & auth boundaries, metadata & SEO"
description: "How to structure server-side data access behind Server Components, Route Handlers and Server Actions; what Proxy (formerly Middleware) should and shouldn't decide about auth; and how metadata streaming works and how to verify it for crawlers."
pubDatetime: 2026-09-30T16:03:00+02:00
tags: [nextjs, architecture, security, api-design, rendering]
sourceNotes:
  - nextjs-data-access-route-handlers-and-server-actions
  - nextjs-proxy-request-routing-and-auth-boundaries
  - nextjs-metadata-streaming-and-seo
---

> - Share server-side business functions; expose HTTP and mutation entry points only where the caller needs them.
> - Use Proxy for early routing decisions, with authoritative identity and resource checks at the protected server operation.
> - Metadata can be static or data-driven, and modern Next.js can stream it with behavior tailored to different crawlers.

## Table of contents

## Overview

This post covers the server side of a Next.js application in three parts: how Server Components, Route Handlers, and Server Actions should share one data layer; where Proxy fits in the request path and why it can't be your authorization layer; and how page metadata is produced, streamed, and verified for crawlers.

## Data access, Route Handlers, and Server Actions

Next.js places UI and server entry points in one project, but they still benefit from distinct responsibilities. A server-side data layer lets pages, actions, and HTTP handlers share the same rules.

### Key points

- Server Components can call server data functions directly.
- Route Handlers expose HTTP APIs for browsers, webhooks, and external clients.
- Server Actions integrate mutations with React forms and revalidation.
- Every externally callable entry point needs input validation and authorization.

### Details

```text
Server Component ────────────→ server-only service/data function
Client query → Route Handler → same function
Client mutation → Action ───→ same function
```

Keep transport concerns in Route Handlers and domain rules in shared functions. Authentication context must still reach the shared operation: bypassing your own HTTP controller must not bypass its authorization rules.

Calling the application's own Route Handler from a Server Component adds serialization, an absolute URL, and potentially another platform invocation. A direct import usually avoids this. Calls to an independently deployed service are a separate architectural choice.

Use `import 'server-only'` in modules containing server credentials or database access. Reuse safe SDK clients at module scope for warm-process connection reuse, but never store request-specific users or permissions in mutable globals.

For direct SDK reads, React `cache()` provides render-request memoization. Persistent caching needs the chosen Next.js cache API (see [the caching post](/posts/nextjs-caching/)). Normalize generated API data behind a small adapter when backend naming, units, defaults, or error shapes shouldn't leak into feature components.

### Gotchas

- **`'use server'` does not authorize an action.** Treat its arguments as untrusted, and check the requested resource — not only whether a user is logged in.
- **Actions are mutation-oriented POST entry points**, not a substitute for a general read API. Their internal data reads can still use caches.
- **TypeScript types do not validate** a network response or an action argument at runtime.
- **Successful writes must explicitly coordinate affected caches**; mutations do not automatically make every read fresh (see [cache invalidation](/posts/nextjs-caching/#cache-invalidation-and-stale-content-debugging)).

## Proxy routing and authentication boundaries

Proxy is the request-interception convention called Middleware in older Next.js versions. Its position before the filesystem routes makes it useful for redirects and rewrites, but it is not a replacement for application authorization.

### Key points

- Next 16 renamed the convention to `proxy.ts`; the current Proxy uses the Node.js runtime.
- Scope the `matcher` to routes that actually need interception.
- A cookie-presence check is only a coarse filter.
- The deployment topology determines where interception and CDN caching physically run.

### Details

```ts
export const config = { matcher: ["/dashboard/:path*"] };
```

The useful logical sequence is: configuration headers/redirects, the matched Proxy, rewrite/routing decisions, then route handling and cache/render behavior. Proxy may return a redirect or a response, rewrite the target, or allow processing to continue.

A session cookie's presence can cheaply redirect obviously unauthenticated users. Protected reads and mutations must still verify the session and authorize the requested resource — including when they're called through [Server Actions or Route Handlers](#data-access-route-handlers-and-server-actions).

The runtime history matters: Node Middleware became stable in Next 15.5; Next 16 Proxy defaults to Node and does not accept a `runtime` configuration override. It is inaccurate to describe all Next 15 Middleware as Edge-only, or the current Proxy as freely switching between Edge and Node. See the [Proxy reference](https://nextjs.org/docs/app/api-reference/file-conventions/proxy).

### Gotchas

- **An upstream CDN may answer before an origin request reaches Next.js.** Never generalize a framework lifecycle into a promise that every CDN hit invokes Proxy.
- **PPR can serve a cached shell while still requiring runtime work for dynamic regions**; "a cache hit means no server execution" needs that qualification.
- **A server-side verification library can run in a compatible runtime**, but expensive permission queries still need thoughtful placement.
- **A root-layout check alone cannot secure** every mutation or independently accessible endpoint.

## Metadata streaming and SEO verification

Metadata defines titles, descriptions, canonical URLs, and social previews. It should share the page's data-access policy without accidentally adding duplicate queries or avoidable latency.

### Key points

- Export `metadata` for fixed values, and `generateMetadata` for values derived from data or route parameters.
- Parent layouts can define title templates and `metadataBase`.
- Reuse eligible fetch memoization, or React `cache()` for repeated SDK calls.
- Verify browser and crawler responses instead of assuming metadata always blocks rendering.

### Details

```ts
export const metadata = {
  metadataBase: new URL("https://example.com"),
  title: { default: "Store", template: "%s | Store" },
};
```

A product route can load its title through the same server data function the page uses. Parent metadata is inherited according to the Next.js merge rules; don't assume arbitrary nested objects merge deeply.

Modern Next.js supports streaming metadata: the initial UI can arrive before `generateMetadata` completes. HTML-limited bots receive blocking metadata in the head, with detection controlled by the user agent and `htmlLimitedBots`. The common claim that metadata always blocks the first byte is therefore outdated. See [metadata behavior](https://nextjs.org/docs/app/api-reference/functions/generate-metadata).

### Verification

- Inspect the raw response as well as the final DOM (the initial HTML vs. RSC payload distinction from [the App Router foundations post](/posts/nextjs-app-router-foundations/#html-the-rsc-payload-and-client-navigation)).
- Compare an ordinary browser request with the relevant social-crawler user agent.
- Check canonical and Open Graph URLs, title templates, and missing-data fallbacks.
- Measure duplicate origin requests and response timing in a production build.

### Gotchas

- **CSR is not categorically unindexable:** some crawlers execute JavaScript. Initial HTML remains valuable for predictable content discovery and previews.
- **A private dashboard has little crawler value**, but server rendering may still improve loading or data access.
- **Streaming support must survive the deployment's proxies and adapters.**

## References

- Earlier in this topic:
  - [Next.js App Router foundations](/posts/nextjs-app-router-foundations/) — HTML, the RSC payload, and navigation.
  - [Caching in Next.js](/posts/nextjs-caching/) — invalidating caches after Server Action writes.
- Next.js docs: [Proxy](https://nextjs.org/docs/app/api-reference/file-conventions/proxy) · [`generateMetadata`](https://nextjs.org/docs/app/api-reference/functions/generate-metadata)
