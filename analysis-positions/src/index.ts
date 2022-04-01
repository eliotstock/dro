import { config } from 'dotenv'
import { resolve } from 'path'
import { ethers } from 'ethers'
import { abi as NonfungiblePositionManagerABI }
    from '@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json'
import { abi as WethABI } from './abi/weth.json'
import { abi as Erc20ABI } from './abi/erc20.json'
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
const ADDR_TOKEN_WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'

// USDC
const ADDR_TOKEN_USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'

const TOPIC_MINT = '0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde'
const TOPIC_BURN = '0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c'
const TOPIC_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const TOPIC_DECREASE_LIQUIDITY = '0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4'

const INTERFACE_NFT = new ethers.utils.Interface(NonfungiblePositionManagerABI)
const INTERFACE_WETH = new ethers.utils.Interface(WethABI)
const INTERFACE_USDC = new ethers.utils.Interface(Erc20ABI)

// const TOKEN_USDC = new Token(CHAIN_ID, ADDR_TOKEN_USDC, 6, "USDC", "USD Coin")

// const TOKEN_WETH = new Token(CHAIN_ID, ADDR_TOKEN_WETH, 18, "WETH", "Wrapped Ether")

// const INTERFACE_POOL = new ethers.utils.Interface(IUniswapV3PoolABI)

const TIMESTAMP_FORMAT = 'YYYY-MM-DDTHH:mm:ss.SSSZ'

const OUT_DIR = './out'
const ADDS = OUT_DIR + '/adds.json'
const REMOVES = OUT_DIR + '/removes.json'

// Read our .env file
config()

// Relational diagram for bigquery-public-data.crypto_ethereum:
//   https://medium.com/google-cloud/full-relational-diagram-for-ethereum-public-data-on-google-bigquery-2825fdf0fb0b
// Don't bother joining on the transaction table at this stage - the results will not be
// array-ified to put the logs under the transactions, the way topics are under the logs.
function sql(poolAddress: string, firstTopic: string) {
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
interface EventLog {
    block_timestamp: {value: string}
    transaction_hash: string
    address: string
    data: string
    topics: string[]
}

enum Direction {
    Up = 'up',
    Down = 'down'
}

class Position {
    tokenId: number
    removeTxLogs?: EventLog[]
    addTxLogs?: EventLog[]
    traded?: Direction
    // TODO: openedTimestamp?: string
    closedTimestamp?: string
    // TODO: rangeWidthBps: number
    feesWeth?: bigint
    feesUsdc?: bigint
    withdrawnWeth?: bigint
    withdrawnUsdc?: bigint
    closingLiquidityWeth?: bigint
    closingLiquidityUsdc?: bigint
    // TODO: priceAtClosing: bigint // Quoted in USDC as a big integer.
    // TODO: feesTotalInUsdc(): bigint // Quoted in USDC as a big integer, depends on priceAtClosing.
    // TODO: openingLiquidityTotalInUsdc(): bigint // Quoted in USDC as a big integer.

    constructor(_tokenId: number) {
        this.tokenId = _tokenId
    }

    feesWethCalculated(): bigint {
        if (this.traded == Direction.Down) {
            if (this.withdrawnWeth == undefined) throw 'Missing withdrawnWeth'
            if (this.closingLiquidityWeth == undefined) throw 'Missing closingLiquidityWeth'

            return (this.withdrawnWeth - this.closingLiquidityWeth)
        }
        else {
            throw 'Traded up, so use feesWeth property instead'
        }
    }

    feesUsdcCalculated(): bigint {
        if (this.traded == Direction.Up) {
            if (this.withdrawnUsdc == undefined) throw 'Missing withdrawnUsdc'
            if (this.closingLiquidityUsdc == undefined) throw 'Missing closingLiquidityUsdc'

            return (this.withdrawnUsdc - this.closingLiquidityUsdc)
        }
        else {
            throw 'Traded down, so use feesUsdc property instead'
        }
    }

    feesLog(): string {
        if (this.traded == Direction.Down) {
            return `${this.feesWethCalculated()} WETH and ${this.feesUsdc} USDC`
        }
        else if (this.traded == Direction.Up) {
            return `${this.feesWeth} WETH and ${this.feesUsdcCalculated()} USDC`
        }

        return 'unknown'
    }
}

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
    const sqlQueryAdds = sql(ADDR_POOL, TOPIC_MINT)

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
    const sqlQueryRemoves = sql(ADDR_POOL, TOPIC_BURN)
    
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

    // Don't stop the stopwatch until we've iterated over the data.
    const stopwatchMillis = (Date.now() - stopwatchStart)
    console.log(`... done in ${Math.round(stopwatchMillis / 1_000)}s`)

    return [rowsAdds, rowsRemoves]
}

// Given an array of event logs, build a map in which keys are tx hashes and values are arrays of
// the logs for each tx.
function logsByTxHash(logs: EventLog[]): Map<string, EventLog[]> {
    const txs = new Map<string, EventLog[]>()

    // forEach() is blocking here.
    logs.forEach(function(row: EventLog) {
        if (!row.transaction_hash) return

        let logs = txs.get(row.transaction_hash)
        if (!logs) logs = []

        logs.push(row)
        txs.set(row.transaction_hash, logs)
    })

    return txs
}

function positionsByTokenId(txMap: Map<string, EventLog[]>): Map<number, Position> {
    const positions = new Map<number, Position>()

    for (let [removeTxHash, logs] of txMap) {
        // One of the event logs contains the token ID. Use that one to create the Position
        // instance only.
        logs.forEach(function(log: EventLog) {
            // The position's token ID is given by the event log with address
            // 'Uniswap v3: Positions NFT', topic DecreaseLiquidity.
            if (log.address == ADDR_POSITIONS_NFT && log.topics[0] == TOPIC_DECREASE_LIQUIDITY) {
                // Parse hex string to decimal
                const tokenId = Number(log.topics[1])

                const position = new Position(tokenId)
                position.removeTxLogs = logs
                position.closedTimestamp = log.block_timestamp.value

                positions.set(tokenId, position)

                // No need to see the rest of the logs.
                return
            }
        })
    }

    return positions
}

function setDirectionAndFIlterToOutOfRange(positions: Map<number, Position>) {
    for (let [tokenId, position] of positions) {
        position.removeTxLogs?.forEach(function(log: EventLog) {
            if (log.address == ADDR_POSITIONS_NFT && log.topics[0] == TOPIC_DECREASE_LIQUIDITY) {
                // Decode the logs data to get amount0 and amount1 so that we can figure out
                // whether the position was closed when out of range, and if so whether the
                // market traded up or down.
                const parsedLog = INTERFACE_NFT.parseLog({topics: log.topics, data: log.data})
                const amount0: number = parsedLog.args['amount0']
                const amount1: number = parsedLog.args['amount1']

                if (amount0 == 0) {
                    // Position closed out of range and the market traded down into WETH.
                    position.traded = Direction.Down
                    // console.log(`down`)
                }
                else if (amount1 == 0) {
                    // Position closed out of range and the market traded up into USDC.
                    position.traded = Direction.Up
                    // console.log(`up`)
                }
                else {
                    // Position was closed in-range. Removing from our map.
                    positions.delete(tokenId)
                }
            }
        })
    }
}

function setFees(positions: Map<number, Position>) {
    for (let [tokenId, position] of positions) {
        position.removeTxLogs?.forEach(function(log: EventLog) {
            // For a position that traded up into USDC:
            // eg. Position 204635:
            //   https://etherscan.io/tx/0x44f29b0a779e8650045a9f9913235fbfed832d2514669dcc42c31913dcdfa183#eventlog
            if (position.traded == Direction.Up) {
                // WETH component of fees is given by the event log with address WETH,
                // Transfer() event, Data, wad value, in WETH.
                if (log.address == ADDR_TOKEN_WETH && log.topics[0] == TOPIC_TRANSFER) {
                    const parsedLog = INTERFACE_WETH.parseLog({topics: log.topics, data: log.data})
                    const wad: bigint = parsedLog.args['wad']

                    position.feesWeth = wad
                }

                // Total USDC withdrawn (fees plus liquidity) is given by the event log with
                // address USDC, Transfer() event, Data, 'value' arg, in USDC.
                if (log.address == ADDR_TOKEN_USDC && log.topics[0] == TOPIC_TRANSFER) {
                    const parsedLog = INTERFACE_USDC.parseLog({topics: log.topics, data: log.data})
                    const value: bigint = parsedLog.args['value']

                    position.withdrawnUsdc = value
                }

                // Liquidity USDC withdrawn is given by the event log with address 'Uniswap v3:
                // Positions NFT', DecreaseLiquidity() event, Data, 'amount0' arg, in USDC.
                if (log.address == ADDR_POSITIONS_NFT && log.topics[0] == TOPIC_DECREASE_LIQUIDITY) {
                    const parsedLog = INTERFACE_NFT.parseLog({topics: log.topics, data: log.data})
                    const amount0: bigint = parsedLog.args['amount0']

                    position.closingLiquidityUsdc = amount0
                }

                // USDC component of fees is given by the difference between the last two values.
            }
            // For a position that traded down into WETH:
            // eg. Position 198342:
            //   https://etherscan.io/tx/0x7ed3b7f8058194b92e59159c42fbccc9e60e32ce598830af6df0335906c6caf7#eventlog
            else if (position.traded == Direction.Down) {
                // USDC component of fees is given by the event log with address USDC,
                // Transfer() event, Data, 'value' arg, in USDC.
                if (log.address == ADDR_TOKEN_USDC && log.topics[0] == TOPIC_TRANSFER) {
                    const parsedLog = INTERFACE_USDC.parseLog({topics: log.topics, data: log.data})
                    const value: bigint = parsedLog.args['value']

                    position.feesUsdc = value
                }

                // Total WETH withdrawn (fees plus liquidity) is given by the event log with
                // address WETH, Transfer() event, Data, 'wad' arg, in WETH.
                if (log.address == ADDR_TOKEN_WETH && log.topics[0] == TOPIC_TRANSFER) {
                    const parsedLog = INTERFACE_WETH.parseLog({topics: log.topics, data: log.data})
                    const wad: bigint = parsedLog.args['wad']

                    position.withdrawnWeth = wad
                }

                // Liquidity WETH withdrawn is given by the event log with address 'Uniswap v3:
                // Positions NFT', DecreaseLiquidity() event, Data, 'amount1' arg, in WETH.
                if (log.address == ADDR_POSITIONS_NFT && log.topics[0] == TOPIC_DECREASE_LIQUIDITY) {
                    const parsedLog = INTERFACE_NFT.parseLog({topics: log.topics, data: log.data})
                    const amount1: bigint = parsedLog.args['amount1']

                    position.closingLiquidityWeth = amount1
                }

                // WETH component of fees is given by the difference between the last two values.
            }
        })
    }
}

async function main() {
    if (!fs.existsSync(OUT_DIR)) {
        fs.mkdirSync(OUT_DIR)
    }

    let adds
    let removes

    if (fs.existsSync(ADDS) && fs.existsSync(REMOVES)) {
        console.log(`Using cached query results`)

        const addsJson = fs.readFileSync(ADDS, 'utf8')
        adds = JSON.parse(addsJson)
        console.log(`  Add log events row count: ${adds.length}`)

        const removesJson = fs.readFileSync(REMOVES, 'utf8')
        removes = JSON.parse(removesJson)
        console.log(`  Remove log events row count: ${removes.length}`)
    }
    else {
        [adds, removes] = await runQueries()
    }

    console.log(`Analysing...`)

    // Keys: tx hashes, values: array of EventLogs
    const removeTxLogs = logsByTxHash(removes)

    // TODO: We don't need this. Instead we need addTxLogsByTokenId. Similar to positionsByTokenId().
    const addTxLogs = logsByTxHash(adds)

    console.log(`remove transactions: ${removeTxLogs.size}, add transactions: ${addTxLogs.size}`)

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
    console.log(`Sample position, traded down into WETH: ${JSON.stringify(positions.get(198342))}`)
    console.log(`Sample position, traded up into USDC: ${JSON.stringify(positions.get(204635))}`)

    console.log(`Positions: ${positions.size}`)

    // 0.211 WETH and 534.97 USDC
    console.log(`Sample position, traded down into WETH: ${positions.get(198342)?.feesLog()}`)

    // 0.037 WETH and 170.48 USDC
    console.log(`Sample position, traded up into USDC: ${positions.get(204635)?.feesLog()}`)
}

main().catch((error) => {
    console.error(error)
    process.exitCode = 1
})
