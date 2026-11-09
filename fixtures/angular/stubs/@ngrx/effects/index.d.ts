// Just enough of @ngrx/effects for the fixture to type-check.
import type { Action } from '@ngrx/store'
import type { Observable } from 'rxjs'

export declare class Actions extends Observable<Action> {}
export declare function createEffect(source: () => Observable<unknown>): Observable<unknown>
export declare function ofType(...types: unknown[]): (source: Observable<Action>) => Observable<Action>
