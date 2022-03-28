import { expect } from "chai"
import { config } from "yargs"
import { currentTokenId, positionManagerContract } from "../src/uniswap"

// Not yet working - balanceOf() always returns 0 and we have specified no provider here yet.
/*
config()

// This account has no open positions but many closed ones.
const ADDRESS_ALL_CLOSED = '0xTODO'

// This account has one open position and many closed ones.
const ADDRESS_ONE_OPEN = '0xTODO'

describe('The NFT balance of an account with', function() {
    it('no open positions but many closed ones is zero', async function() {
        const n = await positionManagerContract.balanceOf(ADDRESS_ALL_CLOSED)

        expect(n.toBigInt()).to.equal(0n)
    })

    it('one open position and many closed ones is one', async function() {
        const n = await positionManagerContract.balanceOf(ADDRESS_ONE_OPEN)

        expect(n.toBigInt()).to.equal(1n)
    })
})

describe('Our function currentTokenId()', function() {
    it('should return undefined when all positions are closed', async function() {
        const t = await currentTokenId(ADDRESS_ALL_CLOSED)

        expect(t).to.be.undefined
    })

    it('should return an integer when one position is open', async function() {
        const t = await currentTokenId(ADDRESS_ONE_OPEN)

        console.log(`Toekn ID: ${t}`)

        expect(t).to.be.not.undefined
    })
})
*/
