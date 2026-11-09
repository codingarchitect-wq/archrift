# Polyglot systems

*2026-10-18 · status: done (P1–P5): the Angular, NgRx, Kotlin, Avro, Go and infrastructure readers, and the links between services*

A single TypeScript app keeps its architecture inside its files: imports,
calls, components. A system of services keeps most of it *between* the parts:
which frontend calls which service, which service publishes the events
another one consumes, and which database each one owns. This note is about
how archrift reads such a system: what each reader extracts and why, the
links it draws between the parts, and what it doesn't see.

The kind of system the readers were built for:

| Part | Language | Read by |
|---|---|---|
| Web apps | Angular with NgRx, TypeScript | the TypeScript compiler API, with the Angular and NgRx plugins (P2) |
| Services and their shared libraries | Kotlin, Spring Boot, Gradle modules | the JVM reader, with Spring (P3) |
| Event schemas | Avro (`.avsc`) | the JVM reader (P3) |
| Smaller services | Go | the Go reader (P5) |
| Between them | HTTP, Kafka topics, MySQL, PostgreSQL and MongoDB databases | the http, messaging and datastore plugins (P4) |
| Deployment, often in a second repository | Helm charts, Kubernetes YAML, shell scripts, SQL, Dockerfiles, Pulumi in TypeScript | the infrastructure reader, through a mount (P5) |

The parts are labelled P1 to P5, in the order they were built; the source
comments cite them (`docs/POLYGLOT.md, P3`). The fixtures show each reader
small: `fixtures/angular`, `fixtures/kotlin-spring` (two Gradle modules,
packages `com.acme.*`), `fixtures/go-service`, `fixtures/infra-root` with
`fixtures/infra-mount` mounted as `infra/`, and `fixtures/schemas`.

## Decisions

- **One project, saved views.** The links between the parts are the
  architecture, and archrift has one graph per project. So a system's
  repository is one project, and its sides are saved views over its graph:
  *Frontend* (the web apps alone), *Backend* (the services and libraries,
  with their topics and databases), *System* (everything, grouped by
  service).
- **A second repository joins as a mount.** The config's `mounts` maps a name
  to another folder: `"mounts": { "infra": "~/src/infra" }` makes its files
  `infra/…` in the graph (`fixtures/infra-root` mounts `../infra-mount`).
  Source reads, editor links and git history go to the right repository.
  Snapshots and watch mode cover the main root only.
- **Parsers.** TypeScript stays on the compiler API. Kotlin and Go use
  tree-sitter compiled to WebAssembly (`web-tree-sitter` with the grammars'
  own `.wasm`: no native build, `ignore-scripts` stays on). Tree-sitter
  recovers from syntax errors, so a file it can't parse whole still gives
  what it can. YAML uses the `yaml` package; Avro schemas are JSON; shell
  scripts are read line by line.
- **Resolution without a compiler.** Kotlin has no type checker here, so
  references are resolved by name: a fully-qualified-name index over every
  Kotlin declaration and Avro record, imports (explicit, aliased, star), the
  file's own package, and the enclosing classes. Calls on a value go through
  its declared type (constructor-injected properties, parameters, locals with a
  type or a constructor call), which covers Spring's dependency injection.
  Where a name is declared in several modules, the caller's own Gradle module
  wins, then the libraries. Edges found this way are `exact` when a single
  declaration matched.
- **The new links are generic, the conventions are config.**
  - `http-call` (client code → the endpoint handler that serves it). Clients:
    Angular `HttpClient` calls, Go's `net/http` requests. Endpoints: Spring
    `@GetMapping` and friends, with class-level `@RequestMapping`; Go's
    `net/http`, gorilla, chi, gin and echo routes. Matched by HTTP method and
    path, with path variables as wildcards and the request's unknown base
    (host, gateway prefix, version) allowed for; matching strings is a guess,
    so these edges are `inferred`. Handlers are tagged
    `http:GET /v1/orders/{customer}`.
  - `publishes` / `subscribes` (code → topic). Spring `@KafkaListener`, Kafka
    templates and topic lookups; Go consumers and producers. Topics are nodes
    of their own (`x:kafka:<topic>`, tagged `infra`), named by the topic name
    the service's own configuration gives (Spring placeholders and the
    `application*.yml` profiles are resolved), so a Go producer and a Kotlin
    consumer meet at the same topic.
  - `queries` (already there for Prisma and Dexie): Spring Data repositories
    → the entity they store and the database their module connects to.
    Entities are tagged `entity`, `db:sql` or `db:mongodb`, and
    `table:<name>`.
- **Infra declares, code uses.** From the infrastructure: topics created by
  `kafka-topics.sh --create`, databases from `CREATE DATABASE`, Helm charts
  and the Kubernetes resources in plain YAML. They become the declaration the
  code's topics and databases point to.
- **Views stay generic.** The runtime, transit and context views learn
  `http-call` and the topics the way they know `rpc-call` and `queries`
  ([ARC42-GENERIC.md](ARC42-GENERIC.md), items 1 and 2).

## P1: one project, several languages

What the readers needed before any of them could run:
- **A config for a system:** one tsconfig per Angular app (`tsconfig` takes a
  list), excludes, test globs, layers, and a group per service, so *group →
  by configured group* shows the services.
- **An analyzer per language.** Each `LanguageAnalyzer` (TypeScript, JVM, Go,
  infrastructure) says whether the project has files for it, reads them with
  its own cache and hands its file fragments to one assembly, where the
  plugins link across languages.
- **Edge kinds for the links between parts:** `http-call`, `publishes`,
  `subscribes`, beside `rpc-call` and `queries`.
- **Mounts** (`src/analyzer/mounts.ts`): another folder, usually a second
  repository, analyzed with the root under a name. Excludes, layers, groups
  and `tsconfig` entries name its files by that path. A mount's commits are
  read from its own repository and join the root's by time, so its files get
  commits, churn, hotspots and co-change like the root's.

## P2: Angular and NgRx

**Code** (`src/analyzer/plugins/`):
- `angular.ts`: kinds, templates, routes, navigation and HTTP requests.
- `ngrx.ts`: NgRx as an in-app message bus.
- `angular-template.ts`: a tolerant template scanner. It uses no HTML parser.
- `evaluate.ts`: the strings route paths and URLs are built from, followed
  through the checker.

Plugins can ask for the graph id of any declaration (`ExtractApi.idOf`), which
makes its file a cache dependency, and `symbolKind` sees classes too. The
fixture is `fixtures/angular`, with local stubs for the Angular, NgRx and rxjs
packages.

**What it adds:**
- Components, directives, pipes, services, modules and effects get those
  kinds. A template's elements `render` the components and directives whose
  selectors they match; a pipe used is a reference.
- Routed components are tagged with their full path (`route:/projects/list`),
  read through nested children, lazy modules and path constants.
  `routerLink` and `router.navigate` become `navigates` edges.
- NgRx: dispatching an action `publishes` its type; `ofType` in an effect and
  a reducer's `case` or `on()` `subscribe` to it.
- `HttpClient` calls are recorded as requests for the HTTP matcher (P4).

In the fixture, `ProjectListComponent` is tagged `route:/projects/list` and
renders `ProjectCardComponent` and the shared button; the effect
`ProjectEffects.requestAll$` subscribes `REQUEST_PROJECTS` and calls
`ProjectService.findAll`, whose request is `GET /v5/projects`.

**Decisions:**
- **Templates are read when the graph is assembled,** so a changed `.html`
  shows on the next run without a cache entry of its own. Template edges point
  at the `templateUrl` or `template` property.
- **A selector declared twice** (two apps, each with its own loader component)
  resolves to the declaration in the same file, else the one with the longest
  shared folder prefix. Test stubs only count for tests. Edges resolved this
  way are `inferred`, the others `exact`.
- **An app is the folder of a `forRoot` registration.**
  - A link only leads to pages of its own app.
  - A part only known at run time (`{}`) takes a `:param` before it guesses a literal segment.
  - Catch-all and outlet routes are never a link's target. A catch-all is tagged `not-found:/`, as Next.js not-found files are.
  - `featureOfRoute` reads Angular's `:param` and `(outlet:path)` syntax.
- **Enum members become nodes only when they are action types,** as members
  of their enum (`…#ProjectActionEnum.Select`).
- **What is an action type:** what an action class (`implements Action`) or a
  creator declares, what is dispatched, and what `ofType` listens to. A value
  created in an effect, or a reducer's `case`, only counts when it names one
  of those.
- **A request's path joins its URL's parts with `/`.** The parts are:
  - literals, template literals, `+` and constants
  - the constant arguments of the URL builder's constructor; a missing argument is the parameter's default
  - the arguments of its path calls (`withPath`, `withBasePath`)

  A base URL only known at run time (the fixture's `apiUrl()`, a
  `configuration.api`) is dropped, as are the scheme, host and query. Of a
  conditional's two paths, the segments both share are kept.

**Not read:**
- **URLs that arrive as data:** blob URLs and pre-signed upload URLs, such as
  the fixture's `ProjectService.download(url)`. These requests are `/{}`.
- **A gateway prefix inside the base URL.** It is dropped with the base, so
  request paths start at the version (`/v5/projects/{}`). The HTTP matcher
  allows for that (P4).
- **Links whose target is data,** such as `[routerLink]="item.url"`. Template
  expressions are read without the checker.
- **Relative navigation and outlet navigation.**
- **Dispatches of action factories** held in a map or an input
  (`this.actions[id](…)`, `this.setPageAction(page)`).

## P3: the JVM reader (Kotlin, Spring, Avro)

- **Code:** `src/analyzer/tree-sitter.ts` loads the WebAssembly grammars; `src/analyzer/jvm/` holds the reader:
  - `kotlin-decls.ts`, pass A: declarations from one file (types, members, companion constants as the type's static members, constructor `val`s, enum entries, typealiases, annotations, constant initializers).
  - `index.ts`: name resolution by Kotlin's scoping rules, module first (`build.gradle*`, `pom.xml`, `go.mod` folders; a build file that names another module's folder depends on it).
  - `kotlin-link.ts`, pass B: references, calls, instantiations, type refs, extends/implements, overrides, following values through declared types.
  - `spring.ts`: stereotypes, handlers, listeners, senders, repository queries. `avro.ts`: schemas. `entities.ts`: JPA entities and Mongo documents as tables for the Tables view.
  - `analyzer.ts`: the two passes and their cache (`<out>/cache/jvm.json`).
- **Grammar quirks handled:** a body-less `annotation class` under other annotations parses as an expression (recovered in pass A); tree-sitter hands out a new node object per access, so nodes compare by id.
- **In the fixture,** a controller calls its service through a
  constructor-injected property, the service calls its repository, and the
  repository queries the database its module's `application.yml` names:

  ```
  $ archrift query path order-service/src/main/kotlin/com/acme/order/OrderController.kt x:db:mysql:acme-orders --root fixtures/kotlin-spring
  order-service/src/main/kotlin/com/acme/order/OrderController.kt depends on x:db:mysql:acme-orders:
  1 shortest path, 3 steps

    order-service/src/main/kotlin/com/acme/order/OrderController.kt
      → order-service/src/main/kotlin/com/acme/order/OrderService.kt  (calls, type-ref)
      → order-service/src/main/kotlin/com/acme/order/OrderRepository.kt  (calls, type-ref)
      → x:db:mysql:acme-orders  (queries)
  ```

  `OrderService` also instantiates `OrderEventAvro`, which resolves to the
  record in `common-lib/src/main/avro/OrderEventAvro.avsc`.
- **Not resolved:** imports of build-time output, such as the JPA metamodel
  (`Order_`) and the builders Avro generates, and names declared in Java.
- **Not followed:** values without a declared type that come from generic calls or lambdas (`list.forEach { it.go() }`), Java sources.

## P4: links between services

- **Analysis** (`src/analyzer/plugins/`):
  - `http.ts` matches requests to handlers (`http-call`, inferred). A handler fits when its path ends the request's; the request's unknown base (host, gateway prefix, version) may stand for anything, an unknown segment after it only for a variable. Of the handlers that fit, the longest wins, then the one with more literal segments.
  - `messaging.ts` resolves listeners, senders and topic-creating code to topic nodes (`x:kafka:<key>`) through the module's configuration (`module-config.ts`: YAML profiles and `.properties`, relaxed keys, `${…}` placeholders, channel bindings). The key drops environment segments and a trailing version.
  - `datastores.ts`: a module's repositories `queries` the databases its datasource URLs name (`x:db:<engine>:<key>`, name only); scripts declare them. The key keeps the name's own words: no environment, no `db`, and not a first word that most names from one source share (an organisation's prefix).
  - Spring controllers' files carry `api:` tags, so they seed features and are runtime scenarios.
- **In the fixtures:**
  - `PaymentListener` listens on `${custom.kafka.bindings.payment.kafkaTopic}`, which the `local` profile of its `application.yml` sets to `acme.local.payments`: the topic `x:kafka:acme.payments`.
  - `OrderService` sends to `acme.local.orders`, the topic `x:kafka:acme.orders`. The provisioning script in `fixtures/infra-mount` creates `acme.$ENV.orders.v1`, which has the same key.
  - The datasource URL `jdbc:mysql://db-host.internal:3306/acme-orders?…` gives `x:db:mysql:acme-orders` (host and parameters left out), and so does the script's `CREATE DATABASE acme_orders_db`.
- **Views** (`src/viewer/`):
  - Runtime (§6): `http-call` crosses the network like tRPC; a publish goes to a topic lifeline and on to each subscriber as a dashed delivery; a class's constructor and lifecycle hooks (`ngOnInit`) run with it; a controller's scenario starts at its handlers.
  - Context (§3): databases by engine, topics as the message broker, and JVM and Go packages in the catalog.
  - The dependency graph shared by all views links a topic's subscribers to its publishers, so §5 by service shows event coupling.
  - Topics and databases (`infra`) are shown without the packages toggle; a hide glob matches an outside node by id (`x:*`).
  - The inspector says what an outside node is and lists who publishes, subscribes, queries or declares it.
  - Source preview highlighting for Kotlin, Go, YAML, shell, SQL, HTML, SCSS, Dockerfiles.
  - A system's saved views (Frontend, Backend, System) are its own, kept with its other results.
- **What the matching misses:**
  - requests whose URL arrives as data (P2);
  - requests no service has a handler for;
  - a path ending in a segment only known at run time where the handler has a literal;
  - which of two services serving the same path a request means, when a gateway tells them apart by a prefix the request doesn't show: it reaches both.
- **The runtime path** of a page goes from its `ngOnInit` through the action it
  dispatches, the effect, the service's request, across the network into the
  Kotlin controller, the services and repositories, to the table. The event a
  write publishes may not be on that path: when command handlers reach the
  event bus through a fluent builder in a library, a declared-type reader can't
  follow its generic steps. The events still show as the System view's links
  and in each topic's inspector (publishers, subscribers).

## P5: the Go reader and the infrastructure reader

### Go

- **Code:** `src/analyzer/go/`, the same two passes as the Kotlin reader:
  - `decls.ts`, pass A: functions, types (struct, interface, other), struct fields (embedded ones too) and interface methods as members, constants and variables, string constants' values.
  - `index.ts`: a package is a directory (its `_test` package apart), its module the nearest go.mod. Import paths map to directories under the module path; the rest are outside packages (`x:go:net/http` by full path, others by repository: three segments, or up to a `.git` one). Types resolve through pointers and aliases; members include methods from every file of the package and those promoted from embedded structs.
  - `link.ts`, pass B: references, calls, composite literals (`instantiates`), type refs. Values follow their declared types: parameters, receivers, `x := NewT()` (the function's declared result), fields (`s.store.Save()`), embedded structs.
  - `frameworks.ts`: HTTP handlers and requests (`http` facts, `http:GET /path` tags) and Kafka subscribe, publish and declare (`messaging` facts). The heuristics are in its header comment.
  - `analyzer.ts`: the passes' cache (`<out>/cache/go.json`). Pass B is keyed by the file and the surfaces of the packages it can see (its own and the transitive imports), so editing a body re-links one file. Interface satisfaction is computed from the index on every run.
- **Decisions:**
  - A method declared in another file than its type is a symbol of its own file, `Type.method`, since a member must live in its type's file. The index joins it to the type, and dead-export checks judge it with the type. In the fixture, `memoryStore.Find` lives in `order/memory_find.go`.
  - `implements` is structural: a type's method set (own and promoted) covers a project interface's methods, matched by name and by the number of parameters and results. Only within a module, or into a module its go.mod requires. In the fixture, `memoryStore` implements `order.Store` with `Save` from one file and `Find` from another, and `messaging.Publisher` implements `order.Events`.
  - Kafka topics given as a configuration selector chain become properties. The root variable is dropped, and a struct's place in the configuration tree is put in front: in the fixture, `props.Topic.Orders.Name`, with `props` a `KafkaProperties` that `Configuration.Kafka` holds, gives `kafka.topic.orders.name`, which `resources/application.yml` sets to `shop.orders`.
  - Copies of one module in several folders (vendored or license-report copies, each with its own go.mod) resolve to the nearest one.
- **In the fixture:** gin routes under `router.Group("/v1")` are tagged `http:GET /v1/orders/{id}` and `http:POST /v1/orders`, `http.HandleFunc` gives `http:ANY /health`; `messaging/consumer.go` subscribes `x:kafka:shop.orders`, `main.go` publishes `x:kafka:shop.orders.shipped`.
- **Not followed:**
  - generic type arguments: a value typed by a type parameter gets no edges;
  - function values passed around and called later;
  - chi's `Route` closures and gorilla's `PathPrefix(…).Subrouter()` prefixes;
  - methods an embedded outside type provides (they can't complete an interface);
  - build constraints: every file of a directory is read together.

### Infrastructure

- **Code:** `src/analyzer/infra/` is a LanguageAnalyzer (`config`) for YAML, Helm templates, shell scripts, SQL and Dockerfiles, in the root and the mounts:
  - `analyzer.ts`: what a file is (`classify`: a chart, values, a template, compose, application config, a manifest …), pass A per file cached by hash (`<out>/cache/config.json`), pass B every run.
  - `k8s.ts`: a symbol per resource (`Deployment/api`), and what it names: Ingress backends, selectors by labels, ConfigMaps, Secrets, claims and service accounts a workload uses, role bindings.
  - `helm.ts` + `link.ts`: templates rendered leniently with `.Chart` and the chart's `values.yaml`; a line that only includes a library chart's named template renders its resources in the including file. Names are resolved nearest first in the folder tree.
  - `shell.ts`, `sql.ts`, `dockerfile.ts`, `yaml.ts`: the other readers. Scripts follow `cd`; manifests in `kubectl apply -f -` heredocs count.
  - The reader only runs when the project has infrastructure: a project with only an `application.yml` doesn't run it.
- **Facts:** `kafka-topics --create --topic` and Strimzi `KafkaTopic`s are `messaging` declares; `CREATE DATABASE` in a client's heredoc, SQL files and Bitnami values (`auth.database(s)`) are `datastore` declares. A Deployment or StatefulSet running a database image declares its server (name `''`).
- **Secrets are never read:** folders named `secrets` or `certificates`, key and certificate files, `credentials*`, `.env*` and SOPS-encrypted files are skipped, and no value of a variable, an environment entry or a Secret reaches a signature or a fact.
- **Pulumi:** a folder in `tsconfig` is a light project (all its files, packages not loaded). A Pulumi project's own tsconfig lists only `index.ts`, and loading it pulls in the cloud provider's package (`@pulumi/azure-native`: tens of thousands of declaration files, seconds and gigabytes apiece), so the folder is one light project instead (`fixtures/infra-root` lists `infra/pulumi/`). `plugins/pulumi.ts` tags the code constructing a resource with its type (`pulumi:azure-native:resources:ResourceGroup`), from syntax and imports.
- **In the fixtures** (`fixtures/infra-root` with `fixtures/infra-mount` as `infra/`):
  - `infra/up.sh` runs `kafka/create-topics.sh` and `mysql/create-databases.sh` (`cd` followed) and uses the values files it passes to `helm` and `kubectl`.
  - `create-topics.sh` declares `x:kafka:acme.orders`; `create-databases.sh` declares `x:db:mysql:acme-orders` and `x:db:postgres:acme-reports`; the MongoDB chart's values declare `x:db:mongodb:acme-orders`.
  - The orders chart's `app.yaml` only includes the library chart's `common.deployment` and `common.service`, so their resources render in it.
- **Not read:** topics a helper function creates from its arguments (the fixture's `create_compacted "acme.$ENV.customers"`), topic names written to a secret store for the services, compose `CREATE DATABASE` in an entrypoint string (local databases; left out so the declared names stay the provisioning script's), Helm `tpl`/`range` output beyond the first pass, `.Release.Name`, values files other than `values.yaml` when rendering, Go templates outside `templates/`, Kustomize overlays.
