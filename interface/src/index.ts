import { config } from 'dotenv'
import { ethers } from 'ethers'
import { abi as NonfungiblePositionManagerABI }
    from '@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json'
import { Log, TransactionReceipt, TransactionResponse } from '@ethersproject/abstract-provider'
import { AlchemyProvider, EtherscanProvider } from '@ethersproject/providers'
import { ADDR_POSITIONS_NFT_FOR_FILTER, ADDR_TOKEN_USDC, ADDR_TOKEN_WETH } from './constants'
import { abi as WethABI } from './abi/weth.json'
import { abi as Erc20ABI } from './abi/erc20.json'
import {
  createPositionsWithLogs, setDirection, setFees, setRangeWidth, setOpeningLiquidity, getArgsOrDie,
  setGasPaid, getPrices, setOpeningClosingPrices, setSwapTx, setAddRemoveTxReceipts, setTimestamps,
  getBalanceAtBlockNumber
} from './functions'
import moment from 'moment'
import { formatEther, formatUnits } from '@ethersproject/units'

// Read our .env file
config()

// Data required for calculating the APY% of a given position:
// * Time position was open in days (from timestamp of add and remove txs)
// * Opening liquidity (in WETH and USDC, from add tx logs)
// * Fees claimed (in WETH and USDC, from remove tx logs)
// * Gas cost (in WETH and in USDC terms) from add, remove and swap txs
// * Impermanent loss calculation, from opening liquidity and range width
// * Price history, to get from ETH gas costs to USD gas costs

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

  // Start getting prices from the pool event logs now, in parallel to the work below.
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

  // Find prices at the blocks when we opened and closed each position.
  setOpeningClosingPrices(positions, poolPrices)

  // Find the timestamps for opening and closing the position.
  await setTimestamps(positions, PROVIDER_ETHERSCAN)

  console.log(`Closing timestamp, closing ETH/USDC price, direction, time open in hours, ETH balance after remove tx, USDC balance after remove tx`)

  for (let [tokenId, position] of positions) {
    if (position.closedTimestamp === undefined) continue

    const closingTimestamp = moment.unix(position.closedTimestamp).toISOString()
    const closingBlockNumber = position.closingBlockNumber()
    const closingPrice = position.priceAtClosing != null ? position.priceAtClosing : 0n

    const [balanceInEth, balanceInUsdc] = await getBalanceAtBlockNumber(address,
      closingBlockNumber, contractWeth, contractUsdc, poolPrices, PROVIDER_ALCHEMY)

    const timeOpenInHours = position.timeOpen().asHours()

    console.log(`${closingTimestamp}, ${formatUnits(closingPrice, 6)}, ${position.traded}, \
${timeOpenInHours}, ${formatEther(balanceInEth)}, ${formatUnits(balanceInUsdc, 6)}`)
  }

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
