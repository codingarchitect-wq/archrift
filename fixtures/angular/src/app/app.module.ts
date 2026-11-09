import { NgModule } from '@angular/core'
import { RouterModule } from '@angular/router'
import { AppComponent } from './app.component'
import { APP_ROUTES } from './app.routes'
import { ProjectsModule } from './projects/projects.module'
import { ButtonComponent } from './shared/button.component'
import { HeaderComponent } from './shared/header.component'
import { HighlightDirective } from './shared/highlight.directive'
import { ShoutPipe } from './shared/shout.pipe'

@NgModule({
  imports: [RouterModule.forRoot(APP_ROUTES), ProjectsModule],
  declarations: [AppComponent, ButtonComponent, HeaderComponent, HighlightDirective, ShoutPipe],
  bootstrap: [AppComponent],
})
export class AppModule {}
