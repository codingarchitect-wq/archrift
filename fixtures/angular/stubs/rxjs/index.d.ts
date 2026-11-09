// Just enough of rxjs for the fixture to type-check.
export declare class Observable<T> {
  pipe(...operators: ((source: Observable<any>) => Observable<any>)[]): Observable<any>
  readonly value: T
}
export declare function of<T>(...values: T[]): Observable<T>
