import { config } from 'dotenv'
import { getData } from './queries'
import { logsByTxHash, logsByTokenId, positionsByTokenId, setDirectionAndFilterToOutOfRange,
    setFees, setAddTxLogs, setRangeWidth, setOpeningLiquidity, setOpeningClosingPrices,
    cleanData, generateCsv, abbreviate
} from './functions'

// Read our .env file
config()

async function main() {
    // These are event log rows, each with one data field and an array of up to four topics.
    let [adds, removes, prices] = await getData()

    console.log(`Analysing...`)

    // Keys: tx hashes, values: array of EventLogs
    const removeTxLogs = logsByTxHash(removes)
    const addTxLogs = logsByTxHash(adds)

    console.log(`  Valid add transactions: ${addTxLogs.size}, remove transactions: ${removeTxLogs.size}`)

    // Create positions for each remove transaction with only the tokenId and remove TX logs
    // populated at this stage.
    const positions = positionsByTokenId(removeTxLogs)
    // console.log(`Sample position, with logs: ${JSON.stringify(positions.get(198342))}`)

    // console.log(`  Data contains experimental position, token ID...`)
    // console.log(`  148298: ${positions.get(148298) != undefined}`)
    // console.log(`  148299: ${positions.get(148299) != undefined}`)
    // console.log(`  148300: ${positions.get(148300) != undefined}`)
    // console.log(`  148301: ${positions.get(148301) != undefined}`)

    // Now do a second pass to set the direction, since other values depend on that. While we're
    // here, filter out the positions that were closed in-range.
    setDirectionAndFilterToOutOfRange(positions)
    // console.log(`Sample position, with direction: ${JSON.stringify(positions.get(198342))}`)

    // console.log(`  Data contains experimental position, token ID...`)
    // console.log(`  148298: ${positions.get(148298) != undefined}`)
    // console.log(`  148299: ${positions.get(148299) != undefined}`)
    // console.log(`  148300: ${positions.get(148300) != undefined}`)
    // console.log(`  148301: ${positions.get(148301) != undefined}`)

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

    setOpeningClosingPrices(positions, prices)

    // 2,916.98
    // console.log(`Pool price at 2022-03-01: ${priceAt('2022-03-01T00:00:01.000Z')}`)

    // 1,070_15 USDC
    // console.log(`Sample position, total fees: ${positions.get(198342)?.feesTotalInUsdc()} USDC`)

    // 281.75 USDC
    // console.log(`Sample position, total fees: ${positions.get(204635)?.feesTotalInUsdc()} USDC`)

    // 42,719.52 USDC
    // console.log(`Sample position, opening liquidity: ${positions.get(198342)?.openingLiquidityTotalInUsdc()} USDC`)

    // 40,543.93 USDC
    // console.log(`Sample position, opening liquidity: ${positions.get(204635)?.openingLiquidityTotalInUsdc()} USDC`)

    // 250%
    // console.log(`Sample position, gross yield: ${positions.get(198342)?.grossYield()}%`)

    // 69%
    // console.log(`Sample position, gross yield: ${positions.get(204635)?.grossYield()}%`)

    cleanData(positions)

    console.log(`  Positions: ${positions.size}`)

    generateCsv(positions)
}

main().catch((error) => {
    console.error(error)
    process.exitCode = 1
})
