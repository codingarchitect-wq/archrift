import { ApiUrlBuilder } from './api-url.builder'

/** The API's base URL, only known at run time. */
export function apiUrl(): string {
  return (globalThis as { API_URL?: string }).API_URL ?? ''
}

export class ApiUrlHelper {
  constructor(private readonly version: string = 'v1') {}

  withPath(path: string): ApiUrlBuilder {
    return ApiUrlBuilder.withBasePath(`${apiUrl()}/${this.version}`).withPath(path)
  }
}
