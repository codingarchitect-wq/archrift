import { ItemList } from '@/components/ItemList'
import { useItems } from '@/hooks/useItems'

export function Home() {
  const items = useItems()
  return <ItemList items={items} />
}
