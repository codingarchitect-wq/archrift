import { angular } from './angular.ts'
import { datastores } from './datastores.ts'
import { dexie } from './dexie.ts'
import { http } from './http.ts'
import { messaging } from './messaging.ts'
import { nextjs } from './nextjs.ts'
import { ngrx } from './ngrx.ts'
import { prisma } from './prisma.ts'
import { pulumi } from './pulumi.ts'
import { react } from './react.ts'
import { schemas } from './schemas.ts'
import { tests } from './tests.ts'
import { trpc } from './trpc.ts'
import type { Plugin } from './types.ts'

/**
 * Every plugin runs; each only finds something where its framework is used. Order matters for
 * assembly: the frameworks', then the links between the parts (http, messaging, datastores), the
 * schemas (which link to the databases datastores made), tests last.
 */
export const PLUGINS: Plugin[] = [trpc, prisma, dexie, react, nextjs, angular, ngrx, pulumi, http, messaging, datastores, schemas, tests]
