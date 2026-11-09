import { HttpClient } from '@angular/common/http'
import { Injectable } from '@angular/core'
import { Observable } from 'rxjs'
import { ApiUrlHelper, apiUrl } from '../shared/api-url.helper'
import { ApiVersions } from '../shared/api-versions.enum'

export interface Project {
  id: string
  name: string
}

@Injectable({ providedIn: 'root' })
export class ProjectService {
  private readonly urls = new ApiUrlHelper(ApiVersions.Project)

  constructor(private readonly http: HttpClient) {}

  findOne(id: string): Observable<Project> {
    const url = this.urls.withPath(`projects/${id}`).build()
    return this.http.get<Project>(url)
  }

  findAll(page: number): Observable<Project[]> {
    const url = this.urls.withPath('projects').withQueryParam('page', page).build()
    return this.http.get<Project[]>(url)
  }

  create(project: Project): Observable<Project> {
    return this.http.post<Project>(this.urls.withPath('projects').build(), project)
  }

  remove(id: string): Observable<void> {
    return this.http.request<void>('delete', this.urls.withPath('projects/' + id).build())
  }

  health(): Observable<string> {
    return this.http.get<string>(`${apiUrl()}/health?verbose=true`)
  }

  download(url: string): Observable<Blob> {
    return this.http.get<Blob>(url)
  }
}
