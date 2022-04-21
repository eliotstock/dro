import { config } from 'dotenv'
import { ethers } from 'ethers'
import { abi as NonfungiblePositionManagerABI }
    from '@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json'
import { Log, TransactionReceipt, TransactionResponse } from '@ethersproject/abstract-provider'
import { EtherscanProvider } from '@ethersproject/providers'
import { formatEther } from '@ethersproject/units'
import { ADDR_POSITIONS_NFT_FOR_FILTER } from './constants'
import {
  createPositionsWithLogs, setDirection, setFees, setRangeWidth, setOpeningLiquidity, getArgsOrDie, setGasPaid, getPrices, setOpeningClosingPrices, setSwapTx, setAddRemoveTxReceipts
} from './functions'

// Read our .env file
config()

// Data required for calculating the APY% of a given position:
// * Time position was open in days (from timestamp of add and remove txs)
// * Opening liquidity (in WETH and USDC, from add tx logs)
// * Fees claimed (in WETH and USDC, from remove tx logs)
// * Gas cost (in WETH and in USDC terms) from add, remove and swap txs
// * Price history, to get from ETH gas costs to USD gas costs

// Design
// 1. [DONE] From Etherscan provider, get all transactions for this address (swaps, adds, removes, unwraps)
// 2. [DONE] For each tx, get block number
// 3. [DONE] From Etherscan provider, for each block number, get all tx logs from the positions NFT address for these blocks only
// 4. [DONE] Get price history for only the period from first tx to last tx timestamp. Or only blocks in which we transacted, ideally.
// 5. Use analytics-positions code to build Position instances from logs:
//   a. [WON'T DO] Map of logs keyed by tx hashes (do we need this?)
//   b. [DONE] Map of Positions, each with arrays of logs on them
//      Both add tx and remove tx logs have the token ID in them, in different topics.
//   d  [DONE] Filter Position array to those that are in set of our own token IDs (or look for our address as sender in the logs?)
//   d. [MOSTLY DONE] Set direction on each Position based on logs
//   e. [DONE] Set fees based on logs
//   f. [DONE] Set range width based on logs
//   g. [DONE] Set opening liquidity based on logs
//   h. [DONE] Set opening and closing prices from tx timestamps and price history
//   i. [DONE] Set gas cost in ETH based on all txs
//   j. [DONE] Find the swap transaction receipt that preceeded each add tx and add it to the position.
//   k. [DONE] Find the swap tx logs and add them to the position.
// 6. [DONE] Get all token IDs for this account from Uniswap position manager contract
// 7. Calc APY% from that set of Position instances

async function main() {
  const [address, etherscanApiKey] = getArgsOrDie()

  const PROVIDER = new EtherscanProvider(undefined, etherscanApiKey)

  // TODO: Now that this has been committed (oops) I need to delete the API key.
  // const PROVIDER_ALCHEMY = new AlchemyProvider(undefined, 'NJhHpafwsqTku1zBNDC0N61Q1mTvYjVU')

  const positionManagerContract = new ethers.Contract(
    ADDR_POSITIONS_NFT_FOR_FILTER,
    NonfungiblePositionManagerABI,
    PROVIDER
  )

  // This count includes all the closed positions.
  const positionCount = await positionManagerContract.balanceOf(address)

  console.log(`Positions (closed and open): ${positionCount}.`)

  // const ownTokenIds = Array<number>()

  // for (let i = 0; i < positionCount; i++) {
  //   const tokenId = await positionManagerContract.tokenOfOwnerByIndex(address, i)
  //   ownTokenIds.push(Number(tokenId))
  // }

  // if (ownTokenIds.length != positionCount) {
  //   throw `This account has ${positionCount} positions but ${ownTokenIds.length} token IDs. Fatal.`
  // }

  // This is all our transactions, not just add and remove transactions but swaps and unwrapping WETH to ETH.
  const allTxs: Array<TransactionResponse> = await PROVIDER.getHistory(address)

  console.log(`Transactions from this address: ${allTxs.length}`)

  const blockNumbers = Array<number>()
  const allLogs = Array<Array<Log>>()

  let totalGasPaidInEth = 0n

  for (const txResponse of allTxs) {
    if (txResponse.blockNumber === undefined) return

    blockNumbers.push(txResponse.blockNumber)

    // const logsForTx = await getLogsForTx(PROVIDER, txResponse)

    // console.log(`Got ${logsForTx?.length} logs for TX ${txResponse.hash}`)

    const txReceipt: TransactionReceipt = await PROVIDER.getTransactionReceipt(txResponse.hash)

    console.log(`Got ${txReceipt.logs.length} logs for TX ${txReceipt.transactionHash}`)

    allLogs.push(txReceipt.logs)

    // Note that neither of these are actually large integers.

    // Corresponds to "Gas Used by Transaction" on Etherscan. Quoted in wei.
    const gasUsed = txReceipt.gasUsed.toBigInt()

    // Corresponds to "Gas Price Paid" on Etherscan. Quoted in wei.
    const effectiveGasPrice = txReceipt.effectiveGasPrice.toBigInt()

    const gasPaidInEth = gasUsed * effectiveGasPrice
    const gasPaidInEthReadable = formatEther(gasPaidInEth - (gasPaidInEth % 100000000000000n))

    // console.log(`${txResponse.hash} gas paid: ${gasPaidInEthReadable} ETH`)

    totalGasPaidInEth += gasPaidInEth
  }

  const totalGasPaidInEthReadable = formatEther(totalGasPaidInEth - (totalGasPaidInEth % 100000000000000n))
  console.log(`Total gas paid in ETH: ${totalGasPaidInEthReadable}`)

  // Start getting prices from the pool event logs now.
  const poolPricesPromise: Promise<Map<number, bigint>> = getPrices(blockNumbers, PROVIDER)

  // if (blockNumbers.length > 0) process.exit(0)

  // console.log(`Blocks: ${blockNumbers.length}`)

  // if (blockNumbers.length != allTxs.length) {
  //   throw `This account transacted in ${blockNumbers.length} blocks but has ${allTxs.length} transactions. Fatal.`
  // }

  const positions = createPositionsWithLogs(allLogs)

  // if (ownTokenIds.length != positions.size) {
  //   throw `This account has ${ownTokenIds.length} positions but we could only find logs for ${positions.size}. Fatal.`
  // }

  // Set direction on each position
  setDirection(positions)

  // Set fees earned on each position
  setFees(positions)

  let totalFeesWeth: bigint = 0n
  let totalFeesUsdc: bigint = 0n

  for (const p of positions.values()) {
    console.log(`  Position(${p.tokenId}): fees WETH: ${p.feesWeth}, fees USDC: ${p.feesUsdc}`)

    totalFeesWeth = BigInt(totalFeesWeth) + BigInt(p.feesWeth)
    totalFeesUsdc = BigInt(totalFeesUsdc) + BigInt(p.feesUsdc)
  }

  console.log(`Total fees: USDC: ${totalFeesUsdc.toLocaleString()}, WETH: ${totalFeesWeth.toLocaleString()}`)
  
  // Set the range width based on the tick upper and lower from the logs.
  setRangeWidth(positions)

  // Set the opening liquidity based on the token transfers from the logs.
  setOpeningLiquidity(positions)

  await setAddRemoveTxReceipts(positions, PROVIDER)

  await setSwapTx(positions, allTxs, PROVIDER)

  await setGasPaid(positions, PROVIDER)

  // Block till we've got our prices.
  const poolPrices: Map<number, bigint> = await poolPricesPromise

  // Find prices at the blocks when we opened and closed each position.
  setOpeningClosingPrices(positions, poolPrices)
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
