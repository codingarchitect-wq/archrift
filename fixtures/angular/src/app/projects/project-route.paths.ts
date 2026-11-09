import { ROUTE_PARAM_PROJECT_ID } from './route-params'

// typed `any`, as route path tables often are: the checker knows no properties, the literal does
export const PROJECT_ROUTE_PATHS: any = {
  projects: 'projects',
  list: 'list',
  projectId: `:${ROUTE_PARAM_PROJECT_ID}`,
}
