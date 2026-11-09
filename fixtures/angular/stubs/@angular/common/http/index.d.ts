// Just enough of @angular/common/http for the fixture to type-check.
import type { Observable } from 'rxjs'

export declare class HttpClient {
  get<T>(url: string, options?: unknown): Observable<T>
  post<T>(url: string, body: unknown, options?: unknown): Observable<T>
  put<T>(url: string, body: unknown, options?: unknown): Observable<T>
  delete<T>(url: string, options?: unknown): Observable<T>
  request<T>(method: string, url: string, options?: unknown): Observable<T>
}
