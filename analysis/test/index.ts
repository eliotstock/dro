import { expect } from 'chai'
import { rerangingInterval, apy } from '../src'

describe('Reranging interval', function () {
    it('Should return 1 year for given timestamps', async function () {
        const interval = rerangingInterval('2021-05-05T22:15:01.000Z', '2022-05-05T22:15:01.000Z')

        expect(interval).to.equals(1.0)
    })
})

describe('APY calculation', function () {
    it('Should return 100% for one year when ending balance is double starting balance', async function () {
        const a = apy('2021-01-01T00:00:00.000Z', '2022-01-01T00:00:00.000Z', 100.0, 200.0)

        expect(a).to.equals(1.0)
    })

    it('Should return 0% for one year when ending balance is same as starting balance', async function () {
        const a = apy('2021-01-01T00:00:00.000Z', '2022-01-01T00:00:00.000Z', 100.0, 100.0)

        expect(a).to.equals(0.0)
    })
})
