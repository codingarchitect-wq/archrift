// Just enough of @angular/core for the fixture to type-check.
export declare function Component(config: { selector?: string; template?: string; templateUrl?: string }): ClassDecorator
export declare function Directive(config: { selector: string }): ClassDecorator
export declare function Pipe(config: { name: string }): ClassDecorator
export declare function Injectable(config?: { providedIn?: 'root' }): ClassDecorator
export declare function NgModule(config: { imports?: unknown[]; declarations?: unknown[]; bootstrap?: unknown[] }): ClassDecorator
export interface PipeTransform {
  transform(value: unknown, ...args: unknown[]): unknown
}
