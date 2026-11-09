// Just enough of @ngrx/store for the fixture to type-check.
export interface Action {
  type: string
}
export declare class Store<T> {
  dispatch(action: Action): void
  readonly state: T
}
export declare function createAction<T extends string>(type: T): () => { type: T }
export declare function createReducer<S>(initial: S, ...ons: unknown[]): (state: S | undefined, action: Action) => S
export declare function on<S>(...args: [...creators: unknown[], reducer: (state: S) => S]): unknown
