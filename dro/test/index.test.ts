import { tickToPrice } from '@uniswap/v3-sdk'
import { rangeOrderPoolTick, updateTick, usdcToken, wethToken } from '../src/uniswap'

describe('Fun with large integers', function() {
    it('Should log some stuff', async function() {
        await updateTick()

        console.log(`Tick: ${rangeOrderPoolTick}`)

        const p = tickToPrice(wethToken, usdcToken, rangeOrderPoolTick)
        console.log(`Num as string: ${p.numerator.toString()}`)
        console.log(`Denom as string: ${p.denominator.toString()}`)

        const num = BigInt(p.numerator.toString())
        const denom = BigInt(p.denominator.toString())
        console.log(`Num as native: ${num}`)
        console.log(`Denom as native: ${denom}`)

        const b = (num * BigInt(1_000_000_000_000_000_000)) / denom
        // 2_977_093_343
        console.log(`b: ${b}`)
    })
})
