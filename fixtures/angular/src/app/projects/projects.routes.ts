import { Routes } from '@angular/router'
import { ProjectDetailComponent } from './project-detail.component'
import { ProjectListComponent } from './project-list.component'
import { PROJECT_ROUTE_PATHS } from './project-route.paths'
import { ProjectsComponent } from './projects.component'
import { TASK_ROUTES } from './tasks.routes'

export const PROJECT_ROUTES: Routes = [
  {
    path: PROJECT_ROUTE_PATHS.projects,
    component: ProjectsComponent,
    children: [
      { path: '', redirectTo: PROJECT_ROUTE_PATHS.list, pathMatch: 'full' },
      { path: PROJECT_ROUTE_PATHS.list, component: ProjectListComponent },
      { path: PROJECT_ROUTE_PATHS.projectId, component: ProjectDetailComponent, children: [...TASK_ROUTES] },
    ],
  },
]
