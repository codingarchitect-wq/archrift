import { Component } from '@angular/core'

@Component({
  selector: 'app-header',
  template: `
    <nav>
      <a [routerLink]="['/projects', 'list']">Projects</a>
      <span appHighlight [class.active]="open">{{ title | shout }}</span>
      <a routerLink="/admin/users">Users</a>
    </nav>
  `,
})
export class HeaderComponent {
  title = 'Planner'
  open = false
}
