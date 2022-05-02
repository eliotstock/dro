import yargs from 'yargs/yargs'
import { Contract, ethers } from 'ethers'
import { tickToPrice } from '@uniswap/v3-sdk'
import { abi as IUniswapV3PoolABI } from '@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json'
import { Log, Provider, TransactionResponse } from '@ethersproject/abstract-provider'
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
    ADDR_POOL,
    ADDR_ROUTER
} from './constants'
import { formatEther, formatUnits } from '@ethersproject/units'
import moment from 'moment'

const INTERFACE_POOL = new ethers.utils.Interface(IUniswapV3PoolABI)

const N_10_TO_THE_18 = BigInt(1_000_000_000_000_000_000)

export function getArgsOrDie(): [string, string, string] {
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

    if (process.env.ALCHEMY_API_KEY === undefined) {
        console.log('Missing ALCHEMY_API_KEY from .env file, or .env file itself')
        process.exit(1)
    }

    return [address, process.env.ETHERSCAN_API_KEY, process.env.ALCHEMY_API_KEY]
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

    blockNumberLoop:
    for (const blockNumber of blockNumbers) {
        let blockOffset = 0
        // let price = 0n

        // If there was no swap event in this block, look backward a few blocks until we find one.
        // Because we transact when the price moves, swaps tend to have happened *before* we
        // transact. We've never needed the offset to go over 2 blocks.
        while (blockOffset < 5) {
            const block = blockNumber - blockOffset
            // console.log(`Block ${blockNumber} - offset ${blockOffset} = block ${block}`)

            const filter = {
                address: ADDR_POOL,
                fromBlock: block,
                toBlock: block
            }

            const logs = await provider.getLogs(filter)
            // let logIndex = -1

            for (const log of logs) {
                // logIndex++

                const parsedLog = INTERFACE_POOL.parseLog({topics: log.topics, data: log.data})
                const tick = parsedLog.args['tick']

                // console.log(`  Log index: ${logIndex}, tick: ${tick}`)
    
                // No swap in this log. Try the next one.
                if (tick === undefined) continue
    
                const price = tickToNativePrice(tick)

                // When we look up prices later, they're going to be for the block numbers
                // passed in, NOT the blocks in which we finally found swaps after offsetting.
                poolPrices.set(blockNumber, price)
    
                // console.log(`  price: ${price}`)

                // Move on to the next block number arg.
                continue blockNumberLoop
            }

            // No swaps in any of these logs. Try the next block back.
            blockOffset++
        }

        console.log(`No swaps within ${blockOffset} blocks of block ${blockNumber}`)
    }

    console.log(`Got ${poolPrices.size} prices at or near ${blockNumbers.length} blocks`)

    return poolPrices
}
  
export function setDirection(positions: Map<number, Position>) {
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

        // Note that closing liquidity, excluding fees, is set at the same time as the fees.
    }
}

export function setOpeningClosingPrices(positions: Map<number, Position>,
    prices: Map<number, bigint>) {
    for (let [tokenId, position] of positions) {
        const openedBlockNumber = position.addTxReceipt?.blockNumber

        if (openedBlockNumber === undefined) {
            console.error(`No opened block number`)
        }
        else {
            position.priceAtOpening = prices.get(openedBlockNumber)

            if (position.priceAtOpening === undefined) {
                console.error(`No price at opening block number ${openedBlockNumber}`)
            }
        }

        const closedBlockNumber = position.removeTxReceipt?.blockNumber

        if (closedBlockNumber === undefined) {
            console.log(`No closed block number. Position still open?`)
        }
        else {
            position.priceAtClosing = prices.get(closedBlockNumber)

            if (position.priceAtClosing === undefined) {
                console.error(`No price at closing block number ${closedBlockNumber}`)
            }
        }
    }
}

export async function setAddRemoveTxReceipts(positions: Map<number, Position>, provider: Provider) {
    for (let [tokenId, position] of positions) {
        if (position.addTxLogs.length > 0) {
            const addTxHash = position.addTxLogs[0].transactionHash

            position.addTxReceipt = await provider.getTransactionReceipt(addTxHash)
        }

        if (position.removeTxLogs.length > 0) {
            const removeTxHash = position.removeTxLogs[0].transactionHash

            position.removeTxReceipt = await provider.getTransactionReceipt(removeTxHash)
        }
    }
}

export async function setSwapTx(positions: Map<number, Position>,
    allTxs: Array<TransactionResponse>, provider: Provider) {

    for (let [tokenId, position] of positions) {
        if (position.addTxReceipt === undefined) {
            console.log(`Skipping position ${tokenId} with no add tx receipt`)
            continue
        }

        const addTxHash = position.addTxReceipt?.transactionHash

        // console.log(`Add tx hash: ${addTxHash}`)

        allTxsLoop:
        for (const [index, txResponse] of allTxs.entries()) {
            // console.log(`${index} add tx hash: ${addTxHash} c.f. txResponse.hash: ${txResponse.hash}`)

            // The swap tx is not always the one that immediately preceeded the 'add' tx, because
            // we often unwrap after the swap. We also have some failed transactions.
            if (addTxHash == txResponse.hash) {
                let offsetBefore = 1

                while (offsetBefore < 5) {
                    if (index - offsetBefore < 0) {
                        console.log(`No swap tx before first add tx`)
                        break   
                    }

                    const priorTx = allTxs[index - offsetBefore]

                    // console.log(`Tx ${offsetBefore} txs before add tx was to: ${priorTx.to}`)

                    // Swap transactions go to the Uniswap router.
                    if (priorTx.to == ADDR_ROUTER) {
                        // Not strictly necessary since a failed TX will always be followed with a
                        // successfult one.
                        if (priorTx.confirmations == 0) {
                            console.log(`No confirmations for tx ${priorTx.hash}. Failed tx?`)
                            continue
                        }

                        position.swapTxReceipt = await provider.getTransactionReceipt(priorTx.hash)
                        position.swapTxLogs = position.swapTxReceipt.logs
        
                        // console.log(`  Position ${tokenId}'s swap TX: https://etherscan.io/tx/${priorTx.hash}`)
                        break allTxsLoop
                    }

                    offsetBefore++
                }
            }
        }
    }
}

export async function setGasPaid(positions: Map<number, Position>, provider: Provider) {
    for (let [tokenId, position] of positions) {
        // Gas paid for 'add' tx
        if (position.addTxReceipt === undefined) {
            console.log(`Skipping position ${tokenId} with no add tx receipt`)
        }
        else {
            // Corresponds to "Gas Used by Transaction" on Etherscan. Quoted in wei.
            const addTxGasUsed = position.addTxReceipt.gasUsed.toBigInt()

            // Corresponds to "Gas Price Paid" on Etherscan. Quoted in wei.
            const addEffectiveGasPrice = position.addTxReceipt.effectiveGasPrice.toBigInt()

            if (addTxGasUsed !== undefined && addEffectiveGasPrice !== undefined) {
                position.addTxGasPaid = addTxGasUsed * addEffectiveGasPrice
            }
        }

        // Gas paid for 'remove' tx
        if (position.removeTxReceipt === undefined) {
            console.log(`Skipping position ${tokenId} with no remove tx receipt`)
        }
        else {
            const removeTxGasUsed = position.removeTxReceipt.gasUsed.toBigInt()

            const removeEffectiveGasPrice = position.removeTxReceipt.effectiveGasPrice.toBigInt()

            if (removeTxGasUsed !== undefined && removeEffectiveGasPrice !== undefined) {
                position.removeTxGasPaid = removeTxGasUsed * removeEffectiveGasPrice
            }
        }

        // Gas paid for 'swap' tx
        if (position.swapTxReceipt === undefined) {
            console.log(`Skipping position ${tokenId} with no swap tx receipt`)
        }
        else {
            const swapTxGasUsed = position.swapTxReceipt.gasUsed.toBigInt()

            const swapEffectiveGasPrice = position.swapTxReceipt.effectiveGasPrice.toBigInt()

            if (swapTxGasUsed !== undefined && swapEffectiveGasPrice !== undefined) {
                position.swapTxGasPaid = swapTxGasUsed * swapEffectiveGasPrice
            }
        }

        console.log(`Position ${tokenId} total gas paid: ${position.totalGasPaidInEth()} wei`)
    }
}

export async function setTimestamps(positions: Map<number, Position>, provider: Provider) {
    for (let [tokenId, position] of positions) {
        if (position.addTxReceipt === undefined) {
            console.log(`Can't get opening timestamp for position ${tokenId}. No add tx receipt.`)
        }
        else {
            const openedBlock = await provider.getBlock(position.addTxReceipt.blockNumber)
            position.openedTimestamp = openedBlock.timestamp
        }

        if (position.removeTxReceipt === undefined) {
            console.log(`Can't get closing timestamp for position ${tokenId}. No remove tx receipt.`)
        }
        else {
            const closedBlock = await provider.getBlock(position.removeTxReceipt.blockNumber)
            position.closedTimestamp = closedBlock.timestamp
        }
    }
}

// Returns the total value of the account as two values: one denominated in ETH, the other in USDC.
// Excludes the liquidity in any open position at the time of the block.
export async function getBalanceAtBlockNumber(address: string, blockTag: number,
    contractWeth: Contract, contractUsdc: Contract, poolPrices: Map<number, bigint>,
    provider: Provider): Promise<[bigint, bigint]> {
    // Passing the blockTag here requires an archive node. Alchemy provides this.
    const [ethBalance, wethBalance, usdcBalance] = await Promise.all([
        provider.getBalance(address, blockTag),
        contractWeth.balanceOf(address, {blockTag}),
        contractUsdc.balanceOf(address, {blockTag})
    ])

    const ethBalanceNative = ethBalance.toBigInt()

    let usdcPrice = poolPrices.get(blockTag)

    if (usdcPrice === undefined) {
        console.error(`No price at block ${blockTag}`)
        return [0n, 0n]
    }

    const ethValueOfUsdcBalance: bigint = BigInt(usdcBalance) * N_10_TO_THE_18 / BigInt(usdcPrice)

    const ethValue: bigint = BigInt(ethBalanceNative) + BigInt(wethBalance)
        + BigInt(ethValueOfUsdcBalance)

    const usdcValueOfEthBalance = ethBalanceNative * BigInt(usdcPrice) / N_10_TO_THE_18

    const usdcValueOfWethBalance = BigInt(wethBalance) * BigInt(usdcPrice) / N_10_TO_THE_18

    const usdcValue: bigint = BigInt(usdcValueOfEthBalance) + BigInt(usdcValueOfWethBalance)
        + BigInt(usdcBalance)

    return [ethValue, usdcValue]
}

export async function generateCsvEthUsdcBalances(address: string, positions: Map<number, Position>,
    contractWeth: Contract, contractUsdc: Contract, poolPrices: Map<number, bigint>,
    provider: Provider) {
    console.log(`Closing timestamp, closing ETH/USDC price, direction, time open in hours, ETH\
 balance after remove tx, USDC balance after remove tx`)

    for (let [tokenId, position] of positions) {
      if (position.closedTimestamp === undefined) continue
  
      const closingTimestamp = moment.unix(position.closedTimestamp).toISOString()
      const closingBlockNumber = position.closingBlockNumber()
      const closingPrice = position.priceAtClosing != null ? position.priceAtClosing : 0n
  
      const [balanceInEth, balanceInUsdc] = await getBalanceAtBlockNumber(address,
        closingBlockNumber, contractWeth, contractUsdc, poolPrices, provider)
  
      const timeOpenInHours = position.timeOpen().asHours()
  
      console.log(`${closingTimestamp}, ${formatUnits(closingPrice, 6)}, ${position.traded}, \
  ${timeOpenInHours}, ${formatEther(balanceInEth)}, ${formatUnits(balanceInUsdc, 6)}`)
    }
}

export function generateCsvLiquiditySplit(positions: Map<number, Position>) {
    console.log(`Closing timestamp, closing ETH/USDC price, range width in bps, direction, \
openingLiquidityWeth, openingLiquidityUsdc, closingLiquidityWeth, closingLiquidityUsdc`)

    for (let [tokenId, p] of positions) {
      if (p.closedTimestamp === undefined) continue
  
      const closingTimestamp = moment.unix(p.closedTimestamp).toISOString()
      const closingPrice = p.priceAtClosing != null ? p.priceAtClosing : 0n
  
      console.log(`${closingTimestamp}, ${formatUnits(closingPrice, 6)}, ${p.rangeWidthInBps}, ${p.traded}, \
  ${formatEther(p.openingLiquidityWeth)}, ${formatUnits(p.openingLiquidityUsdc, 6)}, \
  ${formatEther(p.closingLiquidityWeth)}, ${formatUnits(p.closingLiquidityUsdc, 6)}`)
    }
}

export function generateCsvLiquidityInEth(positions: Map<number, Position>) {
    console.log(`Closing timestamp, closing ETH/USDC price, range width in bps, direction, \
openingLiquidityTotalInEth, closingLiquidityTotalInEth, impermanentLossInEth`)

    for (let [tokenId, p] of positions) {
      if (p.closedTimestamp === undefined) continue
  
      const closingTimestamp = moment.unix(p.closedTimestamp).toISOString()
      const closingPrice = p.priceAtClosing != null ? p.priceAtClosing : 0n
  
      console.log(`${closingTimestamp}, ${formatUnits(closingPrice, 6)}, ${p.rangeWidthInBps}, \
${p.traded}, ${formatEther(p.openingLiquidityTotalInEth())}, ${formatEther(p.closingLiquidityTotalInEth())}, \
${formatEther(p.impermanentLossInEth())}`)
    }
}

export function generateCsvBreakdown(positions: Map<number, Position>) {
    console.log(`Closing timestamp, closing ETH/USDC price, range width in bps, direction, \
feesTotalInEth - totalGasPaidInEth - impermanentLossInEth = netReturnInEth`)

    for (let [tokenId, p] of positions) {
      if (p.closedTimestamp === undefined) continue
  
      const closingTimestamp = moment.unix(p.closedTimestamp).toISOString()
      const closingPrice = p.priceAtClosing != null ? p.priceAtClosing : 0n
  
      try {
        console.log(`${closingTimestamp}, ${formatUnits(closingPrice, 6)}, ${p.rangeWidthInBps}, \
${p.traded}, ${formatEther(p.feesTotalInEth())} - ${formatEther(p.totalGasPaidInEth())} - \
${formatEther(p.impermanentLossInEth())} = ${formatEther(p.netReturnInEth())}`)
      }
      catch (e) {
          console.log(e)
      }
    }
}
