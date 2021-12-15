import moment, { Duration } from 'moment'
import { tickToPrice } from "@uniswap/v3-sdk"
import { usdcToken, wethToken, rangeOrderPoolPriceUsdc } from './uniswap'
import { Direction } from './dro'

const TIMESTAMP_FORMAT = 'YYYY-MM-DDTHH:mm:ss.SSSZ'

// The fee in the pool in which we execute our swaps is 0.05%.
const SWAP_POOL_FEE = 0.05 / 100

// Ethereum mainnet
// This constant gas cost is a mean taken from 7 sets of the three transactions (remove liquidity,
// swap, add liquidity) when manually executing re-ranging.
// const GAS_COST = 92.20

// Arbitrum mainnet
// Taken from only three manual re-ranges.
const GAS_COST = 30.00

// Start out with this amount in each position and see how we get on.
const INITIAL_POSTION_VALUE_USDC = 50_000

// What do we expect to make in fees, as an annual percentage, for each range width?
// These numbers are from real positions, albeit very few of them.
const expectedGrossYields = new Map<number, number>()

//                      bps  percent
//                      ---  -------
expectedGrossYields.set(120, 1_050)
expectedGrossYields.set(240, 600)
expectedGrossYields.set(360, 400)
expectedGrossYields.set(480, 313)
expectedGrossYields.set(600, 251)
expectedGrossYields.set(720, 209)
expectedGrossYields.set(1800, 161)

const droPositionValuesUsdc = new Map<number, number>()

// For a given range width, what's our expected divergence when the market trades up to the range
// max or down to the range min, in USD terms, as a proportion?
// Note that this only applies when the entry price for the position is the exact midpoint of the
// range min and max.
function divergenceBps(rangeWidth: number, direction: Direction): number {
    if (direction == Direction.Up) {
        return rangeWidth / 8
    }
    else {
        return rangeWidth * 3 / 4
    }
}

// Only half the value in our account needs to be swapped to the other asset when we re-range.
function swapFee(amount: number): number {
    return SWAP_POOL_FEE * 0.5 * amount
}

function gasCost(): number {
    return GAS_COST
}

export function forwardTestInit(width: number) {
    droPositionValuesUsdc.set(width, INITIAL_POSTION_VALUE_USDC)
}

export function forwardTestRerange(width: number,
    timeInRange: Duration,
    direction: Direction) {

    let positionValue = droPositionValuesUsdc.get(width)

    if (positionValue == undefined) {
        throw 'No initial value for width. Call forwardTestInit() first.'
    }

    const positionValueBefore = positionValue

    let logLine = `[${width}] Position value = ${positionValue.toPrecision(7)}`

    // Calculate expected fees given the range width and the time spent in range
    const expectGrossYieldPercent = expectedGrossYields.get(width)

    if (expectGrossYieldPercent == undefined) {
        console.log(`[${width}] No expected gross yield for this width`)

        return
    }

    const unclaimedFees = expectGrossYieldPercent / 100 * timeInRange.asYears() * positionValue
    logLine += ` +${unclaimedFees} (yield over ${timeInRange.asYears().toPrecision(6)} years in range)`
    positionValue += unclaimedFees

    const divergence = divergenceBps(width, direction)
    console.log(`[${width}] Expected divergence: ${divergence} bps`)

    const expectedDivergenceAbs = divergence / (100 * 100) * positionValueBefore

    if (direction == Direction.Up) {
        // If we re-ranged up, all the ETH we added is now USDC at an average price of
        // half way between entry price and the max price for the last range.
        logLine += ` +${expectedDivergenceAbs.toPrecision(4)} (divergence gain)`
        positionValue += expectedDivergenceAbs
    }
    else if (direction == Direction.Down) {
        // If we re-ranged down, all the USDC we added is now ETH at an average price of
        // half way between the entry price and the min price for the last range.
        logLine += ` -${expectedDivergenceAbs.toPrecision(4)} (divergence loss)`
        positionValue -= expectedDivergenceAbs
    }

    // We'll also incur the cost of the swap and the gas for the set of re-ranging
    // transactions (remove liquidity, swap, add liquidity)
    const fee = swapFee(positionValue)
    logLine += ` -${fee.toPrecision(4)} (swap fee)`
    positionValue -= fee

    const gas = gasCost()
    logLine += ` -${gas.toPrecision(4)} (gas cost)`
    positionValue -= gas

    logLine += ` = ${positionValue.toPrecision(7)} USDC`
    console.log(logLine)

    droPositionValuesUsdc.set(width, positionValue)
}

export function logResults() {
    console.log(`TODO`)
}

