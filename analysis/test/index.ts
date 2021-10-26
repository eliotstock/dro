import { expect } from 'chai'
import { rerangingInterval } from '../src'

describe('Reranging interval', function () {
    it('Should return 1 year for given timestamps', async function () {
        const interval = rerangingInterval('2021-05-05T22:15:01.000Z', '2022-05-05T22:15:01.000Z')

        expect(interval).to.equals(1.0)
    })
})
