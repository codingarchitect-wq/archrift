// Just enough of rxjs/operators for the fixture to type-check.
import type { Observable } from 'rxjs'

export declare function map<T, R>(project: (value: T) => R): (source: Observable<T>) => Observable<R>
export declare function switchMap<T, R>(project: (value: T) => Observable<R>): (source: Observable<T>) => Observable<R>
