// The `http` fact channel (docs/POLYGLOT.md): requests the code makes and the
// handlers that serve them, recorded by any language's plugins and matched
// into `http-call` edges when the graph is assembled (plugins/http.ts).

/**
 * A path as segments joined by `/`, starting with `/`; a part only known at
 * run time is `{}` (`/v5/projects/{}/tasks`). A handler keeps its variable
 * names (`/projects/{projectId}`): they count as `{}` when matching.
 */
export type HttpPath = string

/** A request the code makes (Angular's HttpClient, a Kotlin WebClient …). */
export interface HttpRequestFact {
  type: 'request'
  /** The symbol or member making it. */
  owner: string
  /** GET, POST, PUT, PATCH, DELETE …, or * when the code doesn't say. */
  method: string
  path: HttpPath
  site: [number, number]
}

/** A handler the code serves (a Spring @GetMapping method, a Go http.HandleFunc …). */
export interface HttpHandlerFact {
  type: 'handler'
  /** The symbol or member handling it. */
  owner: string
  /** GET, POST …, or * for every method. */
  method: string
  path: HttpPath
  site: [number, number]
}

export type HttpFact = HttpRequestFact | HttpHandlerFact
