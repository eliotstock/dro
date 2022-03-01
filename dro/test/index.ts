import { expect } from 'chai'
import { BigNumber } from 'ethers'
import { EthUsdcWallet } from '../src/wallet'

describe('Token ratio by value', function () {
    it('Should be close to 1.0 for some specific values', async function() {
        // Balances: USDC 1078.48, WETH 0.3926
        // This is USD 1159 worth of WETH, so the ratio should be close to 1.
        const usdc: BigNumber = BigNumber.from('1078480000')         // USDC 1078.48
        const weth: BigNumber = BigNumber.from('392600000000000000') // WETH 0.3926

        // This is USDC * 10e6, eg. 3_000_000_000 when the price of ETH is USD 3,000.
        const price: BigNumber = BigNumber.from('3000000000')

        const ratio: number = EthUsdcWallet._tokenRatioByValue(usdc, weth, price)
        console.log(`Ratio: ${ratio}`)

        expect(ratio).to.be.within(0.5, 1.5)
    })

    it('Should be 2.0 for some other specific values', async function() {
        const usdc: BigNumber = BigNumber.from('1000000000')         // USDC 1,000.00
        const weth: BigNumber = BigNumber.from('500000000000000000') // WETH 0.5

        // This is USDC * 10e6, eg. 1_000_000_000 when the price of ETH is USD 1,000.
        const price: BigNumber = BigNumber.from('1000000000')

        const ratio: number = EthUsdcWallet._tokenRatioByValue(usdc, weth, price)

        expect(ratio).to.equal(2.0)
    })

    it('Should be 0.5 for some other specific values', async function() {
        const usdc: BigNumber = BigNumber.from('1000000000')          // USDC 1,000.00
        const weth: BigNumber = BigNumber.from('2000000000000000000') // WETH 2.0

        // This is USDC * 10e6, eg. 1_000_000_000 when the price of ETH is USD 1,000.
        const price: BigNumber = BigNumber.from('1000000000')

        const ratio: number = EthUsdcWallet._tokenRatioByValue(usdc, weth, price)

        expect(ratio).to.equal(0.5)
    })
})
