import { Component } from '@angular/core'

// a stub with the real card's selector: tests render it, the app never does
@Component({ selector: 'app-project-card', template: '' })
class ProjectCardStubComponent {}

@Component({ selector: 'app-test-host', template: '<app-project-card></app-project-card><app-project-list></app-project-list>' })
class TestHostComponent {}

export const declarations = [ProjectCardStubComponent, TestHostComponent]
