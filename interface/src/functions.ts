import yargs from 'yargs/yargs'
import { ethers } from 'ethers'
import { tickToPrice } from '@uniswap/v3-sdk'
import { abi as IUniswapV3PoolABI } from '@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json'
import { Log, Provider, TransactionReceipt } from '@ethersproject/abstract-provider'
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
    ADDR_POOL
} from './constants'

const INTERFACE_POOL = new ethers.utils.Interface(IUniswapV3PoolABI)

export function getArgsOrDie(): [string, string] {
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

    return [address, process.env.ETHERSCAN_API_KEY]
}

export function createPositionsWithLogs(logss: Array<Array<Log>>): Map<number, Position> {
    const positions = new Map<number, Position>()
  
    for (const logs of logss) {
      if (logs.length === 0) continue
  
      for (const log of logs) {
        // console.log(`  data: ${log.data}`)
        // console.log(`  topics:`)
  
        // for (const topic of log.topics) {
        //   console.log(`    ${topic}`)
        // }
  
        if (log.address != ADDR_POSITIONS_NFT_FOR_FILTER) {
  
          if (log.topics[0] == TOPIC_DECREASE_LIQUIDITY) {
            // These are the logs for the 'remove' transaction.
            // Parse hex string to decimal.
            const tokenId = Number(log.topics[1])
            let position = positions.get(tokenId)
  
            if (position === undefined) {
              position = new Position(tokenId)
            }
  
            // position.removeTxLogs.push(...logs)
            position.removeTxLogs = logs
            positions.set(tokenId, position)
          }
  
          if (log.topics[0] == TOPIC_INCREASE_LIQUIDITY) {
            // These are the logs for the 'add' transaction.
            // Parse hex string to decimal.
            const tokenId = Number(log.topics[1])
            let position = positions.get(tokenId)
  
            if (position === undefined) {
              position = new Position(tokenId)
            }
  
            // position.addTxLogs.push(...logs)
            position.addTxLogs = logs
            positions.set(tokenId, position)
          }
        }
      }
    }

    // for (const p of positions.values()) {
    //     console.log(`  Position(${p.tokenId}) with ${p.addTxLogs?.length} add tx logs and ${p.removeTxLogs?.length} remove tx logs`)
    // }
  
    return positions
}

export async function getPrices(blockNumbers: Array<number>, provider: Provider) {
    // Keys: block numbers, value: prices in USDC atoms.
    const poolPrices = new Map<number, bigint>()

    for (const blockNumber of blockNumbers) {
        let blockOffset = 0
        let price = 0n

        while (price == 0n && blockOffset < 10) {
            const block = blockNumber + blockOffset

            const filter = {
                address: ADDR_POOL,
                fromBlock: block,
                toBlock: block
            }

            const logs = await provider.getLogs(filter)

            for (const log of logs) {
                try {
                    const parsedLog = INTERFACE_POOL.parseLog({topics: log.topics, data: log.data})
                    const tick = parsedLog.args['tick']
        
                    if (tick === undefined) continue
        
                    price = tickToNativePrice(tick)
                    poolPrices.set(log.blockNumber, price)
        
                    console.log(`Tick: ${tick}, price: ${price} found at offset ${blockOffset}`)
                }
                catch (e) {
                    console.log(e)
                    continue
                }
            }
        }
    }

    console.log(`Got ${poolPrices.size} prices from ${blockNumbers.length} blocks`)

    return poolPrices
}
  
export async function setDirection(positions: Map<number, Position>) {
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
            // We don't currently support any calculations on positions that we closed when still in range.
            p.traded = Direction.Sideways
          }
  
          positions.set(p.tokenId, p)
        }
      }
    }

    // for (const p of positions.values()) {
    //     console.log(`  Position(${p.tokenId}) traded ${p.traded}`)
    // }
}
  
export function setFees(positions: Map<number, Position>) {
    for (const p of positions.values()) {
        p.removeTxLogs?.forEach(function(log: Log) {
          // console.log(`Log address: ${log.address}`)
          // console.log(`First topic: ${log.topics[0]}`)
  
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
  
// Returns USDC's atoms (USDC has six decimals)
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
  
export function setRangeWidth(positions: Map<number, Position>) {
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
                    // TODO: Round this to the nearest 10 bps.
                    const range = Number(widthAbsolute * 10_000n / priceMid)
  
                    // console.log(`Prices: lower: ${priceLower}, mid: ${priceMid}, upper: ${priceUpper}. Range: ${range}`)
  
                    position.rangeWidthInBps = range
                }
                catch (e) {
                    // Probably: 'Error: Invariant failed: TICK'
                    // Skip outlier positions. Not going to occur on our own positions.
                    console.error(e)
                    positions.delete(tokenId)
                }
            }
        })
    }
}
  
export function setOpeningLiquidity(positions: Map<number, Position>) {
    for (let [tokenId, position] of positions) {
        position.addTxLogs?.forEach(function(log: Log) {
            if (log.address == ADDR_TOKEN_WETH && log.topics[0] == TOPIC_TRANSFER) {
                const parsedLog = INTERFACE_WETH.parseLog({topics: log.topics, data: log.data})
                const wad: bigint = parsedLog.args['wad']
  
                position.openingLiquidityWeth = wad
            }
            else if (log.address == ADDR_TOKEN_USDC && log.topics[0] == TOPIC_TRANSFER) {
                const parsedLog = INTERFACE_USDC.parseLog({topics: log.topics, data: log.data})
                const value: bigint = parsedLog.args['value']
  
                position.openingLiquidityUsdc = value
            }
        })
    }
}

export async function setGasPaid(positions: Map<number, Position>, provider: Provider) {
    for (let [tokenId, position] of positions) {
        if (position.addTxLogs.length > 0) {
            const addTxHash = position.addTxLogs[0].transactionHash

            position.addTxReceipt = await provider.getTransactionReceipt(addTxHash)

            // Corresponds to "Gas Used by Transaction" on Etherscan. Quoted in wei.
            const addTxGasUsed = position.addTxReceipt.gasUsed.toBigInt()

            // Corresponds to "Gas Price Paid" on Etherscan. Quoted in wei.
            const addEffectiveGasPrice = position.addTxReceipt.effectiveGasPrice.toBigInt()

            if (addTxGasUsed !== undefined && addEffectiveGasPrice !== undefined) {
                position.addTxGasPaid = addTxGasUsed * addEffectiveGasPrice
            }
        }

        if (position.removeTxLogs.length > 0) {
            const removeTxHash = position.removeTxLogs[0].transactionHash

            position.removeTxReceipt = await provider.getTransactionReceipt(removeTxHash)

            const removeTxGasUsed = position.removeTxReceipt.gasUsed.toBigInt()

            const removeEffectiveGasPrice = position.removeTxReceipt.effectiveGasPrice.toBigInt()

            if (removeTxGasUsed !== undefined && removeEffectiveGasPrice !== undefined) {
                position.removeTxGasPaid = removeTxGasUsed * removeEffectiveGasPrice
            }
        }
    }
}
