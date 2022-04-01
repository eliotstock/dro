import { ethers } from 'ethers'
import { abi as IUniswapV3PoolABI } from '@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json'
import { tickToNativePrice } from './functions'

const INTERFACE_POOL = new ethers.utils.Interface(IUniswapV3PoolABI)

export function sqlForPriceHistory(poolAddress: string, firstTopic: string) {
    return `select block_timestamp, topics, data from
    bigquery-public-data.crypto_ethereum.logs
    where address = "${poolAddress}"
    and topics[SAFE_OFFSET(0)] = "${firstTopic}"
    order by block_timestamp`
}

// Only about 200K prices as of 2022-04.
const POOL_PRICES = new Map<string, bigint>()

// Given a log from the Swap() event, return a tuple with the timestamp and the price in USDC.
function poolPrice(log: any): [string, bigint] {
    const parsedLog = INTERFACE_POOL.parseLog({topics: log['topics'], data: log.data})

    const price = tickToNativePrice(parsedLog.args['tick'])

    return [log['block_timestamp']['value'], price]
}

export function load(prices: any) {
    prices.forEach(function(log: any) {
        const [blockTimestamp, price] = poolPrice(log)
        POOL_PRICES.set(blockTimestamp, price)
    })
}

// Pass a timestamp in format 'YYYY-MM-DDTHH:mm:ss.SSSZ'
export function priceAt(timestamp: string): bigint {
    let p: bigint = 0n

    for (let [blockTimestamp, price] of POOL_PRICES) {
        // Once we see a block that falls just after the timestamp passed in, use the price just
        // before that.
        // console.log(`${blockTimestamp} > ${timestamp}: ${blockTimestamp > timestamp}`)
        if (blockTimestamp > timestamp) return p

        p = price
    }

    throw `No price at ${timestamp}`
}
