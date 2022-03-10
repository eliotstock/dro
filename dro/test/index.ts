import { tickToPrice } from '@uniswap/v3-sdk'
import { expect } from 'chai'
import { rangeOrderPoolTick, updateTick, usdcToken, wethToken } from '../src/uniswap'
import { EthUsdcWallet } from '../src/wallet'

describe('Wallet token ratio by value', function () {
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

describe('Fun with large integers', function () {
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
