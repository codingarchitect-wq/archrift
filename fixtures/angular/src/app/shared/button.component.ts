import { Component } from '@angular/core'

@Component({ selector: 'button[app-button], a[app-button]', template: '<ng-content></ng-content>' })
export class ButtonComponent {}
