import { config } from 'dotenv'
import { resolve } from 'path'
import { ethers } from 'ethers'
import { abi as IUniswapV3PoolABI } from '@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json'
import { tickToPrice, nearestUsableTick, TickMath } from '@uniswap/v3-sdk'
import { Token } from '@uniswap/sdk-core'
import { BigQuery }  from '@google-cloud/bigquery'
import invariant from 'tiny-invariant'
import stringify from 'csv-stringify/lib/sync'
import parse from 'csv-parse/lib/sync'
import moment from 'moment'
import fs from 'fs'

const CHAIN_ID = 1

// Uniswap v3 positions NFT
const ADDR_POSITIONS_NFT = '0xc36442b4a4522e871399cd717abdd847ab11fe88'

// USDC/WETH 0.30%
// https://info.uniswap.org/#/pools/0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8
// 280K event logs
const ADDR_POOL = '0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8'

// USDC/WETH 0.05%
// https://info.uniswap.org/#/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640
// 114K event logs
// const ADDR_POOL = '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640'

// EOA with some position history
const ADDR_RANGE_ORDER_MANUAL = '0x4d35A946c2853DB8F40E1Ad1599fd48bb176DE5a'

// WETH
const ADDR_TOKEN_WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'

// USDC
const ADDR_TOKEN_USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'

const TOPIC_MINT = '0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde'
const TOPIC_BURN = '0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c'
const TOPIC_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

// const TOKEN_USDC = new Token(CHAIN_ID, ADDR_TOKEN_USDC, 6, "USDC", "USD Coin")

// const TOKEN_WETH = new Token(CHAIN_ID, ADDR_TOKEN_WETH, 18, "WETH", "Wrapped Ether")

// const INTERFACE_POOL = new ethers.utils.Interface(IUniswapV3PoolABI)

const TIMESTAMP_FORMAT = 'YYYY-MM-DDTHH:mm:ss.SSSZ'

const OUT_DIR = './out'
const TXS_CSV = OUT_DIR + '/txs.csv'

// Read our .env file
config()

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

    // Now find all logs with that topic for the above pool address.
    const sqlQueryAdds = `
select block_timestamp, transaction_hash, address, data, topics
from bigquery-public-data.crypto_ethereum.logs
where transaction_hash in (
  select distinct(transaction_hash)
  from bigquery-public-data.crypto_ethereum.logs
  where address = "${ADDR_POOL}"
  and topics[SAFE_OFFSET(0)] = "${TOPIC_MINT}"
)
order by block_timestamp, log_index`

    const options = {
        query: sqlQueryAdds,
        location: 'US',
    }

    const stopwatchStart = Date.now()
    console.log("Querying...")
    const [rows] = await bigQueryClient.query(options)

    // The result is 280K rows, starting on 2021-05-05 when Uniswap v3 went live. Good.
    // This is about ?MB to download each time we run (at ?K or so per row).
    console.log(`  Row count: ${rows.length}`)

    console.log("First row:")
    console.dir(rows[0])
    /*
{
  block_timestamp: BigQueryTimestamp { value: '2021-05-04T23:10:00.000Z' },
  transaction_hash: '0x89d75075eaef8c21ab215ae54144ba563b850ee7460f89b2a175fd0e267ed330',
  address: '0x1f98431c8ad98523631ae4a59f267346ea31f984',
  data: '0x000000000000000000000000000000000000000000000000000000000000003c0000000000000000000000008ad599c3a0ff1de082011efddc58f1908eb6e6d8',
  topics: [
    '0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118',
    '0x000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    '0x000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    '0x0000000000000000000000000000000000000000000000000000000000000bb8'
  ]
}
    */
}

async function main() {
    if (!fs.existsSync(OUT_DIR)) {
        fs.mkdirSync(OUT_DIR)
    }

    if (fs.existsSync(TXS_CSV)) {
        console.log(`Using cached query results`)

        const csv = fs.readFileSync(TXS_CSV, 'utf8')
        // swapEvents = parse(csv, {columns: true, cast: true})
    }
    else {
        await runQueries()
    }

    console.log(`Analysing...`)
}

main().catch((error) => {
    console.error(error)
    process.exitCode = 1
})
