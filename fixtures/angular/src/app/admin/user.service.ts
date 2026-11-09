import { HttpClient } from '@angular/common/http'
import { Injectable } from '@angular/core'
import { Observable } from 'rxjs'
import { ApiUrlHelper } from '../shared/api-url.helper'

@Injectable({ providedIn: 'root' })
export class UserService {
  // no version given: the helper's default
  private readonly urls = new ApiUrlHelper()

  constructor(private readonly http: HttpClient) {}

  findAll(): Observable<string[]> {
    return this.http.get<string[]>(this.urls.withPath('users').build())
  }
}
