import moment, { Duration } from 'moment'
import { tickToPrice } from "@uniswap/v3-sdk"
import { rangeOrderPoolPriceUsdcAsBigNumber } from './uniswap'
import { ethers } from 'ethers'
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

// Based on a price of 3,360.
const INITIAL_POSTION_VALUE_ETH = 14.88095

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
expectedGrossYields.set(1800, 180)

// Value of each position, denominated in USDC
const droPositionValuesUsdc = new Map<number, number>()

// Value of each position, denominated in ETH
const droPositionValuesEth = new Map<number, number>()

// For a given range width, what's our expected divergence when the market trades up to the range
// max or down to the range min, in USD terms, as a proportion?
// Note that this is a linear approximation and the error is quite large when we get out to range
// widths like 1800 bps, for example.
// TODO (P2): Find the proper (non-linear) solution for xa in terms of r. See sheet.
function divergenceBps(rangeWidth: number, direction: Direction): number {
    if (direction == Direction.Down) {
        return 3 * rangeWidth / 8
    }
    else {
        // Up:
        return rangeWidth / 8
    }
}

// Only half the value in our account needs to be swapped to the other asset when we re-range.
function swapFeeUsdc(amount: number): number {
    return SWAP_POOL_FEE * 0.5 * amount
}

function gasCostUsdc(): number {
    return GAS_COST
}

export function forwardTestInit(width: number) {
    droPositionValuesUsdc.set(width, INITIAL_POSTION_VALUE_USDC)

    // Start with the current ETH value of INITIAL_POSTION_VALUE_USDC
    // Abandonned, because we don't yet have the current price here.
    // const usdc = ethers.BigNumber.from(INITIAL_POSTION_VALUE_USDC)
    // const initialPositionValueEth = usdc.div(rangeOrderPoolPriceUsdcAsBigNumber())
    // droPositionValuesEth.set(width, initialPositionValueEth.toNumber())

    // console.log(`Initial position value (ETH): ${initialPositionValueEth.toNumber()}`)
    droPositionValuesEth.set(width, INITIAL_POSTION_VALUE_ETH)
}

export function forwardTestRerange(width: number,
    timeInRange: Duration,
    direction: Direction): string {

    let positionValue = droPositionValuesUsdc.get(width)

    if (positionValue == undefined) {
        throw 'No initial value for width. Call forwardTestInit() first.'
    }

    const positionValueBefore = positionValue

    let logLine = `[${width}] Position value (USDC) =\n  ${positionValue.toPrecision(7)}`

    // Calculate expected fees given the range width and the time spent in range
    const expectGrossYieldPercent = expectedGrossYields.get(width)

    if (expectGrossYieldPercent == undefined) {
        return `[${width}] No expected gross yield for this width`
    }

    const unclaimedFees = expectGrossYieldPercent / 100 * timeInRange.asYears() * positionValue
    logLine += ` +${unclaimedFees.toPrecision(4)} (yield over ${timeInRange.asYears().toPrecision(4)} years in range)\n`
    positionValue += unclaimedFees

    const divergence = divergenceBps(width, direction)
    // console.log(`[${width}] Expected divergence: ${divergence} bps`)

    const expectedDivergenceAbs = divergence / (100 * 100) * positionValueBefore

    if (direction == Direction.Up) {
        // If we re-ranged up, all the ETH we added is now USDC at an average price of
        // half way between entry price and the max price for the last range.
        logLine += ` +${expectedDivergenceAbs.toPrecision(4)} (divergence gain)\n`
        positionValue += expectedDivergenceAbs
    }
    else if (direction == Direction.Down) {
        // If we re-ranged down, all the USDC we added is now ETH at an average price of
        // half way between the entry price and the min price for the last range.
        logLine += ` -${expectedDivergenceAbs.toPrecision(4)} (divergence loss)\n`
        positionValue -= expectedDivergenceAbs
    }

    // We'll also incur the cost of the swap and the gas for the set of re-ranging
    // transactions (remove liquidity, swap, add liquidity)
    const fee = swapFeeUsdc(positionValue)
    logLine += ` -${fee.toPrecision(4)} (swap fee)\n`
    positionValue -= fee

    const gas = gasCostUsdc()
    logLine += ` -${gas.toPrecision(4)} (gas cost)\n`
    positionValue -= gas

    logLine += ` = ${positionValue.toPrecision(7)} USDC`

    droPositionValuesUsdc.set(width, positionValue)

    return logLine
}
