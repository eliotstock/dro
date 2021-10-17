import { config } from 'dotenv'
import { useConfig } from './config'
import { EthUsdcWallet } from './wallet'
import { DRO } from './dro'
import moment from 'moment'

// TODO
// ----
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
// (P1) Know what our current balance of ETH, WETH and USDC is, right after removing liquidity
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

// To switch to another chain, this line should be all we need to change.
const CHAIN_CONFIG = CONFIG.ethereumKovan

// Single, global instance of the DRO class.
let dro: DRO

// Single, global Ethers.js wallet subclass instance (account).
let wallet: EthUsdcWallet

// Single, global USDC price in the range order pool.
let price: string

// Ethers.js listener:
// export type Listener = (...args: Array<any>) => void
async function onBlock(...args: Array<any>) {
  await dro.updatePoolState()

  // Log the timestamp and block number first
  let logThisBlock = false
  let logLine = moment().format("MM-DD-HH:mm:ss")
  logLine += " #" + args
  
  // Only log the price when it changes.
  if (dro.priceUsdc != price) {
    logLine += " " + dro.priceUsdc + " USDC."
    logThisBlock = true
  }
  price = dro.priceUsdc

  // Are we now out of range?
  if (dro.outOfRange()) {
    // Remove all of our liquidity now and burn the NFT for our position.
    await dro.removeLiquidity()

    // Take note of what assets we now hold
    wallet.logBalances()

    // Find our new range around the current price.
    dro.updateRange()

    // Swap half our assets to the other asset so that we have equal value of assets.
    await dro.swap()

    // Add all our WETH and USDC to a new liquidity position.
    await dro.addLiquidity()
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

  wallet = EthUsdcWallet.createFromEnv(CHAIN_CONFIG)

  try {
    dro = new DRO(wallet, CHAIN_CONFIG, rangeWidthTicks)

    await dro.init()
  }
  catch(e) {
    // Probably network error thrown by getPoolImmutables().
    console.error(e)
  }

  // Get a callback to onBlock() on every new block.
  CHAIN_CONFIG.provider().on('block', onBlock)
}
  
main().catch(console.error)
