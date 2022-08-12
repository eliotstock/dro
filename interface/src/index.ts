import { config } from 'dotenv'
import { ethers } from 'ethers'
import { abi as NonfungiblePositionManagerABI }
    from '@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json'
import { Log, TransactionReceipt, TransactionResponse } from '@ethersproject/abstract-provider'
import { AlchemyProvider, EtherscanProvider, JsonRpcProvider } from '@ethersproject/providers'
import { ADDR_POSITIONS_NFT_FOR_FILTER, ADDR_TOKEN_USDC, ADDR_TOKEN_WETH } from './constants'
import { abi as WethABI } from './abi/weth.json'
import { abi as Erc20ABI } from './abi/erc20.json'
import {
  createPositionsWithLogs, setDirection, setFees, setRangeWidth, setOpeningLiquidity, getArgsOrDie,
  setGasPaid, getPrices, setOpeningClosingPrices, setSwapTx, setAddRemoveTxReceipts, setTimestamps,
  getBalanceAtBlockNumber,
  generateCsvEthUsdcBalances,
  generateCsvLiquidityInEth,
  generateCsvBreakdown,
  generateCsvPnL,
  generateCsvLiquiditySplit,
  generateCsvLiquidityInUsdc
} from './functions'
import moment from 'moment'
import { formatEther, formatUnits } from '@ethersproject/units'
import { Network } from '@ethersproject/networks'

// Read our .env file
config()

// Data required for calculating the return of a given position:
// * Opening liquidity (in WETH and USDC, from add tx logs)
// * Either:
//   * Fees claimed (in WETH and USDC, from remove tx logs)
//   * Gas cost (in WETH and in USDC terms) from add, remove and swap txs
//   * Impermanent loss calculation, from opening liquidity and range width
// * Or simply:
//   * Opening and closing account balances (in WETH, USDC and ETH)
// * Price history, to get from things in ETH to things in USD
// * Time position was open in days (from timestamp of add and remove txs)

async function main() {
  const stopwatchStart = Date.now()

  const [chainId, address, etherscanApiKey, alchemyApiKey] = getArgsOrDie()

  // Use Alchemy to get historical ETH and ERC-20 balances.
  // Use Etherscan for everything else.
  // Both require an API key. Neither require a paid tier account.
  const PROVIDER_ALCHEMY = new AlchemyProvider(chainId, alchemyApiKey)
  const PROVIDER_ETHERSCAN = new EtherscanProvider(chainId, etherscanApiKey)

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
  // const poolPricesPromise: Promise<Map<number, bigint>> = getPrices(blockNumbers, PROVIDER_ETHERSCAN)

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
  // const poolPrices: Map<number, bigint> = await poolPricesPromise

  // Find prices at the blocks when we opened and closed each position.
  // setOpeningClosingPrices(positions, poolPrices)

  // TODO: Get the opening price from the swap TX, swap event log, tick data. Use tick2Price from
  // the Uniswap repo.

  // Find the timestamps for opening and closing the position.
  await setTimestamps(positions, PROVIDER_ETHERSCAN)

  // Total account balance, denominated in ETH and USDC, over time.
  // await generateCsvEthUsdcBalances(address, positions, contractWeth, contractUsdc, poolPrices,
  //   PROVIDER_ALCHEMY)

  // Opening and closing liquidity for each position.
  generateCsvLiquiditySplit(positions)

  // feesTotalInEth - totalGasPaidInEth - impermanentLossInEth = netReturnInEth
  // generateCsvBreakdown(positions)

  // Observed IL = balance after remove tx - balance before add tx - fees claimed + gas cost.
  // await generateCsvPnL(address, positions, contractWeth, contractUsdc, poolPrices, PROVIDER_ALCHEMY)

  const stopwatchMillis = (Date.now() - stopwatchStart)
  console.log(`Done in ${Math.round(stopwatchMillis / 1_000 / 60)} mins`)
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
