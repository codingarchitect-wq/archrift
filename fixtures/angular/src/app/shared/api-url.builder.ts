export class ApiUrlBuilder {
  private path = ''
  private readonly query = new Map<string, string | number>()

  constructor(private readonly base: string) {}

  static withBasePath(base: string): ApiUrlBuilder {
    return new ApiUrlBuilder(base)
  }

  withPath(path: string): ApiUrlBuilder {
    this.path = path
    return this
  }

  withQueryParam(name: string, value: string | number): ApiUrlBuilder {
    this.query.set(name, value)
    return this
  }

  build(): string {
    const query = [...this.query].map(([k, v]) => `${k}=${v}`).join('&')
    return `${this.base}/${this.path}${query ? `?${query}` : ''}`
  }
}
