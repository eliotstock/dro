import { config } from 'dotenv'
import { ethers } from 'ethers'
import { abi as NonfungiblePositionManagerABI }
    from '@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json'
import { Log, TransactionReceipt, TransactionResponse } from '@ethersproject/abstract-provider'
import { AlchemyProvider, EtherscanProvider } from '@ethersproject/providers'
import { formatEther } from '@ethersproject/units'
import { ADDR_POSITIONS_NFT_FOR_FILTER, ADDR_TOKEN_USDC, ADDR_TOKEN_WETH } from './constants'
import { abi as WethABI } from './abi/weth.json'
import { abi as Erc20ABI } from './abi/erc20.json'
import {
  createPositionsWithLogs, setDirection, setFees, setRangeWidth, setOpeningLiquidity, getArgsOrDie, setGasPaid, getPrices, setOpeningClosingPrices, setSwapTx, setAddRemoveTxReceipts, setTimestamps, getBalanceInEthAtBlockNumber
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
  const stopwatchStart = Date.now()

  const [address, etherscanApiKey, alchemyApiKey] = getArgsOrDie()

  // Use Alchemy to get historical ETH and ERC-20 balances.
  // Use Etherscan for everything else.
  // Both require an API key. Neither require a paid tier account.
  const PROVIDER_ALCHEMY = new AlchemyProvider(undefined, alchemyApiKey)
  const PROVIDER_ETHERSCAN = new EtherscanProvider(undefined, etherscanApiKey)

  const contractWeth = new ethers.Contract(ADDR_TOKEN_WETH, WethABI, PROVIDER_ALCHEMY)
  const contractUsdc = new ethers.Contract(ADDR_TOKEN_USDC, Erc20ABI, PROVIDER_ALCHEMY)

  const contractPositionManager = new ethers.Contract(
    ADDR_POSITIONS_NFT_FOR_FILTER,
    NonfungiblePositionManagerABI,
    PROVIDER_ETHERSCAN
  )

  // This count includes all the closed positions.
  const positionCount = await contractPositionManager.balanceOf(address)

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
  const allTxs: Array<TransactionResponse> = await PROVIDER_ETHERSCAN.getHistory(address)

  console.log(`Transactions from this address: ${allTxs.length}`)

  const blockNumbers = Array<number>()
  const blockHashes = Array<string>()
  const allLogs = Array<Array<Log>>()

  for (const txResponse of allTxs) {
    if (txResponse.blockNumber === undefined) return

    blockNumbers.push(txResponse.blockNumber)
    if (txResponse.blockHash != undefined) blockHashes.push(txResponse.blockHash)

    const txReceipt: TransactionReceipt = await PROVIDER_ETHERSCAN.getTransactionReceipt(txResponse.hash)

    console.log(`Got ${txReceipt.logs.length} logs for TX ${txReceipt.transactionHash}`)

    allLogs.push(txReceipt.logs)
  }

  // Start getting prices from the pool event logs now.
  const poolPricesPromise: Promise<Map<number, bigint>> = getPrices(blockNumbers, PROVIDER_ETHERSCAN)

  const positions = createPositionsWithLogs(allLogs)

  // Set direction on each position
  setDirection(positions)

  // Set fees earned on each position
  setFees(positions)
  
  // Set the range width based on the tick upper and lower from the logs.
  setRangeWidth(positions)

  // Set the opening liquidity based on the token transfers from the logs.
  setOpeningLiquidity(positions)

  await setAddRemoveTxReceipts(positions, PROVIDER_ETHERSCAN)

  await setSwapTx(positions, allTxs, PROVIDER_ETHERSCAN)

  await setGasPaid(positions, PROVIDER_ETHERSCAN)

  // Block till we've got our prices.
  const poolPrices: Map<number, bigint> = await poolPricesPromise

  for (const blockNumber of blockNumbers) {
    const balanceInEth = await getBalanceInEthAtBlockNumber(address, blockNumber,
      contractWeth, contractUsdc, poolPrices, PROVIDER_ALCHEMY)
  }

//   // Find prices at the blocks when we opened and closed each position.
//   // TODO: Why are we missing prices for five blocks, and are these blocks we really need prices
//   // for (add and remove blocks)?
//   setOpeningClosingPrices(positions, poolPrices)

//   // Find the timestamps for opening and closing the position.
//   await setTimestamps(positions, PROVIDER_ETHERSCAN)

//   let totalNetYieldInEth = 0n

//   console.log(`Token ID: feesTotalInEth - totalGasPaidInEth = netYieldInEth over timeOpenInDays`)

//   for (let [tokenId, position] of positions) {
//     try {
//       console.log(`${tokenId}: ${position.feesTotalInEth()} - ${position.totalGasPaidInEth()} = \
// ${position.netYieldInEth()} ETH over ${position.timeOpenInDays()} days`)

//       totalNetYieldInEth += position.netYieldInEth()
//     }
//     catch (e) {
//       console.log(`${tokenId}: ${e}`)
//     }
//   }

//   // 1.2 ETH
//   const formatted = ethers.utils.formatEther(totalNetYieldInEth)

//   console.log(`Total net yeild: ${formatted} ETH`)

  const stopwatchMillis = (Date.now() - stopwatchStart)
  console.log(`Done in ${Math.round(stopwatchMillis / 1_000 / 60)} mins`)
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
