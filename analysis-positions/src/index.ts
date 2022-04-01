import { config } from 'dotenv'
import moment from 'moment'
import { getData } from './queries'
import { logsByTxHash, logsByTokenId, positionsByTokenId, setDirectionAndFIlterToOutOfRange, setFees, setAddTxLogs, setRangeWidth, setOpeningLiquidity } from './functions'
import { SwapEvent, rowToSwapEvent } from './price-history'

// const TIMESTAMP_FORMAT = 'YYYY-MM-DDTHH:mm:ss.SSSZ'

// Read our .env file
config()

async function main() {
    let [adds, removes, prices] = await getData()

    console.log(`Price 0: ${JSON.stringify(prices[0])}`)

    console.log(`Analysing...`)

    // Keys: tx hashes, values: array of EventLogs
    const removeTxLogs = logsByTxHash(removes)
    const addTxLogs = logsByTxHash(adds)

    console.log(`Remove transactions: ${removeTxLogs.size}, add transactions: ${addTxLogs.size}`)

    // Create positions for each remove transaction with only the tokenId and remove TX logs
    // populated at this stage.
    const positions = positionsByTokenId(removeTxLogs)
    // console.log(`Sample position, with logs: ${JSON.stringify(positions.get(198342))}`)

    // Now do a second pass to set the direction, since other values depend on that. While we're
    // here, filter out the positions that were closed in-range.
    setDirectionAndFIlterToOutOfRange(positions)
    // console.log(`Sample position, with direction: ${JSON.stringify(positions.get(198342))}`)

    // Set fees, based on the direction.
    setFees(positions)
    // console.log(`Sample position, traded down into WETH: ${JSON.stringify(positions.get(198342))}`)
    // console.log(`Sample position, traded up into USDC: ${JSON.stringify(positions.get(204635))}`)

    // 0.211 WETH and 534.97 USDC
    // console.log(`Sample position, traded down into WETH: ${positions.get(198342)?.feesLog()}`)

    // 0.037 WETH and 170.48 USDC
    // console.log(`Sample position, traded up into USDC: ${positions.get(204635)?.feesLog()}`)

    const addTxLogsByTokenId = logsByTokenId(addTxLogs)
    // console.log(`Sample add tx logs: ${JSON.stringify(addTxLogsByTokenId.get(198342))}`)
    // console.log(`Sample add tx logs: ${JSON.stringify(addTxLogsByTokenId.get(204635))}`)

    setAddTxLogs(positions, addTxLogsByTokenId)
    // console.log(`Sample add tx logs: ${JSON.stringify(positions.get(198342))}`)
    // console.log(`Sample add tx logs: ${JSON.stringify(positions.get(204635))}`)

    setRangeWidth(positions)

    setOpeningLiquidity(positions)

    // 21,590 USDC and 7.473 WETH
    // console.log(`Sample position: ${positions.get(198342)?.openingLiquidityUsdc} USDC and ${positions.get(198342)?.openingLiquidityWeth} WETH`)

    // 19,413 USDC and 7.632 WETH
    // console.log(`Sample position: ${positions.get(204635)?.openingLiquidityUsdc} USDC and ${positions.get(204635)?.openingLiquidityWeth} WETH`)

    console.log(`Positions: ${positions.size}`)

    // for (let [tokenId, position] of positions) {
    //     console.log(`${position.rangeWidthBps}`)
    // }
    const swapEvents: SwapEvent[] = []

    prices.forEach(function(row: any) {
        let e = rowToSwapEvent(row)
        swapEvents.push(e)
    })

    console.log(`First swap event: ${JSON.stringify(swapEvents[0])}`)
}

main().catch((error) => {
    console.error(error)
    process.exitCode = 1
})
