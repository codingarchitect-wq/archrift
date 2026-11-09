import { Routes } from '@angular/router'
import { AdminUsersComponent } from './admin-users.component'
import { AdminComponent } from './admin.component'

// loaded lazily under /admin
export const ADMIN_ROUTES: Routes = [{ path: '', component: AdminComponent, children: [{ path: 'users', component: AdminUsersComponent }] }]
