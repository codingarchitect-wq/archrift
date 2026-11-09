import { NgModule } from '@angular/core'
import { RouterModule } from '@angular/router'
import { ProjectCardComponent } from './project-card.component'
import { ProjectDetailComponent } from './project-detail.component'
import { ProjectListComponent } from './project-list.component'
import { PROJECT_ROUTES } from './projects.routes'
import { ProjectsComponent } from './projects.component'
import { TaskListComponent } from './task-list.component'

@NgModule({
  imports: [RouterModule.forChild(PROJECT_ROUTES)],
  declarations: [ProjectsComponent, ProjectListComponent, ProjectCardComponent, ProjectDetailComponent, TaskListComponent],
})
export class ProjectsModule {}
