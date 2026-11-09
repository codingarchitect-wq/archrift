import { Link } from '../lib/fake-libs'
import { useTheme } from '../ui/ThemeContext'

export default function Home() {
  const theme = useTheme()
  return (
    <main className={theme}>
      <Link href="/accounts">Accounts</Link>
      <Link href="/nowhere">Missing</Link>
    </main>
  )
}
