import { config } from 'dotenv'
import moment from 'moment'
import { useConfig, ChainConfig, useProvider } from './config'
import { updateGasPrice, gasPriceFormatted } from './wallet'
import { handleCommandLineArgs } from './command'
import { updateTick, priceFormatted } from './uniswap'
import { DRO } from './dro'

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
// Tick spacing is 10 for the 0.05% fee tier pool, 60 for the 0.30% fee tier pool.
// Range width should be a multiple of the tick spacing, with a minimum of double the tick spacing.
if (process.env.RANGE_WIDTH == undefined) throw 'No RANGE_WIDTH in .env file.'

const rangeWidth: number = Number(process.env.RANGE_WIDTH)

// Price of WETH in USDC terms in the range order pool, formatted to two decimal places.
let price: string

// Single DRO instance.
let dro: DRO

// Ethers.js listener:
// export type Listener = (...args: Array<any>) => void
async function onBlock(...args: Array<any>) {
  // This is a single API call to get the price in the range order pool.
  // JSON RPC API call: eth_call().
  await updateTick()

  await updateGasPrice()

  // Log the timestamp, block number and gas price (if we're checking it) first. Only log anything
  // when the price changes.
  if (priceFormatted() != price) {
    console.log(`${moment().format("MM-DD-HH:mm:ss")} #${args} ${gasPriceFormatted()} \
${priceFormatted()} USDC`)

    dro.onPriceChanged()
  }

  price = priceFormatted()

  // Pass the onBlock() call through to the DRO instance, which will figure out whether it needs
  // to re-range and execute transactions if so.
  await dro.onBlock()
}

async function main() {
  console.log(`Chain: ${CHAIN_CONFIG.name}`)

  // When invoked with the -n command line arg, don't execute any transactions.
  const [noops, exitNow] = await handleCommandLineArgs(rangeWidth)

  if (exitNow) {
    process.exit(0)
  }

  // The absence of a try/catch block below is deliberate. The execution of main() already has one.
  // For this startup stuff, on any error it's better to die early and let the process manager
  // restart us with some back-off. 

  // We must have the price in the range order pool before we can establish a range.
  await updateTick()

  dro = new DRO(rangeWidth, noops)
  await dro.init()

  // Get a callback to onBlock() on every new block.
  useProvider().on('block', onBlock)
}
  
main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
