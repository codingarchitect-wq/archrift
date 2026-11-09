// Just enough of @angular/router for the fixture to type-check.
export interface Route {
  path?: string
  pathMatch?: 'full' | 'prefix'
  component?: unknown
  redirectTo?: string
  outlet?: string
  children?: Route[]
  loadChildren?: () => Promise<unknown>
}
export type Routes = Route[]
export declare class RouterModule {
  static forRoot(routes: Routes): RouterModule
  static forChild(routes: Routes): RouterModule
}
export declare class Router {
  navigate(commands: unknown[], extras?: { relativeTo?: unknown }): Promise<boolean>
  navigateByUrl(url: string): Promise<boolean>
}
