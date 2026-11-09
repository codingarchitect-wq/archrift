import { NgModule } from '@angular/core'
import { RouterModule } from '@angular/router'
import { AdminUsersComponent } from './admin-users.component'
import { AdminComponent } from './admin.component'
import { ADMIN_ROUTES } from './admin.routes'

@NgModule({
  imports: [RouterModule.forChild(ADMIN_ROUTES)],
  declarations: [AdminComponent, AdminUsersComponent],
})
export class AdminModule {}
