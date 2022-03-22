import { SqrtPriceMath, TickMath, priceToClosestTick } from '@uniswap/v3-sdk'
import { CurrencyAmount, Fraction, Price, Token } from '@uniswap/sdk-core'
import JSBI from 'jsbi'

// See: https://github.com/Uniswap/smart-order-router/blob/3e4b8ba06f78930a7310ca7880df136592c98549/src/routers/alpha-router/alpha-router.ts#L1461
describe('Understanding Uniswap liquidity maths', function() {
    // Mainnet token addresses
    const addrUsdc = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
    const addrWeth = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'

    const tokenUsdc = new Token(1, addrUsdc, 6, 'USDC', 'USD Coin')
    const tokenWeth = new Token(1, addrWeth, 18, 'WETH', 'Wrapped Ether')

    it('Should give us the expected optimal ratio for a symmetrical WETH/USDC position', async function() {
        // From a real position:
        //   https://app.uniswap.org/#/pool/204635?chain=mainnet
        // const tickLower = -197_760
        // const tickCurrent = -196_800
        // const tickUpper = -196_909

        // Symetrical - current price is half way between lower and upper

        // USDC 2,500 (2_500_000_000) equals WETH 1.0 (1_000_000_000_000_000_000)
        // const amountUsdc = CurrencyAmount.fromRawAmount(tokenUsdc, 2_500_000_000)
        // const amountWeth = CurrencyAmount.fromRawAmount(tokenWeth, 1_000_000_000_000_000_000)
        // const priceLower = new Price<Token, Token>({ baseAmount: amountWeth, quoteAmount: amountUsdc })

        const priceLower = new Price<Token, Token>(tokenWeth, tokenUsdc, 1_000_000_000_000_000_000, 2_500_000_000)
        const priceCurrent = new Price<Token, Token>(tokenWeth, tokenUsdc, 1_000_000_000_000_000_000, 3_000_000_000)
        const priceUpper = new Price<Token, Token>(tokenWeth, tokenUsdc, 1_000_000_000_000_000_000, 3_500_000_000)

        console.log(`Prices (lower, current, upper): (${priceLower.toFixed(0)}, ${priceCurrent.toFixed(0)}, ${priceUpper.toFixed(0)})`)

        // Ticks based on the above prices. Invert lower and upper.
        const tickLower = priceToClosestTick(priceUpper)
        const tickCurrent = priceToClosestTick(priceCurrent)
        const tickUpper = priceToClosestTick(priceLower)

        // (194714, 196256, 198079)
        // Range: 3365 ticks
        // Midpoint: 196397
        // Note that the ticks midpoint is NOT the same as the tick for the price midpoint.
        console.log(`Ticks (lower, current, upper): (${tickLower}, ${tickCurrent}, ${tickUpper})`)

        // [960] tick (lower, current, upper): (, -196909, )
        // [960] sqrtRatioX96 from pool directly: 4200353374426507795247847
        // [960] sqrtRatioX96 from current tick: 4200188232646938879556701

        const lowerSqrtRatioX96 = TickMath.getSqrtRatioAtTick(tickLower)
        const sqrtRatioX96 = TickMath.getSqrtRatioAtTick(tickCurrent)
        const upperSqrtRatioX96 = TickMath.getSqrtRatioAtTick(tickUpper)

        const precision = JSBI.BigInt('1' + '0'.repeat(18))

        // This is the price of WETH in terms of USDC, taken from the range order pool on Arbitrum
        // where WETH is token 0 and USDC is token 1.
        // const price = new Fraction(2817, 1)

        // const sqrtRatioX96 = JSBI.BigInt('4205576653325148087714865')
        //                       1501296094141917074055633258303303

        // console.log(`Tick of ${tickCurrent} gives sqrtRatioX96 of ${sqrtRatioX96.toString()}`)

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

        console.log(`Optimal ratio: ${optimalRatio.toFixed(16)}`)

        const amountWeth = CurrencyAmount.fromRawAmount(tokenWeth, 1_000_000_000_000_000_000)
        const optimalUsdcForOneWeth = optimalRatio.multiply(amountWeth)

        // 3_522_334_916.04125672
        console.log(`Optimal amount of USDC for a symmetrical position with 1 WETH: ${optimalUsdcForOneWeth.toFixed(8)}`)

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
