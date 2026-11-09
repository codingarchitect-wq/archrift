import { Button } from './Button'
import { useCounter } from './useCounter'

export const Panel = ({ title }: { title: string }) => {
  const counter = useCounter()
  return (
    <section>
      <h1>{title}</h1>
      <Button label="+" onClick={counter.inc} />
    </section>
  )
}

export default function Page() {
  return <Panel title="Hi" />
}
