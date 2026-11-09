import { Component } from '@angular/core'

@Component({ selector: 'app-project-card', template: `<a [routerLink]="['/projects', project.id]">{{ project.name }}</a>` })
export class ProjectCardComponent {
  project = { id: '', name: '' }
}
