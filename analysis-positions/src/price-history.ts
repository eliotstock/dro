import { ethers } from 'ethers'
import { abi as IUniswapV3PoolABI } from '@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json'
import { tickToPrice } from '@uniswap/v3-sdk'
import * as c from './constants'

const INTERFACE_POOL = new ethers.utils.Interface(IUniswapV3PoolABI)

export function sqlForPriceHistory(poolAddress: string, firstTopic: string) {
    return `select block_timestamp, topics, data from
    bigquery-public-data.crypto_ethereum.logs
    where address = "${poolAddress}"
    and topics[SAFE_OFFSET(0)] = "${firstTopic}"
    order by block_timestamp`
}

export class SwapEvent {
    blockTimestamp: string
    tick: number
    priceUsdc?: number

    constructor(
        _blockTimestamp: string,
        _tick: number
    ) {
        this.blockTimestamp = _blockTimestamp
        this.tick = _tick
    }
}

export function rowToSwapEvent(row: any): SwapEvent {
    // We expect three of these.
    const logsTopics = row['topics']

    // And one of these.
    const logsData = row.data

    const parsedLog = INTERFACE_POOL.parseLog({topics: logsTopics, data: logsData})

    let e: SwapEvent = new SwapEvent(row['block_timestamp']['value'], parsedLog.args['tick'])

    const price: string = tickToPrice(c.TOKEN_WETH, c.TOKEN_USDC, e.tick).toFixed(2)
    e.priceUsdc = parseFloat(price)

    return e
}
