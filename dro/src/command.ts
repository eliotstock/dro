import yargs from 'yargs/yargs'
import { log } from './logger'
import { useConfig, ChainConfig } from './config'
import { speedUpPendingTx, wallet } from './wallet'
import { updateTick, createPoolOnTestnet } from './uniswap'
import { DRO } from './dro'

const CHAIN_CONFIG: ChainConfig = useConfig()

// Process command line args using yargs. Pass these to `ts-node ./src/index.ts`.
export async function handleCommandLineArgs(rangeWidth: number): Promise<[boolean, boolean]> {
  let noops = false

  const argv = yargs(process.argv.slice(2)).options({
    n: { type: 'boolean', default: false },
    balances: { type: 'boolean', default: false },
    approve: { type: 'boolean', default: false },
    privateKey: { type: 'boolean', default: false },
    speedUp: { type: 'string', default: '' },
    testnetCreatePool: { type: 'boolean', default: false },
    wrapEth: { type: 'boolean', default: false },
    panic: { type: 'boolean', default: false }
  }).parseSync()

  // `--n` means no-op.
  if (argv.n) {
    noops = true
    log.info(`Running in no-op mode. No transactions will be executed.`)
  }

  // `--balances` means just log our available balances.
  if (argv.balances) {
    await updateTick()
    
    await wallet.logBalances()

    // To unwrap some WETH, uncomment and run once:
    // await wallet.unwrapWeth(10_000_000_000_000_000n) // 0.01 WETH
    // await wallet.logBalances()

    return [noops, true]
  }

  // `--private-key` means just log the private key for the account.
  if (argv.privateKey) {
    log.info(`Private key for Hardhat .env file: ${wallet.privateKey}`)

    return [noops, true]
  }

  // `--approve` means approve spending of USDC and WETH up to MaxInt.
  if (argv.approve) {
    log.info(`Approving spending of USDC and WETH`)

    // await wallet.approveAll(wallet.address)

    // Approve the position manager contract to spend our tokens.
    await wallet.approveAll(CHAIN_CONFIG.addrPositionManager)

    // Approve the swap routers to spend our tokens.
    await wallet.approveAll(CHAIN_CONFIG.addrSwapRouter)
    await wallet.approveAll(CHAIN_CONFIG.addrSwapRouter2)

    return [noops, true]
  }

  // `--speedup` means speed up the given transaction by increasing the gas price on it.
  if (argv.speedUp != '') {
    log.info(`Speeding up transaction ${argv.speedUp} only.`)

    await speedUpPendingTx(argv.speedUp)

    return [noops, true]
  }

  // `--testnet-create-pool` means create a new Uniswap v3 pool with our own USDC token.
  if (argv.testnetCreatePool) {
    log.info(`Creating pool on testnet`)

    // Approve the position manager contract to spend our tokens.
    await wallet.approveAll(CHAIN_CONFIG.addrPositionManager)

    await createPoolOnTestnet()

    return [noops, true]
  }

  // `--wrap-eth` means wrap some ETH to WETH.
  if (argv.wrapEth) {
    // Required 1_250_000_000_000_000_000
    // Got      1_186_361_607_590_516_298
    await wallet.wrapEth('0.5')

    return [noops, true]
  }

  // `--r` means remove liquidity from the dro and exit.
  if (argv.r) {
    log.info(`Removing liquidity only.`)

    await updateTick()

    const dro: DRO = new DRO(rangeWidth, false)
    await dro.init()

    if (dro.inPosition()) {
      await dro.removeLiquidity()
    }
    else {
      log.info(`dro with width ${rangeWidth} wasn't in position. No liquidity to remove.`)
    }

    return [noops, true]
  }

  if (argv.panic) {
    log.info(`Removing liquidity and swapping everything to USDC.`)

    await updateTick()

    const dro: DRO = new DRO(rangeWidth, false)
    await dro.init()

    if (dro.inPosition()) {
      await dro.reinitMutables()
      await dro.removeLiquidity()
      await dro.panicSwap()
    }
    else {
      log.info(`dro with width ${rangeWidth} wasn't in position. No liquidity to remove.`)
    }
  }

  return [noops, false]
}
