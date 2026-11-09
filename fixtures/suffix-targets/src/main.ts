import './styles.css'
import { platform } from '@/platform'
import { Client } from '@/generated/client'
import data from './data.json'

export function start() {
  const worker = new Worker(new URL('./compute.worker.ts', import.meta.url))
  return [platform.open('x'), new Client(), data.version, worker]
}
