import { Pipe, PipeTransform } from '@angular/core'

@Pipe({ name: 'shout' })
export class ShoutPipe implements PipeTransform {
  transform(value: unknown): string {
    return String(value).toUpperCase()
  }
}
