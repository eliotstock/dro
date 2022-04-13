import yargs from 'yargs/yargs'
import { config } from 'dotenv'
import { BigNumber, ethers } from 'ethers'
import { abi as NonfungiblePositionManagerABI }
    from '@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json'
import { Log, TransactionReceipt, TransactionResponse } from '@ethersproject/abstract-provider'
import { AlchemyProvider, EtherscanProvider } from '@ethersproject/providers'
import { formatEther } from '@ethersproject/units'
import { Position } from './position'

import {
  ADDR_POSITIONS_NFT,
  ADDR_TOKEN_WETH,
  ADDR_TOKEN_USDC,
  TOPIC_MINT,
  TOPIC_TRANSFER,
  TOPIC_DECREASE_LIQUIDITY,
  INTERFACE_NFT,
  INTERFACE_WETH,
  INTERFACE_USDC,
  TOKEN_USDC,
  TOKEN_WETH,
  OUT_DIR,
  ADDR_POOL
} from './constants'

// Read our .env file
config()

// Data required for calculating the APY% of a given position:
// * Time position was open in days (from timestamp of add and remove txs)
// * Opening liquidity (in WETH and USDC, from add tx logs)
// * Fees claimed (in WETH and USDC, from remove tx logs)
// * Gas cost (in WETH and in USDC terms) from add, remove and swap txs
// * Price history, to get from ETH gas costs to USD gas costs

// Design
// 1. [DONE] From Etherscan provider, get all transactions for this address
// 2. [DONE] For each tx, get block number
// 3. [DONE] From Etherscan provider, for each block number, get all tx logs for these blocks only
// 4. Get price history for only the period from first tx to last tx timestamp
// 5. Use analytics-positions code to build Position instances from logs:
//   a. [WON'T DO] Map of logs keyed by tx hashes (do we need this?)
//   b. Array of Positions, each with arrays of logs on them
//      Both add tx and remove tx logs have the token ID in them, in different topics.
//   d  Filter Position array to those that are in set of our own token IDs
//   d. Set direction on each Position based on logs
//   e. Set fees based on logs
//   f. Set range width based on logs
//   g. Set opening liquidity based on logs
//   h. Set opening and closing prices from tx timestamps and price history
//   i. Set gas cost in ETH based on all txs
// 6. [DONE] Get all token IDs for this account from Uniswap position manager contract
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

  // TODO: Now that this has been committed (oops) I need to delete the API key.
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
    ownTokenIds.push(Number(tokenId))

    console.log(`  ${tokenId}`)
  }

  if (ownTokenIds.length != positionCount) {
    throw `This account has ${positionCount} positions but ${ownTokenIds.length} token IDs. Fatal.`
  }

  // This is all our transactions, not just add and remove transactions but swaps and unwrapping WETH to ETH.
  const allTxs = await PROVIDER.getHistory(address)

  console.log(`Transactions from this address: ${allTxs.length}`)

  const blockNumbers = Array<number>()

  for (const txResponse of allTxs) {
    if (txResponse.blockNumber === undefined) return

    blockNumbers.push(txResponse.blockNumber)

    // const txReceipt: TransactionReceipt = await PROVIDER.getTransactionReceipt(txResponse.hash)

    // // Note that neither of these are actually large integers.

    // // Corresponds to "Gas Used by Transaction" on Etherscan. Quoted in wei.
    // const gasUsed = txReceipt.gasUsed.toBigInt()

    // // Corresponds to "Gas Price Paid" on Etherscan. Quoted in wei.
    // const effectiveGasPrice = txReceipt.effectiveGasPrice.toBigInt()

    // const gasPaidInEth = gasUsed * effectiveGasPrice
    // const gasPaidInEthReadable = formatEther(gasPaidInEth - (gasPaidInEth % 100000000000000n))

    // console.log(`${txResponse.hash} gas paid: ${gasPaidInEthReadable} ETH`)
  }

  console.log(`Blocks: ${blockNumbers.length}`)

  if (blockNumbers.length != allTxs.length) {
    throw `This account transacted in ${blockNumbers.length} blocks but has ${ allTxs.length} transactions. Fatal.`
  }

  for (const blockNumber of blockNumbers) {
    // This is all logs for the pool in blocks in which we transacted, not just our logs.
    const filter = {
      address: ADDR_POSITIONS_NFT,
      fromBlock: blockNumber,
      toBlock: blockNumber
    }
  
    const logs: Array<Log> = await PROVIDER.getLogs(filter)

    if (logs.length === 0) {
      continue
    }
  
    console.log(`Uniswap Positions NFT logs for block ${blockNumber}:`)

    for (const log of logs) {
      console.log(`  data: ${log.data}`)
      console.log(`  topics:`)

      for (const topic of log.topics) {
        console.log(`    ${topic}`)
      }

      if (log.address != ADDR_POSITIONS_NFT && log.topics[0] == TOPIC_DECREASE_LIQUIDITY) {
        // Parse hex string to decimal
        const tokenId = Number(log.topics[1])
        const position = new Position(tokenId)

        console.log(`  Position: ${tokenId} is one of ours: ${ownTokenIds.includes(tokenId)}`)
      }
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
