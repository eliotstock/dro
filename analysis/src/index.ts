import { config } from 'dotenv'
import { resolve } from 'path'
import { ethers } from 'ethers'
import { abi as IUniswapV3PoolABI } from '@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json'
import { tickToPrice, nearestUsableTick, TickMath } from '@uniswap/v3-sdk'
import { Token } from '@uniswap/sdk-core'
import { BigQuery }  from '@google-cloud/bigquery'
import invariant from 'tiny-invariant'
import stringify from 'csv-stringify/lib/sync'
import parse from 'csv-parse/lib/sync'
import moment from 'moment'
import fs from 'fs'

const CHAIN_ID = 1

const ADDR_TOKEN_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"

const ADDR_TOKEN_WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"

const ADDR_POOL_USDC_WETH_030 = "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640"

const TOKEN_USDC = new Token(CHAIN_ID, ADDR_TOKEN_USDC, 6, "USDC", "USD Coin")

const TOKEN_WETH = new Token(CHAIN_ID, ADDR_TOKEN_WETH, 18, "WETH", "Wrapped Ether")

const INTERFACE_POOL = new ethers.utils.Interface(IUniswapV3PoolABI)

const POOL_TICK_SPACING = 60

// The fee in the pool in which we execute our swaps is 0.05%.
const SWAP_POOL_FEE = 0.05 / 100

// This constant gas cost is a mean taken from 7 sets of the three transactions (remove liquidity,
// swap, add liquidity) when manually executing re-ranging.
const GAS_COST = 92.20

// Start out with this in the position and see how we get on.
const INITIAL_POSTION_VALUE_USDC = 100_000

const TIMESTAMP_FORMAT = 'YYYY-MM-DDTHH:mm:ss.SSSZ'

const OUT_DIR = './out'
const SWAP_EVENTS_CSV = OUT_DIR + '/swap_events.csv'

// Read our .env file
config()

// An event emitted by the Uniswap v3 pool contract. See:
//   https://github.com/Uniswap/v3-core/blob/v1.0.0/contracts/UniswapV3Pool.sol#L786
class SwapEvent {
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

// Single, global array of SwapEvents. As of 2021-11, this is about 800K events at less than 1kB
// per event, so easy enough to store in RAM on an everyday laptop.
let swapEvents: SwapEvent[] = []

// Current tick/price and range around it.
let tick: number
let priceUsdc: number
let minTick: number
let maxTick: number
let minPriceUsdc: string
let maxPriceUsdc: string

// Current block timestamp
let blockTimestamp: string

// From the Uniswap v3 whitepaper:
//   "Ticks are all 1.0001 to an integer power, which means each tick is .01% away from the next
//    tick."
// Note that .01% is one basis point ("bip"), so every tick is a single bip change in price.
// But the tick spacing in our pool is 60, so our range width must be a multiple of that.
//
// Forget about using a range width of 60 bps. When we re-range, we want a new range that's
// centered on the current price. This is impossible when the range width is the smallest possible
// width - we can't set a min tick 30 bps lower than the current price.
const expectedGrossYields = new Map<number, number>()

//                      bps  percent
//                      ---  -------
expectedGrossYields.set(120, 1_280)
expectedGrossYields.set(240, 710)
expectedGrossYields.set(360, 320)

let rangeWidthTicks: number

let rerangeCounter: number

let positionValue: number

// Query Google's public dataset for Ethereum mainnet transactions.
async function runQuery() {
    if (process.env.GCP_PROJECT_ID == undefined)
        throw "No GCP_PROJECT_ID in .env file (or no .env file)."

    if (process.env.GCP_KEY_PATH == undefined)
        throw "No GCP_KEY_PATH in .env file (or no .env file)."

    const config = {
        projectId: process.env.GCP_PROJECT_ID,
        keyPath: resolve(process.env.GCP_KEY_PATH)
    }
    // console.log(`GCP config:`, config)

    // Merely passing our config to the BigQuery constructor is not sufficient. We need to set this
    // on the environment too.
    process.env.GOOGLE_APPLICATION_CREDENTIALS = config.keyPath

    const bigQueryClient = new BigQuery(config)

    // First, query the logs of a single transaction that we know was a swap in the ETH/USDC 0.05%
    // fee pool, because it was our own swap.
    // ## The result is one row with three topics. Only one topic has data. That topic is:
    //   "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"

    // const sqlQuery = `select * from
    //     bigquery-public-data.crypto_ethereum.logs
    //     where transaction_hash = "[HASH_OF_YOUR_OWN_TX]"
    //     and address = "[ADDRESS_OF_POOL]"`

    // Now find all logs with that topic for the above pool address.
    const sqlQuery = `select block_timestamp, topics, data from
        bigquery-public-data.crypto_ethereum.logs
        where topics[SAFE_OFFSET(0)] = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"
        and address = "${ADDR_POOL_USDC_WETH_030}"
        order by block_timestamp`

    const options = {
        query: sqlQuery,
        location: 'US',
    }

    const stopwatchStart = Date.now()
    console.log("Querying...")
    const [rows] = await bigQueryClient.query(options)

    // The result is ~800K rows, starting on 2021-05-05 when Uniswap v3 went live. Good.
    // This is about 500MB to download each time we run (at 700K or so per row).
    console.log(`  Row count: ${rows.length}`)

    // console.log("First row:")
    // console.dir(rows[0])
    /*
    {
      block_timestamp: BigQueryTimestamp { value: '2021-05-05T22:15:01.000Z' },
      topics: [
        '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67',
        '0x000000000000000000000000e592427a0aece92de3edee1f18e0157c05861564',
        '0x000000000000000000000000e592427a0aece92de3edee1f18e0157c05861564'
      ],
      data: '0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffff8dcd9a2000000000000000000000000000000000000000000000000007c58508723800000000000000000000000000000000000000042f6fac2e8d93171810499824dd6000000000000000000000000000000000000000000000000000139d797d3bfe0000000000000000000000000000000000000000000000000000000000002f9b4'
    }
    */

    // At this point we have a result set, but it's on the server still. Now we need to decode the
    // data from these rows, pull out the tick value and convert it to a value in USDC terms.
    // forEach() is blocking here.
    rows.forEach(row => {
        let e = rowToSwapEvent(row)
        swapEvents.push(e)
    })

    // Don't stop the stopwatch until we've iterated over the data.
    const stopwatchMillis = (Date.now() - stopwatchStart)
    console.log(`... done in ${Math.round(stopwatchMillis / 1_000)}s`)

    // Write the events to disk as a cache. We need a tight feedback loop when developing.
    const csv = stringify(swapEvents, {header: true})
    fs.writeFileSync(SWAP_EVENTS_CSV, csv)
}

function rowToSwapEvent(row: any): SwapEvent {
    // We expect three of these.
    const logsTopics = row['topics']

    // And one of these.
    const logsData = row.data

    const parsedLog = INTERFACE_POOL.parseLog({topics: logsTopics, data: logsData})

    let e: SwapEvent = new SwapEvent(row['block_timestamp']['value'], parsedLog.args['tick'])

    const price: string = tickToPrice(TOKEN_WETH, TOKEN_USDC, e.tick).toFixed(2)
    e.priceUsdc = parseFloat(price)

    return e
}

function rerange() {
    let logLine = `  #${rerangeCounter} ${blockTimestamp} Price ${priceUsdc} re-ranges `

    // Down in tick terms is up in USDC terms and vice versa.
    if (tick < minTick) {
        logLine += `up  `
    }
    else if (tick > maxTick) {
        logLine += `down`
    }

    // Check that the tick value won't cause nearestUsableTick() to fail below.

    minTick = Math.round(tick - (rangeWidthTicks / 2))
    invariant(minTick >= TickMath.MIN_TICK && minTick <= TickMath.MAX_TICK, `TICK_BOUND: minTick: ${minTick}, TickMath.MIN_TICK: ${TickMath.MIN_TICK}`)
    minTick = nearestUsableTick(minTick, POOL_TICK_SPACING)

    maxTick = Math.round(tick + (rangeWidthTicks / 2))
    invariant(maxTick >= TickMath.MIN_TICK && maxTick <= TickMath.MAX_TICK, `TICK_BOUND: maxTick: ${maxTick}, TickMath.MAX_TICK: ${TickMath.MAX_TICK}`)
    maxTick = nearestUsableTick(maxTick, POOL_TICK_SPACING)

    // The minimum USDC price corresponds to the maximum tick and vice versa.
    minPriceUsdc = tickToPrice(TOKEN_WETH, TOKEN_USDC, maxTick).toFixed(2)
    maxPriceUsdc = tickToPrice(TOKEN_WETH, TOKEN_USDC, minTick).toFixed(2)

    rerangeCounter++

    logLine += ` to ${minPriceUsdc} <-> ${maxPriceUsdc}`

    console.log(logLine)
}

function outOfRange(): boolean {
    return tick > maxTick || tick < minTick
}

// Only half the value in our account needs to be swapped to the other asset when we re-range.
function swapFee(amount: number): number {
    return SWAP_POOL_FEE * 0.5 * amount
}

function gasCost(): number {
    return GAS_COST
}

export function intervalYears(previousTimestamp: string, currentTimestamp: string): number {
    const previous = moment(previousTimestamp, TIMESTAMP_FORMAT)
    const current = moment(currentTimestamp, TIMESTAMP_FORMAT)

    // Do NOT round to the nearest integer here, by passing true.
    return current.diff(previous, 'years', true)
}

export function apy(startTimestamp: string, endTimestamp: string, startingBalance: number,
    endingBalance: number): number {
    const start = moment(startTimestamp, TIMESTAMP_FORMAT)
    const end = moment(endTimestamp, TIMESTAMP_FORMAT)

    // Do NOT round to the nearest integer here, by passing true.
    const intervalYears = end.diff(start, 'years', true)

    const absoluteReturn = endingBalance - startingBalance
    const relativeReturn = absoluteReturn / startingBalance

    const anualisedReturn = relativeReturn / intervalYears

    return anualisedReturn
}

async function main() {
    if (!fs.existsSync(OUT_DIR)) {
        fs.mkdirSync(OUT_DIR)
    }

    if (fs.existsSync(SWAP_EVENTS_CSV)) {
        console.log(`Using cached query results`)

        const csv = fs.readFileSync(SWAP_EVENTS_CSV, 'utf8')
        swapEvents = parse(csv, {columns: true, cast: true})
    }
    else {
        await runQuery()
    }

    // We now have a price timeseries, both in terms of ticks and USDC.

    console.log(`Analysing...`)

    // Run the analysis once per key in expectedGrossYields
    expectedGrossYields.forEach((expectedGrossYield: number, rangeWidth: number) => {
        rangeWidthTicks = rangeWidth
    
        // Start out with a range centered on the price of the first block in our data.
        const firstSwapEvent = swapEvents[0]
        tick = firstSwapEvent.tick
        priceUsdc = firstSwapEvent.priceUsdc || 0
        rerange()
        rerangeCounter = 0
        positionValue = INITIAL_POSTION_VALUE_USDC
    
        swapEvents.forEach(e => {
            if (e.blockTimestamp == blockTimestamp) {
                // Disregard all but the first swap event in a given block. We will never re-range
                // more than once per block because it takes us a whole block to re-range.
                // The last swap in the block would be just as good - doesn't matter much.
                return
            }
    
            tick = e.tick
            priceUsdc = e.priceUsdc || 0
    
            if (outOfRange()) {
                rerange()

                // We'll claim some fees at the time of removing liquidity.
                const yearsInRange = intervalYears(blockTimestamp, e.blockTimestamp)

                const unclaimedFees = expectedGrossYield / 100 * yearsInRange * positionValue

                // console.log(`  Expect gross yield of ${expectedGrossYield}% APY for ${yearsInRange} years is ${unclaimedFees.toFixed(6)}`)

                positionValue += unclaimedFees

                // But we'll also incur the cost of the swap and the gas for the set of re-ranging
                // transactions (remove liquidity, swap, add liquidity)
                const fee = swapFee(positionValue)
                const gas = gasCost()

                positionValue -= fee
                positionValue -= gas

                // if (positionValue > 0) {
                //     console.log(`  Position: +${unclaimedFees.toFixed(6)} -${fee.toFixed(2)} -${gas} = USDC ${positionValue.toFixed(2)}`)
                // }
            }

            blockTimestamp = e.blockTimestamp
        })

        const lastSwapEvent = swapEvents[swapEvents.length - 1]
        const totalIntervalYears = intervalYears(firstSwapEvent.blockTimestamp, lastSwapEvent.blockTimestamp)
    
        console.log(`  Range width ${rangeWidthTicks} re-ranged ${rerangeCounter} times in ${totalIntervalYears} years`)
    
        // Note that forEach() above is blocking.
        const meanTimeToReranging = totalIntervalYears / rerangeCounter
        const humanized = moment.duration(meanTimeToReranging, 'years').humanize()
        console.log(`  Mean time to re-ranging: ${humanized}`)
        console.log(`  Closing position value: USDC ${positionValue.toFixed(2)}`)

        const expectedApy = apy(firstSwapEvent.blockTimestamp, lastSwapEvent.blockTimestamp,
            INITIAL_POSTION_VALUE_USDC, positionValue)
        console.log(`  Expected net APY: ${(expectedApy * 100).toFixed(0)}%`)
        console.log('')
    })
}

main().catch((error) => {
    console.error(error)
    process.exitCode = 1
})
