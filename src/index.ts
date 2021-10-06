import { config } from 'dotenv'
import { ethers } from "ethers"
import { CollectOptions, MintOptions, nearestUsableTick, NonfungiblePositionManager, Pool, Position, priceToClosestTick, RemoveLiquidityOptions, Route, tickToPrice } from "@uniswap/v3-sdk"
import { Token, CurrencyAmount, Percent, Price, Fraction, BigintIsh } from "@uniswap/sdk-core"
import { abi as IUniswapV3PoolABI } from "@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json"
import { abi as QuoterABI } from "@uniswap/v3-periphery/artifacts/contracts/lens/Quoter.sol/Quoter.json"
import JSBI from 'jsbi'
import moment from 'moment'
import { Collection } from 'typescript'

// Read our .env file
config()

// TODO
// ----
// (P1) Know what our current balance of both WETH and USDC is, right after removing liquidity
// (P2) While we're waiting for any transaction, don't begin re-ranging again
// (P2) Remove an existing liquidity position (but fail because no local account)
// (P1) Know when we're out of range directly from the existing liquidity position and stop tracking min and max ticks locally
// (P2) Execute a swap for a known amount of ETH (half our account balance, less some savings for execution)
// (P2) Execute a swap for a known amount of USDC (half our account balance)
// (P2) Keep track of how much ETH to keep on hand for gas and swap costs

// (P3) Know how to create a new account locally in geth and secure the private key (or destroy it if the seed phrase is secure), eg. enter seed phrase or password on process start every time
// (P3) Have this script execute using the local geth-created account, using an Ethers.js Signer
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

// My personal Infura project (dro). Free quota is 100K requests per day, which is more than one a second.
// WSS doesn't work ("Error: could not detect network") and HTTPS works for event subscriptions anyway.
const ENDPOINT_MAINNET = "https://mainnet.infura.io/v3/84a44395cd9a413b9c903d8bd0f9b39a"
const ENDPOINT_KOVAN = "https://kovan.infura.io/v3/84a44395cd9a413b9c903d8bd0f9b39a"
const ENDPOINT = ENDPOINT_MAINNET

// Ethereum mainnet
const CHAIN_ID_MAINNET = 1
const CHAIN_ID_KOVAN = 42
const CHAIN_ID = CHAIN_ID_MAINNET

const PROVIDER = new ethers.providers.JsonRpcProvider(ENDPOINT)

// USDC/ETH pool with 0.3% fee: https://info.uniswap.org/#/pools/0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8
// This is the pool into which we enter a range order. It is NOT the pool in which we execute swaps.
// UI for adding liquidity to this pool: https://app.uniswap.org/#/add/ETH/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48/3000
const POOL_ADDR_ETH_USDC_FOR_RANGE_ORDER = "0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8"

// USDC/ETH pool with 0.05% fee: https://info.uniswap.org/#/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640
// This is the pool in which we execute our swaps.
const POOL_ADDR_ETH_USDC_FOR_SWAPS = "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640"

// Position manager contract. Address taken from https://github.com/Uniswap/v3-periphery/blob/main/deploys.md
// and checked against transactions executed on the Uniswap dApp. Same address on testnets.
const POSITION_MANAGER_ADDR = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88"

// Quoter contract. Address taken from https://github.com/Uniswap/v3-periphery/blob/main/deploys.md
// Same address on testnets.
const QUOTER_ADDR = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6"

// On all transactions, set the deadline to 3 minutes from now
const DEADLINE_SECONDS = 180

const SLIPPAGE_TOLERANCE = new Percent(50, 10_000) // 0.005%

const GAS_LIMIT = ethers.utils.hexlify(100_000)

const VALUE_ZERO_ETHER = ethers.utils.parseEther("0")

// TODO: This is probably quite wrong.
const GAS_PRICE = ethers.utils.hexlify(100_000)

const poolForRangeOrderContract = new ethers.Contract(
  POOL_ADDR_ETH_USDC_FOR_RANGE_ORDER,
  IUniswapV3PoolABI,
  PROVIDER
)

const poolForSwapsContract = new ethers.Contract(
  POOL_ADDR_ETH_USDC_FOR_SWAPS,
  IUniswapV3PoolABI,
  PROVIDER
)

const quoterContract = new ethers.Contract(
  QUOTER_ADDR,
  QuoterABI,
  PROVIDER
)

// Single, global instance of the DRO class.
let dro: DRO

// Ethers.js wallet
let w: ethers.Wallet

interface Immutables {
  factory: string
  token0: string
  token1: string
  fee: number
  tickSpacing: number
  maxLiquidityPerTick: ethers.BigNumber
}

interface State {
  liquidity: ethers.BigNumber
  sqrtPriceX96: ethers.BigNumber
  tick: number
  observationIndex: number
  observationCardinality: number
  observationCardinalityNext: number
  feeProtocol: number
  unlocked: boolean
}

class DRO {
  readonly poolImmutables: Immutables
  readonly usdc: Token
  readonly weth: Token
  priceUsdc: string = "unknown"
  minTick: number = 0
  maxTick: number = 0
  rangeWidthTicks = 0
  position?: Position
  tokenId?: BigintIsh

  constructor(_poolImmutables: Immutables, _usdc: Token, _weth: Token, _rangeWidthTicks: number) {
    this.poolImmutables = _poolImmutables
    this.usdc = _usdc
    this.weth = _weth
    this.rangeWidthTicks = _rangeWidthTicks
  }

  outOfRange(currentTick: number) {
    return currentTick < this.minTick || currentTick > this.maxTick
  }

  // Note that if rangeWidthTicks is not a multiple of the tick spacing for the pool, the range
  // returned here can be quite different to rangeWidthTicks.
  setNewRangeCenteredOn(currentTick: number) {
    this.minTick = nearestUsableTick(Math.round(currentTick - (this.rangeWidthTicks / 2)),
      this.poolImmutables.tickSpacing)

    this.maxTick = nearestUsableTick(Math.round(currentTick + (this.rangeWidthTicks / 2)),
      this.poolImmutables.tickSpacing)

    // tickToPrice() implementation:
    //   https://github.com/Uniswap/v3-sdk/blob/6c4242f51a51929b0cd4f4e786ba8a7c8fe68443/src/utils/priceTickConversions.ts#L14
    // Note that minimum USDC value per ETH corresponds to the maximum tick value and vice versa.
    const minUsdc = tickToPrice(dro.weth, dro.usdc, this.maxTick).toFixed(2)
    const maxUsdc = tickToPrice(dro.weth, dro.usdc, this.minTick).toFixed(2)

    console.log("New range: " + minUsdc + " USDC - " + maxUsdc + " USDC.")
  }

  async removeLiquidity() {
    if (!this.position || !this.tokenId) {
      console.error("Not in a position yet.")
      return
    }

    if (!w.address) {
      console.error("No account address yet")
      return
    }

    const collectOptions: CollectOptions = {
      tokenId: this.tokenId,
      expectedCurrencyOwed0: CurrencyAmount.fromRawAmount(this.usdc, 0),
      expectedCurrencyOwed1: CurrencyAmount.fromRawAmount(this.weth, 0),
      recipient: w.address
    }

    const removeLiquidityOptions: RemoveLiquidityOptions = {
      tokenId: this.tokenId,
      liquidityPercentage: new Percent(1), // 100%
      slippageTolerance: SLIPPAGE_TOLERANCE,
      deadline: moment().unix() + DEADLINE_SECONDS,
      collectOptions: collectOptions
    }

    const {calldata, value} = NonfungiblePositionManager.removeCallParameters(this.position, removeLiquidityOptions)

    const nonce = await w.getTransactionCount("latest")
    console.log("nonce: ", nonce)

    const tx = {
      from: w.address,
      to: POSITION_MANAGER_ADDR,
      value: VALUE_ZERO_ETHER,
      nonce: nonce,
      gasLimit: GAS_LIMIT,
      gasPrice: GAS_PRICE,
      data: calldata
    }

    // TODO: Switch to Kovan, fund the account with USDC and WETH and test.
    // w.sendTransaction(tx).then((transaction) => {
    //   console.dir(transaction)
    //   console.log("Send finished!")
    // }).catch(console.error)
  }

  async addLiquidity(poolState: State) {
    if (!this.position || !this.tokenId) {
      console.error("Not in a position yet.")
      return
    }

    if (!w.address) {
      console.error("No account address yet")
      return
    }

    // We can't instantiate this pool instance until we have the pool state.
    const poolEthUsdcForRangeOrder = new Pool(
      dro.usdc,
      dro.weth,
      dro.poolImmutables.fee,
      poolState.sqrtPriceX96.toString(),
      poolState.liquidity.toString(),
      poolState.tick
    )

    // If we know L, the liquidity:
    // const position = new Position({
    //   pool: poolEthUsdcForRangeOrder,
    //   liquidity: 10, // Integer. L is sqrt(k) where y * x = k.
    //   tickLower: minTick,
    //   tickUpper: maxTick
    // })

    // console.log("Decimals: ", dro.usdc.decimals, "(USDC)", dro.weth.decimals, "(WETH)")

    // TODO: Get these from our account balance, leaving some ETH for gas and swap costs.
    // TODO: Use JSBI here, but with exponents. These are overflowing a Javascript number type right now.
    const amountUsdc: number = 3385.00 * 10 ^ dro.usdc.decimals // 6 decimals
    const amountEth: number = 1.00 * 10 ^ dro.weth.decimals // 18 decimals

    // We don't know L, the liquidity, but we do know how much ETH and how much USDC we'd like to add.
    const position = Position.fromAmounts({
      pool: poolEthUsdcForRangeOrder,
      tickLower: this.minTick,
      tickUpper: this.maxTick,
      amount0: "3377990000",
      amount1: "1000000000000000000", // 18 zeros.
      useFullPrecision: true
    })

    console.log("Amounts desired: ", position.mintAmounts.amount0.toString(), "USDC", position.mintAmounts.amount1.toString(), "WETH")

    const mintOptions: MintOptions = {
      slippageTolerance: SLIPPAGE_TOLERANCE,
      deadline: moment().unix() + DEADLINE_SECONDS,
      recipient: w.address,
      createPool: false
    }

    // addCallParameters() implementation:
    //   https://github.com/Uniswap/v3-sdk/blob/6c4242f51a51929b0cd4f4e786ba8a7c8fe68443/src/nonfungiblePositionManager.ts#L164
    const { calldata, value } = NonfungiblePositionManager.addCallParameters(position, mintOptions)

    // console.log("calldata: ", calldata)
    // console.log("value: ", value)

    const nonce = await w.getTransactionCount("latest")
    console.log("nonce: ", nonce)

    const tx = {
      from: w.address,
      to: POSITION_MANAGER_ADDR,
      value: VALUE_ZERO_ETHER,
      nonce: nonce,
      gasLimit: GAS_LIMIT,
      gasPrice: GAS_PRICE,
      data: calldata
    }

    // Currently failing with insufficient funds, which is as expected.
    // TODO: Switch to Kovan, fund the account with USDC and WETH and test.
    // w.sendTransaction(tx).then((transaction) => {
    //   console.dir(transaction)
    //   console.log("Send finished!")
    // }).catch(console.error)
  }
}

async function getPoolImmutables(poolContract: ethers.Contract) {
  const [factory, token0, token1, fee, tickSpacing, maxLiquidityPerTick] =
    await Promise.all([
      poolContract.factory(),
      poolContract.token0(),
      poolContract.token1(),
      poolContract.fee(),
      poolContract.tickSpacing(),
      poolContract.maxLiquidityPerTick(),
    ])

  const immutables: Immutables = {
    factory,
    token0,
    token1,
    fee,
    tickSpacing,
    maxLiquidityPerTick,
  }

  return immutables
}

async function getPoolState(poolContract: ethers.Contract) {
  const [liquidity, slot] = await Promise.all([
    poolContract.liquidity(),
    poolContract.slot0(),
  ])

  const poolState: State = {
    liquidity,
    sqrtPriceX96: slot[0],
    tick: slot[1],
    observationIndex: slot[2],
    observationCardinality: slot[3],
    observationCardinalityNext: slot[4],
    feeProtocol: slot[5],
    unlocked: slot[6],
  }

  return poolState
}

// Ethers.js listener:
// export type Listener = (...args: Array<any>) => void
async function onBlock(...args: Array<any>) {
  const poolState = await getPoolState(poolForRangeOrderContract)

  // Are we now out of range?
  const oor = dro.outOfRange(poolState.tick)

  const poolEthUsdcForRangeOrder = new Pool(
    dro.usdc,
    dro.weth,
    dro.poolImmutables.fee,
    poolState.sqrtPriceX96.toString(),
    poolState.liquidity.toString(),
    poolState.tick
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

  if (oor) {
    // Remove all of our liquidity now and burn the NFT for our position.
    await dro.removeLiquidity()

    // Find our new range around the current price.
    dro.setNewRangeCenteredOn(poolState.tick)

    // Add all our WETH and USDC to a new liquidity position.
    await dro.addLiquidity(poolState)
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
  // But the tick spacing in our pool is 60, so we'd be wise to make our range width a multiple of
  // that.
  // Percent   bps (ticks)   Observations
  // -------   -----------   ------------
  //    0.6%            60   NFW. Re-ranging 8 times during a 4% hourly bar.
  //    1.2%           120   NFW. Re-ranging 7 times in 8 hours.
  //    1.8%           180   Re-ranged 3 times in 11 hours in a non-volatile market.
  //    2.4%           240   Re-ranged 5 times in 8 hours on a 5% daily bar. 
  //    3.0%           300   Re-ranged 5 times in 16 hours on a 6% daily bar.
  //    3.6%           360   Testing now. Re-ranged 1 time in 24 hours on a 4% daily bar.
  //    4.2%           420
  //    4.8%           480
  //    5.4%           540
  //    6.0%           600
  const rangeWidthTicks = 0.036 / 0.0001
  console.log("Range width in ticks: " + rangeWidthTicks)

  // Check .env file and create Ethers.js wallet from mnemonic in it.
  const mnemonic = process.env.DRO_ACCOUNT_MNEMONIC

  if (mnemonic == undefined) {
    console.error("No .env file or no mnemonic in it. If you need one for testing, try this one.")
    w = ethers.Wallet.createRandom()
    console.error(w.mnemonic.phrase)
    process.exit()
  }

  // Account that will hold the Uniswap v3 position NFT
  w = ethers.Wallet.fromMnemonic(mnemonic)
  w = w.connect(PROVIDER)
  console.log("DRO account: ", w.address)

  // console.log("Gas: ", (await w.getGasPrice()).div(10^9).toString())

  try {
    // Get the pool's immutables once only.
    const i = await getPoolImmutables(poolForRangeOrderContract)

    // console.log("Token 0 address: ", i.token0)
    // console.log("Token 1 address: ", i.token1)

    dro = new DRO(i,
      new Token(CHAIN_ID, i.token0, 6, "USDC", "USD Coin"),
      new Token(CHAIN_ID, i.token1, 18, "WETH", "Wrapped Ether"),
      rangeWidthTicks)

      // TODO: Move all the below swap stuff out of here and into a function called only when we're out of range.
      const usdcIn = "3375560000" // USDC, 6 decimals

      const quotedWethOut = await quoterContract.callStatic.quoteExactInputSingle(
        i.token0, // Token in: USDC
        i.token1, // Token out: WETH
        i.fee, // 0.30%
        usdcIn, // Amount in, USDC (6 decimals)
        0 // sqrtPriceLimitX96
      )

      // Given 3_375_560_000, currently returns 996_997_221_346_111_279, ie. approx. 1 * 10^18 wei.
      console.log("Swapping " + usdcIn + " USDC will get us " + quotedWethOut.toString() + " WETH")

      const state = await getPoolState(poolForSwapsContract)

      const poolEthUsdcForSwaps = new Pool(
        dro.usdc,
        dro.weth,
        dro.poolImmutables.fee,
        state.sqrtPriceX96.toString(),
        state.liquidity.toString(),
        state.tick
      )

      const swapRoute = new Route([poolEthUsdcForSwaps], dro.usdc, dro.weth)
  }
  catch(e) {
    // Probably network error thrown by getPoolImmutables().
    console.error(e)
  }

  // Get a callback to onBlock() on every new block.
  PROVIDER.on('block', onBlock)
}
  
main().catch(console.error)
