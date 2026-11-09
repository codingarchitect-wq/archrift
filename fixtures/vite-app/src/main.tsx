import { App } from './App'

export function start(root: { render(node: unknown): void }) {
  root.render(<App />)
}
