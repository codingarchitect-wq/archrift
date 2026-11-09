import { Routes } from '@angular/router'
import { HelpComponent } from './shared/help.component'
import { NotFoundComponent } from './shared/not-found.component'

export const HELP_OUTLET = 'side'

export const APP_ROUTES: Routes = [
  { path: '', redirectTo: 'projects', pathMatch: 'full' },
  { path: 'admin', loadChildren: () => import('./admin/admin.module').then(m => m.AdminModule) },
  { path: 'help', component: HelpComponent, outlet: HELP_OUTLET },
  { path: '**', component: NotFoundComponent },
]
