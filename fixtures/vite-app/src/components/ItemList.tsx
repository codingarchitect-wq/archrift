import { Button } from '@/components/ui/button'
import { formatAmount } from '@/lib/format'

export function ItemList({ items }: { items: { id: string; amount: number }[] }) {
  if (!items.length) return <p>Nothing yet</p>
  return (
    <ul>
      {items.map(i => (
        <li key={i.id}>
          {formatAmount(i.amount)} <Button>Open</Button>
        </li>
      ))}
    </ul>
  )
}
