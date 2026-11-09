import { CloudService } from '../../../client/service'
import { useRouter } from '../../../lib/fake-libs'

export default function Accounts() {
  const router = useRouter()
  const open = (id: string) => router.push(`/accounts/${id}`)
  new CloudService().getAccounts()
  return <button onClick={() => { router.push('/accounts/42'); open('x') }}>First</button>
}
