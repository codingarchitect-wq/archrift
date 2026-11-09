import { Action } from '@ngrx/store'
import { Project } from '../projects/project.service'

export const REQUEST_PROJECTS = 'REQUEST_PROJECTS'
export const REQUEST_PROJECTS_FULFILLED = 'REQUEST_PROJECTS_FULFILLED'

export enum ProjectActionEnum {
  Select = '[Projects] Select',
  Clear = '[Projects] Clear',
  Unused = '[Projects] Unused',
}

export namespace ProjectActions {
  export class Request implements Action {
    type = REQUEST_PROJECTS
  }

  export class RequestFulfilled implements Action {
    type = REQUEST_PROJECTS_FULFILLED

    constructor(public payload: Project[]) {}
  }
}

export class SelectProject implements Action {
  readonly type = ProjectActionEnum.Select

  constructor(public id: string) {}
}

// no `implements Action`, as happens: being dispatched shows it is one
export class ClearSelection {
  readonly type = ProjectActionEnum.Clear
}
