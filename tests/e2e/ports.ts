// Where the e2e servers listen (playwright.config.ts starts them): from
// ARCHRIFT_E2E_PORT (default 4301) up, so several checkouts can run their
// suites at the same time on different bases.
export const BASE_PORT = Number(process.env.ARCHRIFT_E2E_PORT ?? 4301)

/** Offsets from the base port, one per server. */
export const SERVERS = { plainTs: 0, fullstack: 4, history: 5, watch: 6, projects: 7, kotlin: 8, ask: 12 } as const

export const serverUrl = (server: keyof typeof SERVERS) => `http://127.0.0.1:${BASE_PORT + SERVERS[server]}/`
