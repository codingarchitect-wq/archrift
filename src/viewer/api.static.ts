// The exported page's side of the API seam (see api.ts): the static build
// (vite.static.ts) puts this module where api.ts would be. The calls are
// answered from the data the page carries (static/backend.ts).
import type { Api } from './api.ts'
import { createStaticApi } from './static/backend.ts'
import { openAtStart, pagePart, readExport } from './static/embedded.ts'

const page = readExport(pagePart(document))
// before the store reads the link: the view chosen at export is where the page opens
openAtStart(page.meta.start)

export const api: Api = createStaticApi(page.data)
