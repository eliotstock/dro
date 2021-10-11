import { config } from 'dotenv'
import { ethers } from 'ethers'
import { Pool } from "@uniswap/v3-sdk"
import { Token } from "@uniswap/sdk-core"
import { abi as IUniswapV3PoolABI } from "@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json"
import moment from 'moment'
import { useConfig } from './config'
import { getPoolImmutables, getPoolState } from './uniswap'
import { DRO } from './dro'

// TODO
// ----
// (P1) Know what our current balance of ETH, WETH and USDC is, right after removing liquidity
// (P2) While we're waiting for any transaction, don't begin re-ranging again
// (P2) Remove an existing liquidity position (but fail because no position yet)
// (P1) Know when we're out of range directly from the existing liquidity position and stop tracking min and max ticks locally
// (P2) Execute a swap for a known amount of ETH (half our account balance, less some savings for execution)
// (P2) Execute a swap for a known amount of USDC (half our account balance)
// (P2) Keep track of how much ETH to keep on hand for gas and swap costs
// (P3) Build the URL of the position, based on the serial number, and log it
// (P3) Know the current price of gas
// (P3) Don't re-range when the current price of gas is over a constant threshold

// Done
// ----
// (P1) Fix the range width arithmetic
// (P1) Show the new range min and max in terms of USDC rather than ticks
// (P1) Get the current price in the pool synchronously and in terms of the quote currency
// (P1) Know when we're out of range, indirectly, based on the current price in the pool and the current min/max, which we'll store for now
// (P1) Timestamps in logging
// (P2) Execute everything on every new block by subscribing to "block""
// (P2) Mint a new liquidity position (but fail because no balances in account) centred on the current price, providing half ETH and half USDC
// (P3) Understand whether executing on every block is going to spend the free quota at Infura
// (P3) Switch to a local geth node if we're going to run out of Infura quota
// (P3) Have this script execute transactions using the local account, using an Ethers.js Signer
// (P3) Know how to create a new account locally and secure the private key (or destroy it if the mnemonic is secure), eg. enter mnemonic on process start every time

// Read our .env file
config()

// Static config that doesn't belong in the .env file.
const CONFIG = useConfig()

// To switch to another chain, these lines should be all we need to update.
const PROVIDER = CONFIG.ethereumMainnet.provider()
const CHAIN_ID = CONFIG.ethereumMainnet.chainId
const CHAIN_CONFIG = CONFIG.ethereumMainnet

const rangeOrderPoolContract = new ethers.Contract(
  CHAIN_CONFIG.addrPoolRangeOrder,
  IUniswapV3PoolABI,
  PROVIDER
)

const swapsPoolContract = new ethers.Contract(
  CHAIN_CONFIG.addrPoolSwaps,
  IUniswapV3PoolABI,
  PROVIDER
)

// Single, global instance of the DRO class.
let dro: DRO

// Single, global Ethers.js wallet (account).
let w: ethers.Wallet

function initAccount(): ethers.Wallet {
    // Check .env file and create Ethers.js wallet from mnemonic in it.
    const mnemonic = process.env.DRO_ACCOUNT_MNEMONIC

    if (mnemonic == undefined) {
      console.error("No .env file or no mnemonic in it. If you need one for testing, try this one.")
      const randomWallet = ethers.Wallet.createRandom()
      console.error(randomWallet.mnemonic.phrase)
      process.exit()
    }
  
    // Account that will hold the Uniswap v3 position NFT
    let wallet: ethers.Wallet = ethers.Wallet.fromMnemonic(mnemonic)
    wallet = wallet.connect(PROVIDER)
    console.log("DRO account: ", wallet.address)

    return wallet
}

// Ethers.js listener:
// export type Listener = (...args: Array<any>) => void
async function onBlock(...args: Array<any>) {
  const rangeOrderPoolState = await getPoolState(rangeOrderPoolContract)

  // Are we now out of range?
  const outOfRange = dro.outOfRange(rangeOrderPoolState.tick)

  const poolEthUsdcForRangeOrder = new Pool(
    dro.usdc,
    dro.weth,
    dro.poolImmutables.fee,
    rangeOrderPoolState.sqrtPriceX96.toString(),
    rangeOrderPoolState.liquidity.toString(),
    rangeOrderPoolState.tick
  )

  // Log the timestamp and block number first
  let logThisBlock = false
  let logLine = moment().format("MM-DD-HH:mm:ss")
  logLine += " #" + args

  // toFixed() implementation: https://github.com/Uniswap/sdk-core/blob/main/src/entities/fractions/price.ts
  const priceInUsdc: string = poolEthUsdcForRangeOrder.token1Price.toFixed(2)
  
  // Only log the price when it changes.
  if (dro.priceUsdc != priceInUsdc) {
    logLine += " " + priceInUsdc + " USDC."
    logThisBlock = true
  }

  dro.priceUsdc = priceInUsdc

  if (outOfRange) {
    // Remove all of our liquidity now and burn the NFT for our position.
    await dro.removeLiquidity()

    // Find our new range around the current price.
    dro.setNewRangeCenteredOn(rangeOrderPoolState.tick)

    // Swap half our assets to the other asset so that we have equal value of assets.
    const swapPoolState = await getPoolState(swapsPoolContract)
    await dro.swap(swapPoolState)

    // Add all our WETH and USDC to a new liquidity position.
    await dro.addLiquidity(rangeOrderPoolState)
  }
  else {
    logLine += " In range."
  }

  if (logThisBlock) console.log(logLine)
}

async function main() {
  // From the Uniswap v3 whitepaper:
  //   "Ticks are all 1.0001 to an integer power, which means each tick is .01% away from the next
  //    tick."
  // Note that .01% is one basis point ("bip"), so every tick is a single bip change in price.
  // But the tick spacing in our pool is 60, so our range width must be a multiple of that.
  //
  // Percent   bps (ticks)   Observations
  // -------   -----------   ------------
  //    0.6%            60   NFW. Re-ranging 8 times during a 4% hourly bar.
  //    1.2%           120   NFW. Re-ranging 7 times in 8 hours.
  //    1.8%           180   Re-ranged 3 times in 11 hours in a non-volatile market.
  //    2.4%           240   Re-ranged 5 times in 8 hours on a 5% daily bar. 
  //    3.0%           300   Re-ranged 5 times in 16 hours on a 6% daily bar.
  //    3.6%           360   Re-ranged 7 times in 34 hours on a 8% daily bar.
  //    4.2%           420   Re-ranged 3 times in 39 hours on a 6% move.
  //    4.8%           480   Testing now. 
  //    5.4%           540
  //    6.0%           600
  const rangeWidthTicks = 0.048 / 0.0001
  console.log("Range width in ticks: " + rangeWidthTicks)

  w = initAccount()

  // console.log("Gas: ", (await w.getGasPrice()).div(10^9).toString())

  try {
    // Get the range order pool's immutables once only.
    const i = await getPoolImmutables(rangeOrderPoolContract)

    dro = new DRO(w,
      PROVIDER,
      CHAIN_CONFIG,
      i,
      new Token(CHAIN_ID, i.token0, 6, "USDC", "USD Coin"),
      new Token(CHAIN_ID, i.token1, 18, "WETH", "Wrapped Ether"),
      rangeWidthTicks)

      console.log("USDC: ", i.token0)
      console.log("WETH: ", i.token1)
      console.log("Fee: ", i.fee)
  }
  catch(e) {
    // Probably network error thrown by getPoolImmutables().
    console.error(e)
  }

  // Get a callback to onBlock() on every new block.
  PROVIDER.on('block', onBlock)
}
  
main().catch(console.error)
