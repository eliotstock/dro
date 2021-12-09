import moment, { Duration } from 'moment'

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

// TODO: Map of balances, USD-denominated, one per range width, starting at INITIAL_POSTION_VALUE_USDC.

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

export function forwardTestRerange(width: number, timeInRange: Duration) {
    // Get position value for this range width

    // Calculate expected fees given the range width and the time spent in range
    // const unclaimedFees = expectedGrossYield / 100 * yearsInRange * positionValue
    // positionValue += unclaimedFees

    // Calculate "impermanent loss", more correctly now a realised loss or gain,
    // from moving completely into one asset in the pool.

    // If we re-ranged down, all the USDC we added is now ETH at an average price of
    // half way between the price we last re-ranged at and the minimum price for that
    // range.

    // If we re-ranged up, all the ETH we added is now USDC at an average price of
    // half way between the price we last re-ranged at and the maximum price for that
    // range.

    // Stick to USDC-denominated return calculation for now, then do ETH-denominated.

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

