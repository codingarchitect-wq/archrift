import { Injectable } from '@angular/core'
import { Actions, createEffect, ofType } from '@ngrx/effects'
import { map, switchMap } from 'rxjs/operators'
import { ProjectService } from '../projects/project.service'
import { ProjectActionEnum, ProjectActions, REQUEST_PROJECTS } from './project.actions'
import { toggleSidebar } from './ui.actions'

@Injectable()
export class ProjectEffects {
  requestAll$ = createEffect(() =>
    this.actions$.pipe(
      ofType(REQUEST_PROJECTS),
      switchMap(() => this.service.findAll(0).pipe(map(list => new ProjectActions.RequestFulfilled(list)))),
    ),
  )

  select$ = createEffect(() => this.actions$.pipe(ofType(ProjectActionEnum.Select), map(() => toggleSidebar())))

  constructor(
    private readonly actions$: Actions,
    private readonly service: ProjectService,
  ) {}
}
