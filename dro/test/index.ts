import { tickToPrice, SqrtPriceMath, TickMath } from '@uniswap/v3-sdk'
import { Fraction } from '@uniswap/sdk-core'
import { expect } from 'chai'
import { rangeOrderPoolTick, updateTick, usdcToken, wethToken } from '../src/uniswap'
import { EthUsdcWallet } from '../src/wallet'
import JSBI from 'jsbi'

describe('Wallet token ratio by value', function() {
    it('Should be close to 1.0 for some specific values', async function() {
        // Balances: USDC 1078.48, WETH 0.3926
        // This is USD 1159 worth of WETH, so the ratio should be close to 1.
        const usdc = 1078480000n         // USDC 1078.48
        const weth = 392600000000000000n // WETH 0.3926

        // This is USDC * 10e6, eg. 3_000_000_000 when the price of ETH is USD 3,000.
        const price = 3000000000n

        const ratio: number = EthUsdcWallet._tokenRatioByValue(usdc, weth, price)
        console.log(`Ratio: ${ratio}`)

        expect(ratio).to.be.within(0.5, 1.5)
    })

    it('Should be 2.0 for some other specific values', async function() {
        const usdc = 1000000000n         // USDC 1,000.00
        const weth = 500000000000000000n // WETH 0.5

        // This is USDC * 10e6, eg. 1_000_000_000 when the price of ETH is USD 1,000.
        const price = 1000000000n

        const ratio: number = EthUsdcWallet._tokenRatioByValue(usdc, weth, price)

        expect(ratio).to.equal(2.0)
    })

    it('Should be 0.5 for some other specific values', async function() {
        const usdc = 1000000000n          // USDC 1,000.00
        const weth = 2000000000000000000n // WETH 2.0

        // This is USDC * 10e6, eg. 1_000_000_000 when the price of ETH is USD 1,000.
        const price: bigint = 1000000000n

        const ratio: number = EthUsdcWallet._tokenRatioByValue(usdc, weth, price)

        expect(ratio).to.equal(0.5)
    })
})

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

describe('Understanding Uniswap liquidity maths', function() {
    it('Should log some stuff', async function() {
        // See: https://github.com/Uniswap/smart-order-router/blob/3e4b8ba06f78930a7310ca7880df136592c98549/src/routers/alpha-router/alpha-router.ts#L1461

        // From a real position:
        //   https://app.uniswap.org/#/pool/204635?chain=mainnet
        // const tickLower = -197_760
        // const tickUpper = -196_909
        // const tickCurrent = -196_800

        // Symetrical - current is half way between lower and upper
        const tickLower = 196_500
        const tickUpper = 197_500
        const tickCurrent = 197_000

        // [960] tick (lower, current, upper): (, -196909, )
        // [960] sqrtRatioX96 from pool directly: 4200353374426507795247847
        // [960] sqrtRatioX96 from current tick: 4200188232646938879556701
        

        const upperSqrtRatioX96 = TickMath.getSqrtRatioAtTick(tickUpper)
        const lowerSqrtRatioX96 = TickMath.getSqrtRatioAtTick(tickLower)

        const precision = JSBI.BigInt('1' + '0'.repeat(18))

        // This is the price of WETH in terms of USDC, taken from the range order pool on Arbitrum
        // where WETH is token 0 and USDC is token 1.
        // const price = new Fraction(2817, 1)

        // const sqrtRatioX96 = JSBI.BigInt('4205576653325148087714865')

        //                       1501296094141917074055633258303303
        const sqrtRatioX96 = TickMath.getSqrtRatioAtTick(tickCurrent)

        console.log(`Tick of ${tickCurrent} gives sqrtRatioX96 of ${sqrtRatioX96.toString()}`)

        const amount0Delta = SqrtPriceMath.getAmount0Delta(
            sqrtRatioX96,
            upperSqrtRatioX96,
            precision,
            true
        )

        const amount1Delta = SqrtPriceMath.getAmount1Delta(
            sqrtRatioX96,
            lowerSqrtRatioX96,
            precision,
            true
        )

        console.log(`amount0Delta: ${amount0Delta.toString()}`)
        console.log(`amount1Delta: ${amount1Delta.toString()}`)

        let optimalRatio = new Fraction(amount0Delta, amount1Delta)

        console.log(`Optimal ratio: ${optimalRatio.toFixed(8)}`)

        // From a real position:
        //   amount0Delta: 102_518_622_583_041_131_541 (102 * 10^18)
        //   amount1Delta:           2_498_012_579_836 (2,498 * 10^6)
        //   Optimal ratio:                ~41_040_074

        // Symetrical - current is half way between lower and upper:
        //   amount0Delta:            1_302_910_016_423 (1,302 * 10^6)
        //   amount1Delta:  467_829_888_947_323_230_789 (467 * 10^18)
        //   Optimal ratio:                           0.0000        
    })
})
