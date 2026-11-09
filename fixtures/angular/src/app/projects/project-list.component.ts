import { Component } from '@angular/core'
import { Store } from '@ngrx/store'
import { ClearSelection, ProjectActions, SelectProject } from '../store/project.actions'
import { toggleSidebar } from '../store/ui.actions'

@Component({ selector: 'app-project-list', templateUrl: './project-list.component.html' })
export class ProjectListComponent {
  projects: { id: string; name: string }[] = []

  constructor(private readonly store: Store<unknown>) {}

  load(): void {
    this.store.dispatch(new ProjectActions.Request())
  }

  select(id: string): void {
    const action = new SelectProject(id)
    this.store.dispatch(action)
  }

  toggle(): void {
    this.store.dispatch(toggleSidebar())
  }

  clear(): void {
    this.store.dispatch(new ClearSelection())
  }
}
