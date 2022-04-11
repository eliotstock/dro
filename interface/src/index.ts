import yargs from 'yargs/yargs'
import { ethers } from 'ethers'

async function main() {
  const argv = yargs(process.argv.slice(2)).options({
    address: { type: 'string' },
  }).parseSync()

  if (argv.address === undefined) {
    console.log('Missing --address arg')
    process.exit(1)
  }

  const address = argv.address

  const PROVIDER = new ethers.providers.EtherscanProvider()

  const history = await PROVIDER.getHistory(address)

  console.log(`Transactions: ${history.length}`)

  history.forEach(function(value: ethers.providers.TransactionResponse, index: number, array: ethers.providers.TransactionResponse[]) {
    console.log(`Index: ${index}, value: ${JSON.stringify(value)}`)
  })
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
