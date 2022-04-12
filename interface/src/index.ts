import yargs from 'yargs/yargs'
import { config } from 'dotenv'
import { ethers } from 'ethers'
import { abi as NonfungiblePositionManagerABI }
    from '@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json'

// Read our .env file
config()

// Uniswap v3 positions NFT
export const ADDR_POSITIONS_NFT = '0xc36442b4a4522e871399cd717abdd847ab11fe88'

// Data required for calculating the APY% of a given position:
// * Time position was open in days (from timestamp of add and remove txs)
// * Opening liquidity (in WETH and USDC, from add tx logs)
// * Fees claimed (in WETH and USDC, from remove tx logs)

// Design
// 1. From Etherscan Provider, get all transactions for this address
// 2. For each tx, get block number
// 3. From Etherscan Ethers provider, for each block number, get all tx logs for these blocks only
// 4. Use analytics-positions code to build Position instance
// 5. Get all token IDs for this account from Uniswap position manager contract
// 6. Filter Position instances to those that are in set of our own token IDs
// 7. Calc APY% from that set of Position instances

async function main() {
  const argv = yargs(process.argv.slice(2)).options({
    address: { type: 'string' },
  }).parseSync()

  if (argv.address === undefined) {
    console.log('Missing --address arg')
    process.exit(1)
  }

  const address = argv.address

  if (process.env.ETHERSCAN_API_KEY === undefined) {
    console.log('Missing ETHERSCAN_API_KEY from .env file, or .env file itself')
    process.exit(1)
  }

  const PROVIDER = new ethers.providers.EtherscanProvider(undefined, process.env.ETHERSCAN_API_KEY)

  const positionManagerContract = new ethers.Contract(
    ADDR_POSITIONS_NFT,
    NonfungiblePositionManagerABI,
    PROVIDER
  )

  // This count includes all the closed positions.
  const positionCount = await positionManagerContract.balanceOf(address)

  console.log(`This account has ${positionCount} positions (closed and open)`)

  const ownTokenIds = Array<number>()

  for (let i = 0; i < positionCount; i++) {
    const tokenId = await positionManagerContract.tokenOfOwnerByIndex(address, i)
    ownTokenIds.push(tokenId)
  }

  console.log(`This account has ${ownTokenIds.length} token IDs (closed and open)`)

  // const PROVIDER_ALCHEMY = new ethers.providers.AlchemyProvider(undefined, 'NJhHpafwsqTku1zBNDC0N61Q1mTvYjVU')

  // This is all our transactions, not just add and remove transactions but swaps and unwrapping WETH to ETH.
  const history = await PROVIDER.getHistory(address)

  console.log(`Transactions from this address: ${history.length}`)

  const blockNumbers = Array<number>()

  history.forEach(function(value: ethers.providers.TransactionResponse, index: number,
    array: ethers.providers.TransactionResponse[]) {
    // console.log(`Index: ${index}, block number: ${value.blockNumber}`)

    if (value.blockNumber === undefined) return

    blockNumbers.push(value.blockNumber)
  })

  console.log(`Blocks: ${blockNumbers.length}`)

  blockNumbers.forEach(async function(blockNumber: number, index: number, array: number[]) {
    // This is all logs for the pool in blocks in which we transacted, not just our logs.
    const filter = {
      address: ADDR_POSITIONS_NFT,
      fromBlock: blockNumber, // remove TX
      toBlock: blockNumber
    }
  
    const logs = await PROVIDER.getLogs(filter)

    if (logs.length === 0) {
      return
    }
  
    console.log(`Positions NFT logs for block ${blockNumber}:`)
    console.log(JSON.stringify(logs))
  })
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
