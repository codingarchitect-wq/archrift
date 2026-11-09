import { Component } from '@angular/core'
import { Router } from '@angular/router'
import { PROJECT_ROUTE_PATHS } from './project-route.paths'

@Component({ selector: 'app-project-detail', template: '<router-outlet></router-outlet>' })
export class ProjectDetailComponent {
  constructor(private readonly router: Router) {}

  openTasks(id: string): void {
    this.router.navigate(['/projects', id, 'tasks'])
  }

  back(): void {
    this.router.navigateByUrl(`/${PROJECT_ROUTE_PATHS.projects}/${PROJECT_ROUTE_PATHS.list}`)
  }
}
