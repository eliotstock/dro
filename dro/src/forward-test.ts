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

const expectedGrossYields = new Map<number, number>()

//                      bps  percent
//                      ---  -------
expectedGrossYields.set(120, 1_280)
// expectedGrossYields.set(240, 710)
// expectedGrossYields.set(360, 320)

interface DroState {
    liquidityEth: number,
    liquidityUsdc: number
}

// Keys here are range widths.
const droStates = new Map<number, DroState>()

// Only half the value in our account needs to be swapped to the other asset when we re-range.
function swapFee(amount: number): number {
    return SWAP_POOL_FEE * 0.5 * amount
}

function gasCost(): number {
    return GAS_COST
}

// function intervalYears(previousTimestamp: string, currentTimestamp: string): number {
//     const previous = moment(previousTimestamp, TIMESTAMP_FORMAT)
//     const current = moment(currentTimestamp, TIMESTAMP_FORMAT)

//     // Do NOT round to the nearest integer here, by passing true.
//     return current.diff(previous, 'years', true)
// }

// TODO (P1): Add an init() function and do what forwardTestRerange() currently does when there's
// no state yet. we should not be waiting for the first re-range before doing anything.

export function forwardTestRerange(width: number,
    lastMinTick: number,
    lastMaxTick: number,
    lastEntryTick: number,
    timeInRange: Duration,
    direction: Direction) {
    // Get position state for this range width.
    let state = droStates.get(width)

    // If this is the initial range, just figure out our starting liquidity.
    if (state == undefined) {
        state = {
            // Spend half our initial USDC balance on ETH at the current price in the pool.
            liquidityEth: (INITIAL_POSTION_VALUE_USDC / 2) / parseFloat(rangeOrderPoolPriceUsdc),

            // And keep the other half in USDC.
            liquidityUsdc: INITIAL_POSTION_VALUE_USDC / 2
        }

        droStates.set(width, state)

        return
    }

    // Calculate expected fees given the range width and the time spent in range
    // const unclaimedFees = expectedGrossYield / 100 * yearsInRange * positionValue
    // positionValue += unclaimedFees

    // Calculate "impermanent loss", more correctly now a realised loss or gain,
    // from moving completely into the devaluing asset in the pool.
    // Stick to USDC-denominated return calculation for now.

    // If we re-ranged down, all the USDC we added is now ETH at an average price of
    // half way between the entry price and the min price for the last range.

    // If we re-ranged up, all the ETH we added is now USDC at an average price of
    // half way between entry price and the max price for the last range.
    const entryPriceUsdc = parseFloat(tickToPrice(wethToken, usdcToken, lastEntryTick).toFixed(2))
    console.log(`[${width}] Entry price: ${entryPriceUsdc} USDC`)

    if (direction == Direction.Up) {
        const maxPriceUsdc = parseFloat(tickToPrice(wethToken, usdcToken, lastMaxTick).toFixed(2))
        console.log(`[${width}] Max price: ${maxPriceUsdc} USDC`)

        // TODO (P1): Because this is proportional, it actually doesn't depend on absolute prices
        // at all. Calculate it based on the range width only and do that statically, not here.
        // Do some algebra to express this in terms of the range width, not the absolute prices.
        // Test it against our R&D sheet.
        const expectedDivergenceGainProportion = ((maxPriceUsdc - entryPriceUsdc) / 2) /
            (2 * entryPriceUsdc)

        const expectedDivergenceGainUsdc = expectedDivergenceGainProportion *
            (state.liquidityUsdc + (state.liquidityEth * entryPriceUsdc))

        console.log(`[${width}] Expected divergence gain: ${expectedDivergenceGainUsdc}, \
(${expectedDivergenceGainProportion / 100}%)`)
    }
    else if (direction == Direction.Down) {
        console.log(`[${width}] Expected divergence loss: not yet implemented`)
    }

    // We'll also incur the cost of the swap and the gas for the set of re-ranging
    // transactions (remove liquidity, swap, add liquidity)
    // const fee = swapFee(positionValue)
    // const gas = gasCost()

    // positionValue -= fee
    // positionValue -= gas
}

export function logResults() {
    console.log(`TODO`)
}

