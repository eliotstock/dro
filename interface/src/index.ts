import yargs from 'yargs/yargs'
import { config } from 'dotenv'
import { BigNumber, ethers } from 'ethers'
import { abi as NonfungiblePositionManagerABI }
    from '@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json'
import { Log, TransactionReceipt, TransactionResponse } from '@ethersproject/abstract-provider'
import { AlchemyProvider, EtherscanProvider } from '@ethersproject/providers'

// Read our .env file
config()

// Uniswap v3 positions NFT
export const ADDR_POSITIONS_NFT = '0xc36442b4a4522e871399cd717abdd847ab11fe88'

// Data required for calculating the APY% of a given position:
// * Time position was open in days (from timestamp of add and remove txs)
// * Opening liquidity (in WETH and USDC, from add tx logs)
// * Fees claimed (in WETH and USDC, from remove tx logs)
// * Gas cost (in WETH and in USDC terms) from add, remove and swap txs
// * Price history, to get from ETH gas costs to USD gas costs

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

  console.log(`Address: ${address}`)

  if (process.env.ETHERSCAN_API_KEY === undefined) {
    console.log('Missing ETHERSCAN_API_KEY from .env file, or .env file itself')
    process.exit(1)
  }

  const PROVIDER = new EtherscanProvider(undefined, process.env.ETHERSCAN_API_KEY)
  const PROVIDER_ALCHEMY = new AlchemyProvider(undefined, 'NJhHpafwsqTku1zBNDC0N61Q1mTvYjVU')

  const positionManagerContract = new ethers.Contract(
    ADDR_POSITIONS_NFT,
    NonfungiblePositionManagerABI,
    PROVIDER
  )

  // This count includes all the closed positions.
  const positionCount = await positionManagerContract.balanceOf(address)

  console.log(`Positions (closed and open): ${positionCount}. Token IDs:`)

  const ownTokenIds = Array<number>()

  for (let i = 0; i < positionCount; i++) {
    const tokenId = await positionManagerContract.tokenOfOwnerByIndex(address, i)
    ownTokenIds.push(tokenId)

    console.log(`  ${tokenId}`)
  }

  if (ownTokenIds.length != positionCount) {
    throw `This account has ${positionCount} positions but ${ownTokenIds.length} token IDs. Fatal.`
  }

  // This is all our transactions, not just add and remove transactions but swaps and unwrapping WETH to ETH.
  const history = await PROVIDER.getHistory(address)

  console.log(`Transactions from this address: ${history.length}`)

  const blockNumbers = Array<number>()

  history.forEach(async function(txResponse: TransactionResponse) {
    // console.log(`Index: ${index}, block number: ${txResponse.blockNumber}`)

    if (txResponse.blockNumber === undefined) return

    blockNumbers.push(txResponse.blockNumber)

    // console.log(`txResponse:`)
    // console.dir(txResponse)
    console.log(`Etherscan link to TX, txReceipt.gasUsed, txReceipt.effectiveGasPrice`)

    try {
      // Wait for zero confirmations since these are old blocks anyway.
      // const txReceipt: TransactionReceipt = await txResponse.wait()
      const txReceipt: TransactionReceipt = await PROVIDER.getTransactionReceipt(txResponse.hash)

      // Note that neither of these are actually large integers.

      // Corresponds to "Gas Used by Transaction" on Etherscan.
      const gasUsed = txReceipt.gasUsed.toBigInt()

      // txReceipt.cumulativeGasUsed: No idea what this is. Ignore it.

      // Corresponds to "Gas Price Paid" on Etherscan. Quoted in wei, typically about 0.66 gwei for Arbitrum.
      const effectiveGasPrice: BigNumber = txReceipt.effectiveGasPrice
      // const gasPrice = txResponse.gasPrice

      // if (gasPrice === undefined) {
      //   console.log(`  Gas used: ${txReceipt.gasUsed} at unknown price`)
      // }
      // else {
      //   // TODO: Why is this often 100_000_000_000 wei?
      //   // When it's not, typical: 28_127_082_756 (28 gwei)
      //   console.log(`  Gas used: ${txReceipt.gasUsed} at price: ${gasPrice} wei`)
      // }
      console.log(`https://etherscan.io/tx/${txResponse.hash}, ${txReceipt.gasUsed}, ${txReceipt.effectiveGasPrice}`)
    }
    catch (e) {
      // Probably 'TypeError: txResponse.wait is not a function'
      console.log(`Can't get transaction receipt for tx ${txResponse.hash}.`)
    }
  })

  // console.log(`Blocks: ${blockNumbers.length}`)

  // blockNumbers.forEach(async function(blockNumber: number) {
  //   // This is all logs for the pool in blocks in which we transacted, not just our logs.
  //   const filter = {
  //     address: ADDR_POSITIONS_NFT,
  //     fromBlock: blockNumber, // remove TX
  //     toBlock: blockNumber
  //   }
  
  //   const logs: Array<Log> = await PROVIDER.getLogs(filter)

  //   if (logs.length === 0) {
  //     return
  //   }
  
  //   console.log(`Positions NFT logs for block ${blockNumber}:`)

  //   logs.forEach(function(log: Log, index: number) {
  //     console.log(`${index}. data: ${log.data}`)
  //     console.log(`  topics:`)

  //     log.topics.forEach(function(topic: string, index: number, array: string[]) {
  //       console.log(`  ${topic}`)
  //     })
  //   })
  // })
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
