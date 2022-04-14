import yargs from 'yargs/yargs'
import { config } from 'dotenv'
import { BigNumber, ethers } from 'ethers'
import { tickToPrice } from '@uniswap/v3-sdk'
import { abi as NonfungiblePositionManagerABI }
    from '@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json'
import { Log, Provider, TransactionReceipt, TransactionResponse } from '@ethersproject/abstract-provider'
import { AlchemyProvider, EtherscanProvider } from '@ethersproject/providers'
import { formatEther } from '@ethersproject/units'
import { Position, Direction } from './position'

import {
  ADDR_POSITIONS_NFT_FOR_FILTER,
  ADDR_POSITIONS_NFT_FOR_LOGS,
  ADDR_TOKEN_WETH,
  ADDR_TOKEN_USDC,
  TOPIC_MINT,
  TOPIC_TRANSFER,
  TOPIC_INCREASE_LIQUIDITY,
  TOPIC_DECREASE_LIQUIDITY,
  INTERFACE_NFT,
  INTERFACE_WETH,
  INTERFACE_USDC,
  TOKEN_USDC,
  TOKEN_WETH,
  OUT_DIR,
  ADDR_POOL
} from './constants'
import { number } from 'yargs'

// Read our .env file
config()

// Data required for calculating the APY% of a given position:
// * Time position was open in days (from timestamp of add and remove txs)
// * Opening liquidity (in WETH and USDC, from add tx logs)
// * Fees claimed (in WETH and USDC, from remove tx logs)
// * Gas cost (in WETH and in USDC terms) from add, remove and swap txs
// * Price history, to get from ETH gas costs to USD gas costs

// Design
// 1. [DONE] From Etherscan provider, get all transactions for this address (swaps, adds, removes, unwraps)
// 2. [DONE] For each tx, get block number
// 3. [DONE] From Etherscan provider, for each block number, get all tx logs from the positions NFT address for these blocks only
// 4. Get price history for only the period from first tx to last tx timestamp
// 5. Use analytics-positions code to build Position instances from logs:
//   a. [WON'T DO] Map of logs keyed by tx hashes (do we need this?)
//   b. [DONE] Map of Positions, each with arrays of logs on them
//      Both add tx and remove tx logs have the token ID in them, in different topics.
//   d  [DONE] Filter Position array to those that are in set of our own token IDs (or look for our address as sender in the logs?)
//   d. [MOSTLY DONE] Set direction on each Position based on logs
//   e. [TESTING] Set fees based on logs
//   f. Set range width based on logs
//   g. Set opening liquidity based on logs
//   h. Set opening and closing prices from tx timestamps and price history
//   i. Set gas cost in ETH based on all txs
// 6. [DONE] Get all token IDs for this account from Uniswap position manager contract
// 7. Calc APY% from that set of Position instances

async function createPositionsWithLogs(provider: Provider, blockNumbers: Array<number>,
  ownTokenIds: Array<number>): Promise<Map<number, Position>> {
  const positions = new Map<number, Position>()

  // The provider can't simply give us the logs for a transaction. We can only filter by address
  // and block range.
  const emittingAddresses = [ADDR_POSITIONS_NFT_FOR_FILTER,
    ADDR_TOKEN_WETH,
    ADDR_TOKEN_USDC]
  
  // This is all logs emitted by these contracts in blocks in which we transacted, not just our own
  // logs.
  for (const emittingAddress of emittingAddresses) {
    for (const blockNumber of blockNumbers) {
      const filter = {
        address: emittingAddress,
        fromBlock: blockNumber,
        toBlock: blockNumber
      }
    
      console.log(`Getting logs emitted by ${emittingAddress}`)

      const logs: Array<Log> = await provider.getLogs(filter)

      if (logs.length === 0) {
        continue
      }
    
      // console.log(`Uniswap Positions NFT logs for block ${blockNumber}:`)

      for (const log of logs) {
        // console.log(`  data: ${log.data}`)
        // console.log(`  topics:`)

        for (const topic of log.topics) {
          // console.log(`    ${topic}`)
        }

        if (log.address != ADDR_POSITIONS_NFT_FOR_FILTER) {

          if (log.topics[0] == TOPIC_DECREASE_LIQUIDITY) {
            // These are the logs for the 'remove' transaction.
            // Parse hex string to decimal.
            const tokenId = Number(log.topics[1])

            if (ownTokenIds.includes(tokenId)) {
              // This is one of our positions.
              let position = positions.get(tokenId)

              if (position === undefined) {
                position = new Position(tokenId)
              }

              position.removeTxLogs.push(...logs)
              positions.set(tokenId, position)
            }
          }

          if (log.topics[0] == TOPIC_INCREASE_LIQUIDITY) {
            // These are the logs for the 'add' transaction.
            // Parse hex string to decimal.
            const tokenId = Number(log.topics[1])

            if (ownTokenIds.includes(tokenId)) {
              // This is one of our positions.
              let position = positions.get(tokenId)

              if (position === undefined) {
                position = new Position(tokenId)
              }

              position.addTxLogs.push(...logs)
              positions.set(tokenId, position)
            }
          }
        }
      }
    }
  }

  return positions
}

async function setDirection(positions: Map<number, Position>) {
  for (const p of positions.values()) {
    // Skip the current position, which is still open and has no remove TX logs.
    if (p.removeTxLogs === undefined) continue

    for (const log of p.removeTxLogs) {
      if (log.address == ADDR_POSITIONS_NFT_FOR_LOGS && log.topics[0] == TOPIC_DECREASE_LIQUIDITY) {
        // Decode the logs data to get amount0 and amount1 so that we can figure out whether the
        // position was closed when out of range, and if so whether the market traded up or down.
        const parsedLog = INTERFACE_NFT.parseLog({topics: log.topics, data: log.data})
        const amount0: number = parsedLog.args['amount0']
        const amount1: number = parsedLog.args['amount1']

        if (amount0 == 0) {
            // Position closed out of range and the market traded down into WETH.
            p.traded = Direction.Down
        }
        else if (amount1 == 0) {
            // Position closed out of range and the market traded up into USDC.
            p.traded = Direction.Up
        }
        else {
          // TODO: Handle positions closed in-range. Revisit fee calcs.
          console.log(`  Position(${p.tokenId}) closed in-range. amount0: ${amount0}, amount1: ${amount1}`)
        }

        positions.set(p.tokenId, p)
      }
    }
  }
}

function setFees(positions: Map<number, Position>) {
  for (const p of positions.values()) {
      p.removeTxLogs?.forEach(function(log: Log) {
        console.log(`Log address: ${log.address}`)
        console.log(`First topic: ${log.topics[0]}`)

          // For a position that traded up into USDC:
          // eg. Position 204635:
          //   https://etherscan.io/tx/0x44f29b0a779e8650045a9f9913235fbfed832d2514669dcc42c31913dcdfa183#eventlog
          if (p.traded == Direction.Up) {
              // WETH component of fees is given by the event log with address WETH,
              // Transfer() event, Data, wad value, in WETH.
              if (log.address == ADDR_TOKEN_WETH && log.topics[0] == TOPIC_TRANSFER) {
                  const parsedLog = INTERFACE_WETH.parseLog({topics: log.topics, data: log.data})
                  const wad: bigint = parsedLog.args['wad']

                  p.feesWeth = wad
              }

              // Total USDC withdrawn (fees plus liquidity) is given by the event log with
              // address USDC, Transfer() event, Data, 'value' arg, in USDC.
              if (log.address == ADDR_TOKEN_USDC && log.topics[0] == TOPIC_TRANSFER) {
                  const parsedLog = INTERFACE_USDC.parseLog({topics: log.topics, data: log.data})
                  const value: bigint = parsedLog.args['value']

                  p.withdrawnUsdc = value
              }

              // Liquidity USDC withdrawn is given by the event log with address 'Uniswap v3:
              // Positions NFT', DecreaseLiquidity() event, Data, 'amount0' arg, in USDC.
              if (log.address == ADDR_POSITIONS_NFT_FOR_LOGS &&
                log.topics[0] == TOPIC_DECREASE_LIQUIDITY) {
                  const parsedLog = INTERFACE_NFT.parseLog({topics: log.topics, data: log.data})
                  const amount0: bigint = parsedLog.args['amount0']

                  p.closingLiquidityUsdc = amount0
              }

              // USDC component of fees is given by the difference between the last two values.
          }
          // For a position that traded down into WETH:
          // eg. Position 198342:
          //   https://etherscan.io/tx/0x7ed3b7f8058194b92e59159c42fbccc9e60e32ce598830af6df0335906c6caf7#eventlog
          else if (p.traded == Direction.Down) {
              // USDC component of fees is given by the event log with address USDC,
              // Transfer() event, Data, 'value' arg, in USDC.
              if (log.address == ADDR_TOKEN_USDC && log.topics[0] == TOPIC_TRANSFER) {
                  const parsedLog = INTERFACE_USDC.parseLog({topics: log.topics, data: log.data})
                  const value: bigint = parsedLog.args['value']

                  p.feesUsdc = value
              }

              // Total WETH withdrawn (fees plus liquidity) is given by the event log with
              // address WETH, Transfer() event, Data, 'wad' arg, in WETH.
              if (log.address == ADDR_TOKEN_WETH && log.topics[0] == TOPIC_TRANSFER) {
                  const parsedLog = INTERFACE_WETH.parseLog({topics: log.topics, data: log.data})
                  const wad: bigint = parsedLog.args['wad']

                  p.withdrawnWeth = wad
              }

              // Liquidity WETH withdrawn is given by the event log with address 'Uniswap v3:
              // Positions NFT', DecreaseLiquidity() event, Data, 'amount1' arg, in WETH.
              if (log.address == ADDR_POSITIONS_NFT_FOR_LOGS &&
                log.topics[0] == TOPIC_DECREASE_LIQUIDITY) {
                  const parsedLog = INTERFACE_NFT.parseLog({topics: log.topics, data: log.data})
                  const amount1: bigint = parsedLog.args['amount1']

                  p.closingLiquidityWeth = amount1
              }

              // WETH component of fees is given by the difference between the last two values.
          }
      })
  }
}

// Returns USDC's small units (USDC has six decimals)
// When the price in the pool is USDC 3,000, this will return 3_000_000_000.
// Note that this ONLY works for the token order of the WETH/USDC 0.30% pool on L1. The token
// order for other pools or the same pool on other chains may vary.
// May throw 'Error: Invariant failed: TICK'
export function tickToNativePrice(tick: number): bigint {
  // tickToPrice() returns a Price<Token, Token> which extends Fraction in which numerator
  // and denominator are both JSBIs.
  const p = tickToPrice(TOKEN_WETH, TOKEN_USDC, tick)

  // The least bad way to get from JSBI to BigInt is via strings for numerator and denominator.
  const num = BigInt(p.numerator.toString())
  const denom = BigInt(p.denominator.toString())

  return num * BigInt(1_000_000_000_000_000_000) / denom
}

function setRangeWidth(positions: Map<number, Position>) {
  for (let [tokenId, position] of positions) {
      position.addTxLogs?.forEach(function(log: Log) {
          // Just look for a Mint() event, regardless of the address that emitted it.
          if (log.topics[0] == TOPIC_MINT) {
              // The last two topics are the tickLower and tickUpper
              const tickLower = Number(log.topics[2])
              const tickUpper = Number(log.topics[3])

              // For this token order, prices are inverted from ticks (lower to upper)
              try {
                  const priceLower = tickToNativePrice(tickUpper)
                  const priceUpper = tickToNativePrice(tickLower)

                  const widthAbsolute = priceUpper - priceLower
                  const priceMid = priceLower + (widthAbsolute / 2n)

                  // The old 'decimal value from dividing two bigints' trick, except we want
                  // this in basis points, so we don't divide again by our constant.
                  const range = Number(widthAbsolute * 10_000n / priceMid)

                  console.log(`Prices: lower: ${priceLower}, mid: ${priceMid}, upper: ${priceUpper}. Range: ${range}`)

                  position.rangeWidthInBps = range
              }
              catch (e) {
                  // Probably: 'Error: Invariant failed: TICK'
                  // Skip outlier positions.
                  console.error(e)
                  positions.delete(tokenId)
              }
          }
      })
  }
}

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
  // const PROVIDER_ALCHEMY = new AlchemyProvider(undefined, 'NJhHpafwsqTku1zBNDC0N61Q1mTvYjVU')

  const positionManagerContract = new ethers.Contract(
    ADDR_POSITIONS_NFT_FOR_FILTER,
    NonfungiblePositionManagerABI,
    PROVIDER
  )

  // This count includes all the closed positions.
  const positionCount = await positionManagerContract.balanceOf(address)

  console.log(`Positions (closed and open): ${positionCount}.`)

  const ownTokenIds = Array<number>()

  for (let i = 0; i < positionCount; i++) {
    const tokenId = await positionManagerContract.tokenOfOwnerByIndex(address, i)
    ownTokenIds.push(Number(tokenId))
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
    throw `This account transacted in ${blockNumbers.length} blocks but has ${allTxs.length} transactions. Fatal.`
  }

  const positions = await createPositionsWithLogs(PROVIDER, blockNumbers, ownTokenIds)

  // for (const p of positions.values()) {
  //   console.log(`  Position(${p.tokenId}) with ${p.addTxLogs?.length} add tx logs and ${p.removeTxLogs?.length} remove tx logs`)
  // }

  if (ownTokenIds.length != positions.size) {
    throw `This account has ${ownTokenIds.length} positions but we could only find logs for ${positions.size}. Fatal.`
  }

  // Set direction on each position
  setDirection(positions)

  for (const p of positions.values()) {
    console.log(`  Position(${p.tokenId}) traded ${p.traded}`)
  }

  // Set fees on each position
  setFees(positions)

  for (const p of positions.values()) {
    console.log(`  Position(${p.tokenId}): fees WETH: ${p.feesWeth}, fees USDC: ${p.feesUsdc}`)
  }

  // Set the range width based on the tick upper and lower from the logs.
  setRangeWidth(positions)
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
