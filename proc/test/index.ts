import moment, { Duration } from 'moment'
import { expect } from 'chai'

describe('moment.js durations', function () {
    it('Should be comparable using >', async function() {
        const threeMins = moment.duration(3, 'minutes')
        const twoMins = moment.duration(2, 'minutes')

        expect(threeMins > twoMins)
    })
})
