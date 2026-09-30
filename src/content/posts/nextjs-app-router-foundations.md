---
title: "Next.js App Router foundations: routing files, server/client boundaries, rendering modes, and what the browser receives"
description: "When Next.js beats a React SPA, how App Router files map to URLs and layouts, where the Server/Client Component boundary belongs, how rendering modes differ from that boundary, and what HTML and the RSC payload each deliver."
pubDatetime: 2026-09-30T13:44:00+02:00
tags: [nextjs, react, rendering, frontend, performance]
sourceNotes:
  - react-spa-vs-nextjs-and-client-data-caching
  - nextjs-app-router-files-and-layouts
  - nextjs-server-client-boundaries-and-hydration
  - nextjs-rendering-modes-and-route-dynamism
  - nextjs-html-rsc-payload-and-navigation
---

> - Choose rendering per user journey, and keep browser query caching for interactions that benefit from live client state.
> - Folders organize URL segments; page, route, layout, and boundary files determine what those segments expose and preserve.
> - Keep browser behavior in small client boundaries while composing server-rendered content through props or children.
> - Rendering time and the Server/Client Component boundary are independent: client interactivity does not force per-request HTML.
> - Initial navigation delivers displayable HTML plus React data; later client navigation reconciles an RSC payload into the existing document.

## Table of contents

## Overview

This post covers five connected pieces of the Next.js App Router, in reading order: when Next.js is the right choice over a plain React SPA, how the filesystem maps to routes and layouts, where to draw the Server/Client Component boundary, how rendering modes are a separate decision from that boundary, and what the browser actually receives on first load and on client navigation. Caching comes in the next post.

## React SPA vs. Next.js, and client data caching

A public product page and a long-lived internal dashboard have different loading and discovery needs. The choice depends on traffic, data access, interactivity, and operational cost — rather than a B2B/B2C label.

### Key points

- A pure CSR application depends on JavaScript before rendering route-specific content.
- Route loaders, prefetching, and parallel queries can avoid effect-driven waterfalls.
- Server rendering helps initial content delivery; RSC can reduce browser execution.
- TanStack Query remains useful for polling, infinite lists, client mutations, and background refetches.

### Details

A conventional SPA load is HTML → JavaScript → React mount → effect-triggered data request → content. A nested child that only mounts after its parent's request can create another sequential round trip. A query cache manages state and reuse, but does not automatically remove dependency waterfalls.

SPAs need server fallback routing for direct visits such as `/orders/123`, while preserving real asset and API routes. Static hosting is operationally simple. For a frequently used dashboard, prioritize code splitting, pagination, virtualization, and useful loading states.

In App Router, use server reads for initial content where appropriate, with client query state for repeated browser interactions. A client provider can receive server-rendered children without pulling their source code into its import graph. Keep server-side QueryClient state isolated per request and browser instances stable; use the library's SSR pattern, especially when initial rendering can suspend.

Vite is a development/build tool, not an inherently CSR-only framework: it also supports SSR integrations. Its bundler implementation is version-specific. Type transformation is separate from TypeScript checking, so run the project's type-check command as part of quality checks.

Sass adds compile-time CSS features such as mixins and loops. Native CSS custom properties and nesting overlap with some of its conveniences; CSS Modules address scoping. These are styling concerns, separate from the rendering strategy.

### Gotchas

- Query `staleTime` marks data stale; it is not automatically a polling timer.
- A module-global server query cache can mix users' data.
- Login-protected pages can still benefit from SSR, even without SEO.
- Measure bundle size, payload size, and interaction latency instead of counting `'use client'` files.

## App Router files, segments, and layouts

App Router combines routing and UI composition through filesystem conventions. Knowing which files create endpoints avoids accidental assumptions about colocation and layout lifetime.

### Key points

- `page.tsx` exposes a page; `route.ts` exposes an HTTP handler.
- `[slug]`, `[...slug]`, and `[[...slug]]` represent single, catch-all, and optional catch-all segments.
- Shared layouts preserve mounted UI; templates intentionally introduce remount boundaries.
- Route groups change the organization without adding a URL segment.

### Details

| Convention                    | Purpose                                                                  |
| ----------------------------- | ------------------------------------------------------------------------ |
| `app/product/[slug]/page.tsx` | Product page with a named path parameter                                 |
| `layout.tsx`                  | Shared wrapper; the root layout supplies `html` and `body`               |
| `template.tsx`                | Wrapper whose key changes across applicable navigation                   |
| `loading.tsx`                 | Suspense fallback for the segment's page subtree                         |
| `error.tsx`                   | Client error boundary; does not catch errors in its own segment's layout |
| `not-found.tsx`               | Not-found UI                                                             |
| `route.ts`                    | HTTP methods; cannot coexist with a page at the same route               |
| `(marketing)/`                | Route group, absent from the URL                                         |
| `_components/`                | Private subtree, excluded from routing                                   |
| `sitemap.ts`, `robots.ts`     | Metadata endpoints                                                       |

```tsx
export default async function ProductPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <h1>{slug}</h1>;
}
```

Async request APIs were introduced in Next 15; its temporary synchronous compatibility should not be carried forward as a coding pattern.

### Gotchas

- Static routes take priority over matching dynamic paths: a CMS slug such as `search` can conflict with an application route. Maintain a list of reserved slugs.
- `[page]` matches one segment; it is not a catch-all route.
- A page need not remount on every conceivable navigation; identity, keys, preserved segments, and router behavior all matter.
- In the previous cache model, supported segment config belongs in `page`, `layout`, or `route` files — not in arbitrary components or `template.tsx`.

## Server/Client boundaries and hydration

Server Components remove their implementation code from the browser bundle. Client Components provide state, events, effects, and browser integration, while usually still contributing server-rendered HTML on the initial load.

### Key points

- `'use client'` marks a module boundary; its client imports become browser dependencies.
- A server parent can pass server-rendered content through a client wrapper's `children`.
- Hydration attaches React behavior to existing HTML; a client-only mount creates the DOM.
- Less client code can reduce download, parsing, and hydration work, but serialized props still cost bandwidth and memory.

### Details

```tsx
// Server Component: imports both components
export default function Page() {
  return (
    <InteractiveTabs>
      <ProductDescription />
    </InteractiveTabs>
  );
}
```

If `InteractiveTabs` is a Client Component, the description can remain server-rendered, because the wrapper receives it from a server parent. Importing the description directly into the client module creates a different dependency boundary.

Server Components can await server data and use server-only credentials. Client Components cannot be declared as async component functions. That does not restrict them to `useEffect`: query libraries, prefetching, and supported Suspense/React `use` patterns also exist.

The initial Client Component output must match between server rendering and hydration. Time, randomness, locale, and browser-only state are common mismatch sources. Prefer a deterministic first render, then update after mount when necessary. Browser APIs remain unsafe during server prerendering, even in a file marked `'use client'`.

Server Components do not hydrate, but their output can change on navigation, refresh, or later server rendering. Hydration is not a guarantee that content becomes permanently immutable. Native links and forms can also work before React handlers are attached; a page is not universally "dead" before hydration.

### Gotchas

- A small interactive wrapper can import a large library; component count is not a bundle-size measurement.
- Sending thousands of records to a Client Component still serializes all those records.
- Suspense can coordinate streaming and selective hydration, but React may render more than twice because of retries, development checks, and updates.

## Rendering modes and route dynamism

The rendering strategy determines when work happens and how widely its output can be reused. The component boundary ([above](#serverclient-boundaries-and-hydration)) determines what JavaScript must also execute in the browser.

### Key points

- Static generation runs on the server at build time or on demand; dynamic rendering runs for requests.
- ISR refreshes reusable output without rebuilding the whole site.
- Client Components can be prerendered; Server Components can execute per request.
- A dynamic route can still reuse cached data.

### Details

| Mode         | When content is produced                   | Main consequence                                        |
| ------------ | ------------------------------------------ | ------------------------------------------------------- |
| CSR          | The browser executes JavaScript            | URL-specific content may wait for JS and data           |
| Static / SSG | Prerendering                               | Shared output for many visitors                         |
| ISR          | Initial generation plus later regeneration | Freshness and reuse coexist                             |
| Dynamic SSR  | Request time                               | Can use request-specific information                    |
| PPR          | Prerendered shell plus runtime regions     | Reuses surrounding content while streaming dynamic work |

In the previous App Router cache model, request APIs such as `cookies()`, `headers()`, page `searchParams`, or an explicit `no-store` fetch can require dynamic rendering. Reading identity in a shared root layout can therefore change many routes. With Cache Components, use the Cache Components rules instead (covered in [the caching post of this series](/posts/nextjs-caching/#cache-components-and-partial-prerendering)).

`params` identifies path segments; `generateStaticParams()` can enumerate values to prerender. In the previous model, `dynamicParams = false` rejects unlisted paths; the on-demand behavior with it enabled also depends on the route's rendering configuration.

Typical build legends include `○` for static, `●` for generated paths, `ƒ` for dynamic, and `◐` for partial prerendering. Treat the installed version's legend and manifests as the evidence. ISR may appear as static output with revalidation information, rather than with its own symbol.

### Gotchas

- A `[slug]` folder does not by itself prove request-time rendering.
- A bare fetch becoming uncached in Next 15 is not identical to explicitly declaring `no-store`: prerendered route output may still be reused. See [fetch semantics](https://nextjs.org/docs/app/api-reference/functions/fetch).
- Time-based ISR is demand-driven, not a background cron. Cold generation and immediate-expiry paths can block; "users never wait" is too strong.
- Suspense supports streaming without PPR. It does not activate partial prerendering on its own.

## HTML, the RSC payload, and client navigation

HTML is the browser's initial display format. The RSC payload describes server-rendered React output, client module references, and props, so React can compose and update the application tree.

### Key points

- Initial loads usually include both HTML and the RSC payload.
- Client navigation generally fetches route data rather than a replacement HTML document.
- Shared layouts can preserve mounted state across navigation.
- Prefetching and the browser Router Cache reduce navigation latency.

### Details

```text
Initial load:
Server Components → RSC payload → HTML rendering → browser display + hydration

Client navigation:
Link/prefetch → changed route payload → reconcile with existing React tree
```

The server renderer records Client Component references in the RSC payload; the HTML-rendering stage can render those components for the initial preview. Server-only data-source calls do not appear as separate browser requests in DevTools.

A shared layout ([see the App Router files section](#app-router-files-segments-and-layouts)) can remain mounted while its child route changes. Its persistent UI state is separate from the scroll-restoration policy. Navigation may need only the changed segments, but prefetch behavior and cache reuse vary by version, route, and configuration.

RSC reduces browser execution for server-only code. It is not free: large trees and props can produce substantial payloads. Evaluate transfer size alongside JavaScript execution, LCP, and interaction responsiveness.

### Verification

- Compare a full page load with a `<Link>` navigation in the Network tools.
- Inspect the initial response for content and RSC scripts, rather than only the post-JavaScript DOM.
- Inspect the production bundle output and browser performance traces.
- Do not build production integrations against the internal Flight wire format.

## References

- Earlier in this topic:
  - [React rendering and hooks internals](/posts/react-rendering-and-hooks-internals/) — the rendering and composition model underneath Server/Client boundaries.
  - [React Context vs. a store (Zustand)](/posts/react-context-vs-store-state-management/) — client state, alongside the client query caching discussed above.
- Next.js docs: [`fetch` API reference](https://nextjs.org/docs/app/api-reference/functions/fetch)
