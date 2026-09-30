---
title: "NestJS + Fastify: application startup and request lifecycle"
description: "How a NestJS app on Fastify goes from process start to a JSON response: NestFactory building the module and dependency graph, listen() registering routes, a request reaching a controller, and why tests call init() and ready() instead."
pubDatetime: 2026-09-30T12:28:00+02:00
tags: [nestjs, fastify, dependency-injection, testing]
sourceNotes: [nestjs-fastify-startup-and-request-lifecycle]
---

> NestFactory constructs the module and dependency graph; `listen()` initializes routes and starts Fastify; requests then reach controllers and their injected services.

## Table of contents

## Overview

This traces the NestJS/Fastify foundation of a small learning project (a budget-review app), from process startup to the JSON response. It separates application construction, initialization, and network listening, and explains why production startup and tests use different calls. The examples use default-scoped controllers and providers.

## Key points

- `AppModule` describes how the application is composed; `NestFactory` creates the application from it.
- During `create()`, Nest discovers modules, registers provider tokens, and constructs default-scoped providers and controllers with their dependencies.
- `FastifyAdapter` connects Nest's HTTP operations to the underlying Fastify server.
- `listen()` initializes Nest if necessary, waits for Fastify startup, and opens the network port.
- Tests initialize the application and inject requests without opening a network port.

## 1. Process startup and application construction

With `pnpm start`, Node runs `apps/api/dist/main.js`. With `pnpm dev`, the Nest CLI compiles the source and launches the application, restarting it after changes. `main.ts` calls `bootstrap()`, which calls the shared `createApplication()` factory:

```typescript
return NestFactory.create<NestFastifyApplication>(
  AppModule,
  new FastifyAdapter(),
  { ...options, abortOnError: false }
);
```

`AppModule` is the root configuration, not the object that creates the server. Nest follows its imports and reads each module's controllers, providers, and exports. The adapter instance selects Fastify at runtime; the generic `NestFastifyApplication` only informs TypeScript.

The module graph:

```text
AppModule
├── HealthModule
│   ├── HealthController
│   └── HealthService (exported)
└── HelloModule
    ├── imports HealthModule
    ├── HelloController
    └── HelloService
```

Nest registers providers under tokens, and resolves constructor dependencies using those tokens and module visibility rules:

```typescript
constructor(private readonly healthService: HealthService) {}
```

Here, emitted constructor metadata identifies the `HealthService` class as the injection token, and Nest supplies its managed instance. `reflect-metadata` supports this metadata mechanism. The `private readonly` parameter-property syntax stores the dependency; it does not perform the injection itself.

`HelloModule` can use `HealthService` because it imports `HealthModule`, which exports that provider. Importing both modules into `AppModule` alone does not share their providers with each other. These Nest module imports/exports are distinct from TypeScript file imports/exports.

## 2. Initialization and listening

`main.ts` continues with:

```typescript
const app = await createApplication();
app.enableShutdownHooks();
await app.listen(3000, "127.0.0.1");
```

By this point, `createApplication()` has constructed the application and its default-scoped dependencies. `listen()` initializes Nest if it hasn't been initialized already: routes are registered through the adapter, and the initialization lifecycle hooks run. Fastify then completes its setup and opens the loopback port.

The adapter translates operations such as "register GET /health with this handler" into Fastify operations. Nest keeps responsibility for controllers, DI, and its request-handling behavior.

```text
Node runs main.js and calls bootstrap()
  → NestFactory.create()
  → Discover modules and register provider tokens
  → Resolve dependencies and construct instances
  → Return the application and enable shutdown hooks
  → app.listen()
  → Initialize Nest, register routes, run lifecycle hooks
  → Complete Fastify setup and listen on port 3000
```

Shutdown hooks connect supported process signals to Nest's shutdown lifecycle. The project's listen-failure handler closes the application and rethrows; the outer `bootstrap` catch logs the failure and sets a nonzero exit code.

## 3. Handling an incoming request

```typescript
@Controller("health")
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  getHealth(): HealthResponse {
    return this.healthService.getStatus();
  }
}
```

The decorators establish `GET /health`; the method name does not determine the URL.

```text
GET /health
  → Fastify matches the registered route
  → Nest's request handler invokes HealthController.getHealth()
  → Controller calls its injected HealthService.getStatus()
  → Service returns { status: 'ok' }
  → Nest/Fastify sends the object as JSON with HTTP 200
```

For these default-scoped classes, the controller and service already exist — they are not reconstructed for every request. `GET /hello` similarly combines results from its injected `HealthService` and `HelloService`.

## 4. Why tests call `init()` and `ready()`

```typescript
const app = await createApplication({ logger: false });
await app.init();
await app.getHttpAdapter().getInstance().ready();

const response = await app.inject({ method: "GET", url: "/health" });
await app.close(); // Use teardown or finally so cleanup also runs on failure.
```

| Call                                         | Responsibility                                                        |
| -------------------------------------------- | --------------------------------------------------------------------- |
| `app.init()`                                 | Initialize Nest, register routes, and run initialization hooks        |
| `app.getHttpAdapter().getInstance().ready()` | Reach the actual Fastify instance and wait for its plugin/route setup |
| `app.inject(...)`                            | Exercise HTTP handling inside the process, without a TCP connection   |
| `app.close()`                                | Release application resources                                         |

In production, `listen()` handles the necessary initialization before opening the port. Tests stop before network listening, but still run the real routing → controller → service path. Fastify injection can itself wait for readiness, so the explicit `ready()` can be redundant in this flow; it makes the setup boundary explicit.

## Gotchas

- **`create()` resolves the module/dependency graph before `listen()`** — don't place all startup work under `listen()`.
- **Nest resolves dependencies by token**, not by searching for objects with a matching TypeScript shape.
- **A provider's class import must exist at runtime** for class-token constructor injection; a type-only import cannot supply that class value.
- **TypeScript return types do not validate or strip response fields at runtime.**
- **`GET /health` is liveness only** — it does not establish database readiness.
- **This request trace covers simple controllers.** Request-scoped dependencies and additional middleware, guards, pipes, interceptors, and filters require a more detailed lifecycle trace.

## References

- Previous in this topic: [Node.js vs. Java vs. Python concurrency](/posts/nodejs-event-loop-vs-java-concurrency/) — where NestJS sits relative to Spring Boot and Express.
- [NestJS documentation — First steps](https://docs.nestjs.com/first-steps)
- [NestJS documentation — Performance (Fastify)](https://docs.nestjs.com/techniques/performance)
- [NestJS documentation — Lifecycle events](https://docs.nestjs.com/fundamentals/lifecycle-events)
