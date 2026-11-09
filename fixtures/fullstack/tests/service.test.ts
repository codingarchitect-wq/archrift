import { CloudService } from '../src/client/service'
import { localAccounts } from '../src/local/service'

new CloudService().getAccounts()
localAccounts()
