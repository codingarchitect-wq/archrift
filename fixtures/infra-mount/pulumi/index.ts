import * as azure from '@pulumi/azure-native'
import { storage } from '@pulumi/azure-native'
import * as pulumi from '@pulumi/pulumi'
import { region } from './config'

export function createGroup() {
  const config = new pulumi.Config()
  const group = new azure.resources.ResourceGroup(`rg-${config.require('env')}`, { location: region })
  new storage.StorageAccount('data', { resourceGroupName: group.name })
  return group
}
