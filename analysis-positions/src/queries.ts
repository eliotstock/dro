import fs from 'fs'
import { resolve } from 'path'
import { BigQuery }  from '@google-cloud/bigquery'
import * as c from './constants'
import { sqlForPriceHistory } from './price-history'

// Relational diagram for bigquery-public-data.crypto_ethereum:
//   https://medium.com/google-cloud/full-relational-diagram-for-ethereum-public-data-on-google-bigquery-2825fdf0fb0b
// Don't bother joining on the transaction table at this stage - the results will not be
// array-ified to put the logs under the transactions, the way topics are under the logs.
function sqlForAddRemoveLiquidity(poolAddress: string, firstTopic: string) {
    return `select block_timestamp, transaction_hash, address, data, topics
    from bigquery-public-data.crypto_ethereum.logs
    where transaction_hash in (
      select distinct(transaction_hash)
      from bigquery-public-data.crypto_ethereum.logs
      where address = "${poolAddress}"
      and topics[SAFE_OFFSET(0)] = "${firstTopic}"
    )
    order by block_timestamp, log_index`
}

//  Sample row:
// {
//     block_timestamp: BigQueryTimestamp { value: '2021-05-04T23:10:00.000Z' },
//     transaction_hash: '0x89d75075eaef8c21ab215ae54144ba563b850ee7460f89b2a175fd0e267ed330',
//     address: '0x1f98431c8ad98523631ae4a59f267346ea31f984',
//     data: '0x000000000000000000000000000000000000000000000000000000000000003c0000000000000000000000008ad599c3a0ff1de082011efddc58f1908eb6e6d8',
//     topics: [
//         '0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118',
//         '0x000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
//         '0x000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
//         '0x0000000000000000000000000000000000000000000000000000000000000bb8'
//     ]
// }

const OUT_DIR = './out'
const ADDS = OUT_DIR + '/adds.json'
const REMOVES = OUT_DIR + '/removes.json'
const PRICES = OUT_DIR + '/prices.json'

// Query Google's public dataset for Ethereum mainnet transaction logs.
// Billing: https://console.cloud.google.com/billing/005CEF-5B6B62-DD610F/reports;grouping=GROUP_BY_SKU;projects=dro-backtest?project=dro-backtest
async function runQueries() {
    if (process.env.GCP_PROJECT_ID == undefined)
        throw "No GCP_PROJECT_ID in .env file (or no .env file)."

    if (process.env.GCP_KEY_PATH == undefined)
        throw "No GCP_KEY_PATH in .env file (or no .env file)."

    const config = {
        projectId: process.env.GCP_PROJECT_ID,
        keyPath: resolve(process.env.GCP_KEY_PATH)
    }
    // console.log(`GCP config:`, config)

    // Merely passing our config to the BigQuery constructor is not sufficient. We need to set this
    // on the environment too.
    process.env.GOOGLE_APPLICATION_CREDENTIALS = config.keyPath

    const bigQueryClient = new BigQuery(config)

    const stopwatchStart = Date.now()
    console.log("Querying...")

    // Find all logs from transactions that were adding liquidity to the pool.
    const sqlQueryAdds = sqlForAddRemoveLiquidity(c.ADDR_POOL, c.TOPIC_MINT)

    const optionsAdds = {
        query: sqlQueryAdds,
        location: 'US',
    }

    const [rowsAdds] = await bigQueryClient.query(optionsAdds)

    // The result is 280K rows, starting on 2021-05-05 when Uniswap v3 went live. Good.
    // This is 150 MB to download each time we run without cache.
    console.log(`  Add log events row count: ${rowsAdds.length}`)

    const addsJson = JSON.stringify(rowsAdds)
    fs.writeFileSync(ADDS, addsJson)
    
    // Find all logs from transactions that were removing liquidity from the pool.
    const sqlQueryRemoves = sqlForAddRemoveLiquidity(c.ADDR_POOL, c.TOPIC_BURN)
    
    const optionsRemoves = {
        query: sqlQueryRemoves,
        location: 'US',
    }

    const [rowsRemoves] = await bigQueryClient.query(optionsRemoves)

    // The result is 340K rows.
    // This is 180 MB to download each time we run without cache.
    console.log(`  Remove log events row count: ${rowsRemoves.length}`)

    const removesJson = JSON.stringify(rowsRemoves)
    fs.writeFileSync(REMOVES, removesJson)

    // Get a price history for the pool.
    const sqlQueryPrices = sqlForPriceHistory(c.ADDR_POOL, c.TOPIC_SWAP)

    const optionsPrices = {
        query: sqlQueryPrices,
        location: 'US',
    }

    const [rowsPrices] = await bigQueryClient.query(optionsPrices)

    console.log(`  Price history row count: ${rowsPrices.length}`)

    const pricesJson = JSON.stringify(rowsPrices)
    fs.writeFileSync(PRICES, pricesJson)

    // Don't stop the stopwatch until we've iterated over the data.
    const stopwatchMillis = (Date.now() - stopwatchStart)
    console.log(`... done in ${Math.round(stopwatchMillis / 1_000)}s`)

    return [rowsAdds, rowsRemoves, rowsPrices]
}

// Get data from cache if possible, BigQuery if not.
export async function getData() {
    if (!fs.existsSync(OUT_DIR)) {
        fs.mkdirSync(OUT_DIR)
    }

    let adds
    let removes
    let prices

    if (fs.existsSync(ADDS) && fs.existsSync(REMOVES) && fs.existsSync(PRICES)) {
        console.log(`Using cached query results`)

        const addsJson = fs.readFileSync(ADDS, 'utf8')
        adds = JSON.parse(addsJson)
        console.log(`  Add log events row count: ${adds.length}`)

        const removesJson = fs.readFileSync(REMOVES, 'utf8')
        removes = JSON.parse(removesJson)
        console.log(`  Remove log events row count: ${removes.length}`)

        const pricesJson = fs.readFileSync(PRICES, 'utf8')
        prices = JSON.parse(pricesJson)
        console.log(`  Prices row count: ${prices.length}`)
    }
    else {
        [adds, removes, prices] = await runQueries()
    }

    return [adds, removes, prices]
}
