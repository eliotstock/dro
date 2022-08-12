import { tickToPrice } from '@uniswap/v3-sdk'
import fs from 'fs'
import { EventLog, Direction, Position } from './position'
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
import { load, priceAt } from './price-history'

const POSITIONS = `${OUT_DIR}/positions-${abbreviate(ADDR_POOL)}.csv`

const N_10_TO_THE_6 = BigInt(1_000_000)

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

// Given an array of event logs, build a map in which keys are tx hashes and values are arrays of
// the logs for each tx.
export function logsByTxHash(logs: EventLog[]): Map<string, EventLog[]> {
    const txs = new Map<string, EventLog[]>()

    // forEach() is blocking here.
    logs.forEach(function(row: EventLog) {
        if (!row.transaction_hash) return

        let logs = txs.get(row.transaction_hash)
        if (!logs) logs = []

        logs.push(row)
        txs.set(row.transaction_hash, logs)
    })

    return txs
}

export function logsByTokenId(txMap: Map<string, EventLog[]>): Map<number, EventLog[]> {
    const logsMapped = new Map<number, EventLog[]>()

    for (let [txHash, logs] of txMap) {
        logs.forEach(function(log: EventLog) {
            // The position's token ID is given by the event log with address
            // 'Uniswap v3: Positions NFT', event Transfer(), last topic of the set of four topics.
            if (log.address == ADDR_POSITIONS_NFT && log.topics[0] == TOPIC_TRANSFER) {
                const tokenId: number = Number(log.topics[3])

                logsMapped.set(tokenId, logs)

                // No need to read any further through the logs for this transaction.
                return
            }
        })
    }

    return logsMapped
}

export function positionsByTokenId(txMap: Map<string, EventLog[]>): Map<number, Position> {
    const positions = new Map<number, Position>()

    for (let [removeTxHash, logs] of txMap) {
        // One of the event logs contains the token ID. Use that one to create the Position
        // instance only.
        logs.forEach(function(log: EventLog) {
            // The position's token ID is given by the event log with address
            // 'Uniswap v3: Positions NFT', topic DecreaseLiquidity.
            if (log.address == ADDR_POSITIONS_NFT && log.topics[0] == TOPIC_DECREASE_LIQUIDITY) {
                // Parse hex string to decimal
                const tokenId = Number(log.topics[1])

                const position = new Position(tokenId)
                position.removeTxLogs = logs
                position.closedTimestamp = log.block_timestamp.value

                positions.set(tokenId, position)

                // No need to see the rest of the logs.
                return
            }
        })
    }

    return positions
}

export function setDirectionAndFilterToOutOfRange(positions: Map<number, Position>) {
    for (let [tokenId, position] of positions) {
        position.removeTxLogs?.forEach(function(log: EventLog) {
            if (log.address == ADDR_POSITIONS_NFT && log.topics[0] == TOPIC_DECREASE_LIQUIDITY) {
                // Decode the logs data to get amount0 and amount1 so that we can figure out
                // whether the position was closed when out of range, and if so whether the
                // market traded up or down.
                const parsedLog = INTERFACE_NFT.parseLog({topics: log.topics, data: log.data})
                const amount0: number = parsedLog.args['amount0']
                const amount1: number = parsedLog.args['amount1']

                if (amount0 == 0) {
                    // Position closed out of range and the market traded down into WETH.
                    position.traded = Direction.Down
                }
                else if (amount1 == 0) {
                    // Position closed out of range and the market traded up into USDC.
                    position.traded = Direction.Up
                }
                else {
                    // Position was closed in-range. Removing from our map.
                    positions.delete(tokenId)
                }
            }
        })
    }
}

export function setFees(positions: Map<number, Position>) {
    for (let [tokenId, position] of positions) {
        position.removeTxLogs?.forEach(function(log: EventLog) {
            // For a position that traded up into USDC:
            // eg. Position 204635:
            //   https://etherscan.io/tx/0x44f29b0a779e8650045a9f9913235fbfed832d2514669dcc42c31913dcdfa183#eventlog
            if (position.traded == Direction.Up) {
                // WETH component of fees is given by the event log with address WETH,
                // Transfer() event, Data, wad value, in WETH.
                if (log.address == ADDR_TOKEN_WETH && log.topics[0] == TOPIC_TRANSFER) {
                    const parsedLog = INTERFACE_WETH.parseLog({topics: log.topics, data: log.data})
                    const wad: bigint = parsedLog.args['wad']

                    position.feesWeth = wad
                }

                // Total USDC withdrawn (fees plus liquidity) is given by the event log with
                // address USDC, Transfer() event, Data, 'value' arg, in USDC.
                if (log.address == ADDR_TOKEN_USDC && log.topics[0] == TOPIC_TRANSFER) {
                    const parsedLog = INTERFACE_USDC.parseLog({topics: log.topics, data: log.data})
                    const value: bigint = parsedLog.args['value']

                    position.withdrawnUsdc = value
                }

                // Liquidity USDC withdrawn is given by the event log with address 'Uniswap v3:
                // Positions NFT', DecreaseLiquidity() event, Data, 'amount0' arg, in USDC.
                if (log.address == ADDR_POSITIONS_NFT && log.topics[0] == TOPIC_DECREASE_LIQUIDITY) {
                    const parsedLog = INTERFACE_NFT.parseLog({topics: log.topics, data: log.data})
                    const amount0: bigint = parsedLog.args['amount0']

                    position.closingLiquidityUsdc = amount0
                }

                // USDC component of fees is given by the difference between the last two values.
            }
            // For a position that traded down into WETH:
            // eg. Position 198342:
            //   https://etherscan.io/tx/0x7ed3b7f8058194b92e59159c42fbccc9e60e32ce598830af6df0335906c6caf7#eventlog
            else if (position.traded == Direction.Down) {
                // USDC component of fees is given by the event log with address USDC,
                // Transfer() event, Data, 'value' arg, in USDC.
                if (log.address == ADDR_TOKEN_USDC && log.topics[0] == TOPIC_TRANSFER) {
                    const parsedLog = INTERFACE_USDC.parseLog({topics: log.topics, data: log.data})
                    const value: bigint = parsedLog.args['value']

                    position.feesUsdc = value
                }

                // Total WETH withdrawn (fees plus liquidity) is given by the event log with
                // address WETH, Transfer() event, Data, 'wad' arg, in WETH.
                if (log.address == ADDR_TOKEN_WETH && log.topics[0] == TOPIC_TRANSFER) {
                    const parsedLog = INTERFACE_WETH.parseLog({topics: log.topics, data: log.data})
                    const wad: bigint = parsedLog.args['wad']

                    position.withdrawnWeth = wad
                }

                // Liquidity WETH withdrawn is given by the event log with address 'Uniswap v3:
                // Positions NFT', DecreaseLiquidity() event, Data, 'amount1' arg, in WETH.
                if (log.address == ADDR_POSITIONS_NFT && log.topics[0] == TOPIC_DECREASE_LIQUIDITY) {
                    const parsedLog = INTERFACE_NFT.parseLog({topics: log.topics, data: log.data})
                    const amount1: bigint = parsedLog.args['amount1']

                    position.closingLiquidityWeth = amount1
                }

                // WETH component of fees is given by the difference between the last two values.
            }
        })
    }
}

export function setAddTxLogs(positions: Map<number, Position>,
    addTxLogsByTokenId: Map<number, EventLog[]>) {
    for (let [tokenId, position] of positions) {
        const addTxLogs = addTxLogsByTokenId.get(position.tokenId)

        if (addTxLogs != undefined && addTxLogs.length > 0) {
            position.addTxLogs = addTxLogs
            position.openedTimestamp = addTxLogs[0].block_timestamp.value
        }
        else {
            // We can't do much with a position that has no add transaction logs.
            positions.delete(tokenId)
        }
    }
}

export function setRangeWidth(positions: Map<number, Position>) {
    for (let [tokenId, position] of positions) {
        position.addTxLogs?.forEach(function(log: EventLog) {
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

                    // if (tokenId == 204635) {
                    //     console.log(`Prices: lower: ${priceLower}, mid: ${priceMid}, upper: ${priceUpper}. Range: ${range}`)
                    // }

                    position.rangeWidthInBps = range
                }
                catch (e) {
                    // Probably: 'Error: Invariant failed: TICK'
                    // Skip outlier positions.
                    positions.delete(tokenId)
                }
            }
        })
    }
}

export function setOpeningLiquidity(positions: Map<number, Position>) {
    for (let [tokenId, position] of positions) {
        position.addTxLogs?.forEach(function(log: EventLog) {
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

export function setOpeningClosingPrices(positions: Map<number, Position>, prices: any) {
    load(prices)

    for (let [tokenId, position] of positions) {
        if (position.openedTimestamp != undefined) {
            const priceAtOpening = priceAt(position.openedTimestamp)
            position.priceAtOpening = priceAtOpening
        }

        if (position.closedTimestamp != undefined) {
            const priceAtClosing = priceAt(position.closedTimestamp)
            position.priceAtClosing = priceAtClosing
        }
    }
}

// TODO: Requires joining on the transaction table to get the gas, gas_price or receipt_gas_used
// columns.
export function setGasCosts(positions: Map<number, Position>, prices: any) {
    for (let [tokenId, position] of positions) {
        position.addTxLogs?.forEach(function(log: EventLog) {
            // TODO
        })
        position.removeTxLogs?.forEach(function(log: EventLog) {
            // TODO
        })
    }
}

export function cleanData(positions: Map<number, Position>) {
    let outliers = 0

    for (let [tokenId, p] of positions) {
        // How we can possibly get negative fees I have no idea, but he have about 14 of these.
        if (p.feesTotalInUsdc() < 0n) {
            positions.delete(tokenId)
            outliers++
        }
    }

    if (outliers > 0){
        console.log(`  Removed ${outliers} positions with invalid data`)
    }
}

export function generateCsv(positions: Map<number, Position>) {
    let csvLines = 'tokenId,rangeWidthInBps,opened,closed,timeOpenInDays,sizeInUsd,feesInUsd,grossYieldInPercent\n'

    // const errors = new Map<string, number>()
    let errors = 0

    for (let [tokenId, p] of positions) {
        try {
            const csvLine = `${tokenId},\
${p.rangeWidthInBps},\
${p.openedTimestamp},\
${p.closedTimestamp},\
${p.timeOpenInDays()},\
${usdcFormatted(p.openingLiquidityTotalInUsdc())},\
${usdcFormatted(p.feesTotalInUsdc())},\
${p.grossYieldInPercent()}\n`

            csvLines += csvLine
        }
        catch (e) {
            errors++
        }
    }

    if (!fs.existsSync(OUT_DIR)) {
        fs.mkdirSync(OUT_DIR)
    }

    fs.writeFileSync(POSITIONS, csvLines)

    console.log(`  CSV missing ${errors} positions with errors`)
}

export function abbreviate(account: string): string {
    return account.substring(0, 6)
}

// Given 1_000_000, return 1.00. No commas.
function usdcFormatted(value: bigint): number {
    return Number(value * 100n / N_10_TO_THE_6) / 100
}
