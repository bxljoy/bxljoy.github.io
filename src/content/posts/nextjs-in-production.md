---
title: "Running Next.js in production: deployment and upgrades"
description: "What hosting a dynamic Next.js app really requires — OpenNext on AWS or a standalone container, shared caches, streaming through every hop, and Lambda concurrency — and how to upgrade framework versions and cache models while verifying behavior with evidence."
pubDatetime: 2026-09-30T16:14:00+02:00
tags: [nextjs, deployment, aws, testing, performance]
sourceNotes:
  - nextjs-deployment-opennext-and-containers
  - nextjs-upgrades-and-behavior-verification
---

> - Hosting Next.js means placing static assets, server execution, cache storage, and revalidation where their semantics still work.
> - Separate framework upgrades from cache-model changes, and verify rendering and freshness in production builds.

## Table of contents

## Overview

This last post in the Next.js series covers running an application after it's built: where each part of a Next.js app has to live when you deploy it outside Vercel (with OpenNext or a container), and how to upgrade framework versions and cache models without silently changing rendering, freshness, or cost.

## Deploying Next.js with OpenNext or containers

A dynamic Next.js application needs a compatible server runtime in addition to static assets. Static export is a separate option with feature constraints; it does not provide runtime ISR or Server Actions.

### Key points

- Vercel integrates deployment and framework behavior; AWS deployments expose more of the infrastructure.
- OpenNext adapts the build output; infrastructure tooling provisions the resources.
- Containers simplify the server process, but still need coordinated caches across replicas.
- Streaming must work through every hop, not only in React code.

### Details

| Concern                        | Typical AWS/OpenNext responsibility    |
| ------------------------------ | -------------------------------------- |
| JS, CSS, public assets         | Object storage plus a CDN              |
| Dynamic rendering and handlers | A server function                      |
| Image optimization             | A separate function, in common layouts |
| Shared incremental cache       | Remote storage                         |
| Background regeneration        | Queue/worker integration               |
| Tag lookup/invalidation        | A shared metadata store                |

The exact artifacts and defaults depend on the adapter version and configuration. S3, SQS, and DynamoDB are an implementation choice in a common AWS layout, not a universal requirement for Next.js. See [OpenNext for AWS](https://opennext.js.org/aws).

For a standalone container:

```dockerfile
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
CMD ["node", "server.js"]
```

This assumes `output: 'standalone'` and a public directory. Static/public assets need separate handling. Local replica caches do not coordinate automatically; configure shared storage and invalidation when required (the [cache layers](/posts/nextjs-caching/#cache-layers-and-freshness-boundaries) each need an owner).

In the conventional Lambda execution model, concurrency is approximately arrival rate × average duration. At 1,000 requests/second and 0.1 seconds, that's about 100 concurrent executions. Separate environments can each hold database connections, so aggregate pool demand matters. DynamoDB uses HTTP connections rather than per-client SQL sessions; HTTP connection reuse still applies.

### Gotchas

- **A container can have startup and scale-out delays**; "no cold starts" is too absolute.
- **Database proxies and concurrency limits are options**, not proof that every Lambda must use RDS Proxy.
- **A buffering proxy can erase Suspense's early-delivery benefit.** Verify the adapter's streaming integration end to end.
- **Cost rankings depend on** traffic, duration, cache hit rate, region, and operational overhead.

## Upgrades and behavior verification

Build errors reveal API incompatibilities, while changed cache defaults can alter cost and freshness without a compiler failure. A framework version and its enabled feature flags jointly define the behavior to test.

### Key points

- Next 15 introduced async request APIs, and changed the fetch, GET handler, and client-router cache defaults.
- Adopting Next 16 and enabling Cache Components are separate changes.
- Use production builds to assess caching; development behavior can differ.
- Preserve reproducible evidence before claiming a performance improvement.

### Details

For a 14 → 15 transition, await `cookies()`, `headers()`, `draftMode()`, `params`, and `searchParams` as appropriate, and inspect explicit caching intent. Next 15's temporary synchronous compatibility was a migration bridge. The cache defaults changed, but a bare uncached fetch does not prove that every route becomes dynamic. See the [upgrade reference](https://nextjs.org/docs/app/guides/upgrading/version-15).

For a 15 → 16 transition, first check compatibility without adopting a new caching model. Then enable [Cache Components](/posts/nextjs-caching/#cache-components-and-partial-prerendering) in a separate, reviewable step, and migrate unsupported segment configuration. Inventory the exact release and adapter; don't carry experimental flags forward just because an older demonstration used them.

| Question                        | Evidence                                                |
| ------------------------------- | ------------------------------------------------------- |
| Did rendering change?           | Build legend, prerender manifest, representative routes |
| Did work move to the browser?   | Network initiator and bundle analysis                   |
| Does streaming survive hosting? | Incremental response timing through the actual ingress  |
| Does invalidation work?         | A controlled content change, the webhook, repeat reads  |
| Did cost change?                | Function invocations, origin reads, hit rate, duration  |
| Is personalization isolated?    | Two users/tenants with distinct expected output         |

Change one variable at a time: add a cookie read, compare the output, introduce a proper boundary under a supported PPR configuration, then repeat. Don't assume that moving work into Suspense is behavior-free; fallbacks and delivery order are observable UX changes.

### Gotchas

- **Development HMR can cache fetch results** even where a production read would be uncached. See [fetch troubleshooting](https://nextjs.org/docs/app/api-reference/functions/fetch).
- **A build symbol is useful evidence, not a full performance test** (the build legend is described in [rendering modes](/posts/nextjs-app-router-foundations/#rendering-modes-and-route-dynamism)).

## References

- Earlier in this topic:
  - [Next.js App Router foundations](/posts/nextjs-app-router-foundations/) — rendering modes and the build legend.
  - [Caching in Next.js](/posts/nextjs-caching/) — cache layers and Cache Components.
  - [Next.js on the server](/posts/nextjs-on-the-server/) — data access, Proxy, and metadata streaming.
- [OpenNext for AWS](https://opennext.js.org/aws)
- Next.js docs: [Upgrading to version 15](https://nextjs.org/docs/app/guides/upgrading/version-15) · [`fetch`](https://nextjs.org/docs/app/api-reference/functions/fetch)
