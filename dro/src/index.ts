import { config } from 'dotenv'
import { useConfig, ChainConfig } from './config'
import { wallet, updateGasPrice, gasPrice } from './wallet'
import { updateTick, rangeOrderPoolPriceUsdc } from './uniswap'
import { DRO } from './dro'
import { monitor } from './swap-monitor'
import { init, dumpRerangeEventsToCsv, meanTimeToReranging } from './db'
import { createPoolOnTestnet } from './uniswap'
import moment from 'moment'
import yargs from 'yargs/yargs'
import { ethers } from 'ethers'

// TODO
// ----
// (P1) Use the new Uniswap SDK feature for swapping and adding liquidity in one transaction: https://docs.uniswap.org/sdk/guides/liquidity/swap-and-add
// (P2) Build out exponential backoff, or at least retries, for 50x server errors from provider, or lost network. Ask in Alchemy Discord.
// (P2) More swap testing
// (P3) Know when we're out of range directly from the existing liquidity position and stop tracking min and max ticks locally
// (P3) Keep track of how much ETH to keep on hand for gas and swap costs

// Done
// ----
// (P1) Forward test many range widths
// (P1) Give Alchemy a spin and see a) whether we fall within the free tier b) if we get fewer errors than on Infura.
// (P1) Get the 'remove liquidity' tx working
// (P1) Get the swap tx working, when re-ranging down (in: WETH, out: USDC)
// (P1) Get the swap tx working, when re-ranging up (in: USDC, out: WETH)
// (P1) Get the 'add liquidity' tx working, including capturing the Token ID
// (P1) Swap some WETH to USDC so the DRO account has some on Kovan.
// (P1) Get hold of some WETH for the DRO account
// (P1) Know what our current balance of ETH, WETH and USDC is, right after removing liquidity
// (P1) Fix the range width arithmetic
// (P1) Show the new range min and max in terms of USDC rather than ticks
// (P1) Get the current price in the pool synchronously and in terms of the quote currency
// (P1) Know when we're out of range, indirectly, based on the current price in the pool and the current min/max, which we'll store for now
// (P1) Timestamps in logging
// (P1) Fix down/up re-ranging indicator on Arbitrum
// (P2) While we're waiting for any transaction, don't begin re-ranging again
// (P2) Know the current price of gas
// (P2) Don't re-range when the current price of gas is over a constant threshold
// (P2) Execute everything on every new block by subscribing to "block""
// (P2) Mint a new liquidity position (but fail because no balances in account) centred on the current price, providing half ETH and half USDC
// (P2) Execute a swap for a known amount of WETH (half our account balance, less some savings for execution)
// (P3) Understand whether executing on every block is going to spend the free quota at Infura
// (P3) Switch to a local geth node if we're going to run out of Infura quota
// (P3) Have this script execute transactions using the local account, using an Ethers.js Signer
// (P3) Know how to create a new account locally and secure the private key (or destroy it if the mnemonic is secure), eg. enter mnemonic on process start every time
// (P3) Build the URL of the position, based on the serial number, and log it

// Read our .env file
config()

// Static config that doesn't belong in the .env file.
// To switch to another chain, only the .env file needs to change.
const CHAIN_CONFIG: ChainConfig = useConfig()

// Candidate values for the range width in bps.
// From the Uniswap v3 whitepaper:
//   "Ticks are all 1.0001 to an integer power, which means each tick is .01% away from the next
//    tick."
// Note that .01% is one basis point ("bip"), so every tick is a single bip change in price.
// But the tick spacing in our pool is 60, so our range width must be a multiple of that.
// Forget about using a range width of 60 bps. When we re-range, we want a new range that's
// centered on the current price. This is impossible when the range width is the smallest
// possible width - we can't set a min tick 30 bps lower than the current price. The same applies
// to range widths that are multiples of 60 bps but not 120 bps - they cannot be centered on the 
// current price. Therefore, choose ranges widths that are multiples of 120 bps.
if (process.env.RANGE_WIDTHS == undefined) throw 'No RANGE_WIDTHS list in .env file.'

const rangeWidths: number[] = process.env.RANGE_WIDTHS?.split(' ').map(Number)

// Set of DRO instances on which we are forward testing.
let dros: DRO[] = []

// Single, global USDC price in the range order pool.
let price: string

// When invoked with the -n command line arg, don't execute any transactions.
let noops: boolean = false

// Ethers.js listener:
// export type Listener = (...args: Array<any>) => void
async function onBlock(...args: Array<any>) {
  // This is a single API call to get the price in the range order pool.
  await updateTick()

  await updateGasPrice()

  // Log the timestamp, block number and gas price first. Only log anything when the price changes.
  if (rangeOrderPoolPriceUsdc != price) {
    // Only show the gas price on L1.
    let gasPriceReadable = ''

    if (!CHAIN_CONFIG.isL2) {
      gasPriceReadable = `${gasPrice.div(1e9).toNumber()} gwei `
    }

    console.log(`${moment().format("MM-DD-HH:mm:ss")} #${args} ${gasPriceReadable}\
${rangeOrderPoolPriceUsdc} USDC`)
  }

  price = rangeOrderPoolPriceUsdc

  // Pass the onBlock() call through to each DRO instance, which will figure out whether it needs
  // to re-range and execute transactions if so.
  for (const dro of dros) {
    await dro.onBlock()
  }
}

async function main() {
  console.log(`Using ${CHAIN_CONFIG.name}`)

  // Process command line args using yargs. Pass these to `ts-node ./src/index.ts`
  const argv = yargs(process.argv.slice(2)).options({
    n: { type: 'boolean', default: false },
    balances: { type: 'boolean', default: false },
    monitor: { type: 'boolean', default: false },
    approve: { type: 'boolean', default: false },
    privateKey: { type: 'boolean', default: false },
    dbDump: { type: 'boolean', default: false },
    mtr: { type: 'boolean', default: false },
    testnetCreatePool: { type: 'boolean', default: false },
    wrapEth: { type: 'boolean', default: false },
  }).parseSync()

  // `--n` means no-op.
  if (argv.n) {
    noops = true
    console.log(`Running in no-op mode. No transactions will be executed.`)
  }

  // `--balances` means just log our available balances.
  if (argv.balances) {
    await wallet.logBalances()

    return
  }

  // `--monitor` means just log the prices in the pool.
  if (argv.monitor) {
    console.log(`Monitoring swaps in the pool`)
    
    try {
      monitor(CHAIN_CONFIG)
    }
    catch(e) {
      // Probably network error
      console.error(e)
    }

    return
  }

  // `--private-key` means just log the private key for the account.
  if (argv.privateKey) {
    console.log(`Private key for Hardhat .env file: ${wallet.privateKey}`)

    return
  }

  // `--approve` means approve spending of USDC and WETH up to MaxInt.
  if (argv.approve) {
    console.log(`Approving spending of USDC and WETH`)

    // await wallet.approveAll(wallet.address)

    // Approve the position manager contract to spend our tokens.
    await wallet.approveAll(CHAIN_CONFIG.addrPositionManager)

    // Approve the swap router to spend our tokens.
    await wallet.approveAll(CHAIN_CONFIG.addrSwapRouter)

    return
  }

  // `--testnet-create-pool` means create a new Uniswap v3 pool with our own USDC token.
  if (argv.testnetCreatePool) {
    console.log(`Creating pool on testnet`)

    // Approve the position manager contract to spend our tokens.
    await wallet.approveAll(CHAIN_CONFIG.addrPositionManager)

    await createPoolOnTestnet()

    return
  }

  // `--wrap-eth` means wrap some ETH to WETH.
  if (argv.wrapEth) {
    // Required 1_250_000_000_000_000_000
    // Got      1_186_361_607_590_516_298
    await wallet.wrapEth('0.5')

    return
  }

  // Create our database if it doesn't already exist.
  init()

  // `--db-dump` means dump our database contents to the console.
  if (argv.dbDump) {
    console.log(`Database:`)

    await dumpRerangeEventsToCsv()

    return
  }

  // `--mtr` means show our mean time to re-ranging for some range widths.
  if (argv.mtr) {

    for (const width of rangeWidths) {
      const mtr = await meanTimeToReranging(width)
  
      console.log(`Mean time to re-ranging for range width ${width}: ${mtr}`)
    }

    return
  }

  try {
    for (const width of rangeWidths) {
      const dro: DRO = new DRO(width, noops)
      await dro.init()
      dros.push(dro)
    }
  }
  catch(e) {
    // Probably network error thrown by a Uniswap tx call.
    console.error(e)
  }

  // Get a callback to onBlock() on every new block.
  CHAIN_CONFIG.provider().on('block', onBlock)
}
  
main().catch((error) => {
  // TODO: Catch HTTP timeout errors and continue. Losing the network should not kill the process.
  console.error(error)
  process.exitCode = 1
})
