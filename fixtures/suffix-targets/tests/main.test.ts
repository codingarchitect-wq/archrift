declare const vi: { mock(path: string): void }
vi.mock('@/platform')
import { start } from '../src/main'

start()
