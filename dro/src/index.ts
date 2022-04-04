import { config } from 'dotenv'
import moment from 'moment'
import yargs from 'yargs/yargs'
import { useConfig, ChainConfig } from './config'
import { wallet, updateGasPrice, gasPriceFormatted } from './wallet'
import { updateTick, priceFormatted, createPoolOnTestnet } from './uniswap'
import { DRO } from './dro'
import { monitor } from './swap-monitor'

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

// Set of DRO instances on which we are forward testing. In production this should only have one
// member.
let dros: DRO[] = []

// Price of WETH in USDC terms in the range order pool, formatted to two decimal places.
let price: string

// When invoked with the -n command line arg, don't execute any transactions.
let noops: boolean = false

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

    for (const dro of dros) {
      await dro.onPriceChanged()
    }
  }

  price = priceFormatted()

  // Pass the onBlock() call through to each DRO instance, which will figure out whether it needs
  // to re-range and execute transactions if so.
  for (const dro of dros) {
    await dro.onBlock()
  }
}

async function main() {
  console.log(`Chain: ${CHAIN_CONFIG.name}`)

  // Process command line args using yargs. Pass these to `ts-node ./src/index.ts`
  const argv = yargs(process.argv.slice(2)).options({
    n: { type: 'boolean', default: false },
    balances: { type: 'boolean', default: false },
    monitor: { type: 'boolean', default: false },
    approve: { type: 'boolean', default: false },
    privateKey: { type: 'boolean', default: false },
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
    await updateTick()
    
    await wallet.logBalances()

    // To unwrap some WETH, uncomment and run once:
    // await wallet.unwrapWeth(10_000_000_000_000_000n) // 0.01 WETH
    // await wallet.logBalances()

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

    // Approve the swap routers to spend our tokens.
    await wallet.approveAll(CHAIN_CONFIG.addrSwapRouter)
    await wallet.approveAll(CHAIN_CONFIG.addrSwapRouter2)

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

  // `--r` means remove liquidity from all dros and exit.
  if (argv.r) {
    console.log(`Removing liquidity only.`)

    await updateTick()

    for (const width of rangeWidths) {
      const dro: DRO = new DRO(width, false)
      await dro.init()

      if (dro.inPosition()) {
        await dro.removeLiquidity()
      }
      else {
        console.log(`dro with width ${width} wasn't in position. No liquidity to remove.`)
      }
    }

    return
  }

  // The absence of a try/catch block below is deliberate. The execution of main() already has one.
  // For this startup stuff, on any error it's better to die early and let the process manager
  // restart us with some back-off. 

  // We must have the price in the range order pool before we can establish a range.
  await updateTick()

  for (const width of rangeWidths) {
    const dro: DRO = new DRO(width, noops)
    await dro.init()

    dros.push(dro)
  }

  // Get a callback to onBlock() on every new block.
  CHAIN_CONFIG.provider().on('block', onBlock)
}
  
main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
