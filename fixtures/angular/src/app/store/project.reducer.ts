import { Action } from '@ngrx/store'
import { ProjectActionEnum, REQUEST_PROJECTS, REQUEST_PROJECTS_FULFILLED } from './project.actions'

export interface ProjectState {
  loading: boolean
}

export function projectReducer(state: ProjectState = { loading: false }, action: Action): ProjectState {
  switch (action.type) {
    case REQUEST_PROJECTS:
      return { ...state, loading: true }
    case REQUEST_PROJECTS_FULFILLED:
      return { ...state, loading: false }
    case ProjectActionEnum.Select:
    case ProjectActionEnum.Clear:
      return state
    default:
      return state
  }
}

const SPINNER = 'SPINNER'

// a switch on some other `type`: not an action, no subscription
export function label(item: { type: string }): string {
  switch (item.type) {
    case SPINNER:
      return '…'
    default:
      return item.type
  }
}
