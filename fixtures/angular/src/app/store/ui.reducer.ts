import { createReducer, on } from '@ngrx/store'
import { toggleSidebar } from './ui.actions'

export const uiReducer = createReducer(
  { sidebar: false },
  on(toggleSidebar, (state: { sidebar: boolean }) => ({ sidebar: !state.sidebar })),
)
