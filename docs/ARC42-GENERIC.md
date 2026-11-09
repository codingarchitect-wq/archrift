# Making the arc42 views generic

Written 2026-10-10, after the five arc42 views were built; updated for the
polyglot readers. This note covers how far the views work on other projects,
and what it would take to make them fully generic. Items marked open are not
built yet.

## Where they stand

- **Nothing is hard-coded to one project.** A grep of `src/viewer/views/{context,blocks,runtime,crosscutting,risks,arc42-kit}` finds no project names, folders or files. Each view works from the analysis graph, with fallbacks for missing data: no git history, no configured layers, nothing found.
- **Coverage is the limit:**
  - How much a view shows depends on how well archrift understands the project's stack. The views were built on TypeScript with Next.js, tRPC, Prisma, Dexie and React; the polyglot readers added Angular with NgRx, Kotlin with Spring, Avro, Go, Kafka topics, databases and infrastructure (`src/analyzer/plugins/`, [POLYGLOT.md](POLYGLOT.md)).
  - The visual tuning (label density, size caps, spacing) was done on one mid-sized app. Much smaller and much larger projects may need retuning.

## Per view

| View | On any TS/JS project | What depends on the stack |
|---|---|---|
| **§11 Risks** | Fully: git churn, dependents, cycles, rules, co-change, tests | Nothing. Without git it falls back to complexity × fan-out and says so |
| **§5 Building blocks** | Folders, or the toolbar's groups (detected modules, layers, configured groups), and layers. Without a configured `layers`, they come from dependency depth (with generic names like "level 2: src/x") | Monorepos: `topBlocks` (`arc42-kit/blocks.ts`) goes down only when one folder holds ≥ 80 % of the code, so `apps/` and `packages/` would show as 2 blocks |
| **§8 Crosscutting** | Detection (code used by many blocks) is fully generic | Concept names come from a generic English keyword table (`crosscutting/model.ts`). One rule, for short translation hooks named like `useT`, came from the convention of the app the views were tuned on |
| **§6 Runtime** | Generic for any TypeScript: the call walk in source order, and an interface call turned into an alt fragment | Scenarios come from route tags (`route:`/`api:`: Next.js pages and routes, Angular routes, Spring controllers), otherwise only from `entrypoint` files (`runtime/scenario.ts`). The network pane knows tRPC (`rpc-call`) and HTTP between services (`http-call`); database lifelines come from `queries`, topic lifelines from `publishes` |
| **§3 Context** | Outside services from a catalog of about 30 well-known package groups (`context/catalog.ts`: Stripe, SMTP mailers, Postgres, Mongo, AWS, Sentry …, JVM and Go packages included) | Callers come only from route tags plus guesses from route names (`callerOf` in `context/model.ts`: webhook, cron, health, trpc, auth). Data stores come from `queries` (Prisma, Dexie, Spring Data, the databases a module's configuration names) or the catalog; topics show as the message broker |

**Example: an Express + Drizzle backend.**
- §5, §8 and §11 look right.
- §6 gives one scenario from `main.ts`, with no network pane or database lifelines.
- §3 shows the outside services, but no callers on the left.

## What would make them generic

In order of payoff:

1. **More framework plugins (the main lever).**
   - **Why it works:** the views read abstract tags and edges (`route:`, `api:`, `entrypoint`, `rpc-call`, `http-call`, `queries`, `publishes`), not framework names. A plugin that emits them for another framework fills the views without changing them.
   - **Built since:** Angular routes, Spring and Go HTTP handlers, Spring Data repositories, Kafka topics ([POLYGLOT.md](POLYGLOT.md)).
   - **Open, routes and pages:** Express, Fastify, Nest, Hono, React Router, Remix, SvelteKit, Astro.
   - **Open, database queries:** Drizzle, TypeORM, Sequelize, Mongoose, Knex, Kysely.
   - **Open, async channels** beyond Kafka: RabbitMQ, SQS, BullMQ.
2. **Network calls in general, not only tRPC.**
   - **Built:** the generic remote-call edge, `http-call`, which the runtime view's network pane and the transit view use like `rpc-call`. Requests come from Angular's `HttpClient` and Go's `net/http`, handlers from Spring and Go, matched by method and path (POLYGLOT.md, P4).
   - **Open:** `fetch`/`axios`/`ky` calls in plain TypeScript, matched to the app's own route handlers by URL string, the way `navigates` is guessed from `href` strings.
3. **Features (built 2026-10-10)** have the same dependency.
   - *Group by → feature* (`src/core/features.ts`) seeds features from the `route:`/`api:` tags.
   - A route plugin for another framework gives that framework features too.
4. **Monorepos (open):** use workspace packages as the top-level blocks. The analyzer already has workspace and package levels in its node hierarchy.
5. **An optional per-project overlay in the config (open)**, for what guessing can't know:
   - names and groupings for blocks
   - actors, and who calls which routes
   - extra package-to-system mappings for the context catalog
   - named runtime scenarios (an entry plus optionally an end)
   - links to ADRs

   A project's own arc42 docs, where it has them, could seed it once.
6. **Test on a spread of real projects (open):** a small library, a monorepo, a backend-only API, a ~10k-file app. Turn them into fixtures and e2e specs, then retune label density, caps and empty states.
7. **Other languages need new analyzers.** Built for Kotlin, Avro and Go: tree-sitter readers behind the same `LanguageAnalyzer` interface ([POLYGLOT.md](POLYGLOT.md)). The views needed only the new edge kinds (`http-call`, topics), nothing per language. Another language needs its reader, and for §3 and §6 its framework plugins.

**Where to start:** 1 and 2, for the stack of the next project to analyze. They also feed the features (3).

**To see the gaps today:** in the toolbar's project menu, **Add a folder** with another repo, then step through the arc42 menu (key `9`).
