import { config } from 'dotenv'
import { BigNumber } from '@ethersproject/bignumber'
import { CollectOptions, MintOptions, nearestUsableTick, NonfungiblePositionManager, Pool, Position, RemoveLiquidityOptions, Route, tickToPrice } from "@uniswap/v3-sdk"
import { Token, CurrencyAmount, Percent, BigintIsh } from "@uniswap/sdk-core"
import { ethers } from 'ethers'
import { abi as QuoterABI } from "@uniswap/v3-periphery/artifacts/contracts/lens/Quoter.sol/Quoter.json"
import { abi as NonfungiblePositionManagerABI } from "@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json"
import { abi as IUniswapV3PoolABI } from "@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json"
import moment from 'moment'
import { Immutables, State, getPoolImmutables, getPoolState } from './uniswap'
import { useConfig } from './config'
import invariant from 'tiny-invariant'
import { TickMath } from '@uniswap/v3-sdk/'

// Read our .env file
config()

// Static config that doesn't belong in the .env file.
const CONFIG = useConfig()

// On all transactions, set the deadline to 3 minutes from now
const DEADLINE_SECONDS = 180

const VALUE_ZERO_ETHER = ethers.utils.parseEther("0")

export class DRO {
    readonly owner: ethers.Wallet
    readonly provider: ethers.providers.Provider
    readonly chainConfig: any
    readonly quoterContract: ethers.Contract
    readonly positionManagerContract: ethers.Contract
    poolImmutables?: Immutables
    usdc?: Token
    weth?: Token
    priceUsdc: string = "unknown"
    minTick: number = 0
    maxTick: number = 0
    rangeWidthTicks = 0
    rangeOrderPoolContract: ethers.Contract
    rangeOrderPoolState?: State
    rangeOrderPool?: Pool
    swapPoolContract: ethers.Contract
    swapPoolState?: State
    position?: Position
    tokenId?: BigintIsh
    unclaimedFeesUsdc?: BigintIsh
    unclaimedFeesWeth?: BigintIsh
  
    constructor(
        _owner: ethers.Wallet,
        _chainConfig: any,
        _rangeWidthTicks: number) {
        this.owner = _owner
        this.provider = _chainConfig.provider()
        this.chainConfig = _chainConfig
        this.rangeWidthTicks = _rangeWidthTicks

        this.quoterContract = new ethers.Contract(
            CONFIG.addrQuoter,
            QuoterABI,
            this.provider
        )
          
        this.positionManagerContract = new ethers.Contract(
            CONFIG.addrPositionManager,
            NonfungiblePositionManagerABI,
            this.provider
        )

        this.rangeOrderPoolContract = new ethers.Contract(
            this.chainConfig.addrPoolRangeOrder,
            IUniswapV3PoolABI,
            this.chainConfig.provider()
        )

        this.swapPoolContract = new ethers.Contract(
            this.chainConfig.addrPoolSwaps,
            IUniswapV3PoolABI,
            this.chainConfig.provider()
        )
    }

    async init() {
      // Get the range order pool's immutables once only.
      this.poolImmutables = await getPoolImmutables(this.rangeOrderPoolContract)

      this.usdc = new Token(this.chainConfig.chainId, this.poolImmutables.token0, 6, "USDC", "USD Coin")

      this.weth = new Token(this.chainConfig.chainId, this.poolImmutables.token1, 18, "WETH", "Wrapped Ether")

      console.log("USDC: ", this.poolImmutables.token0)
      console.log("WETH: ", this.poolImmutables.token1)
      console.log("Fee: ", this.poolImmutables.fee)
    }

    async updatePoolState() {
        if (this.poolImmutables == undefined || this.usdc == undefined || this.weth == undefined) throw "Not init()ed"

        this.rangeOrderPoolState = await getPoolState(this.rangeOrderPoolContract)

        // The pool depends on the pool state so we need to reconstruct it every time the state changes.
        this.rangeOrderPool = new Pool(
          this.usdc,
          this.weth,
          this.poolImmutables.fee,
          this.rangeOrderPoolState.sqrtPriceX96.toString(),
          this.rangeOrderPoolState.liquidity.toString(),
          this.rangeOrderPoolState.tick
        )

        // Check that the tick value won't cause nearestUsableTick() to fail later. Testnets might have strange prices.
        invariant(this.rangeOrderPoolState.tick >= TickMath.MIN_TICK && this.rangeOrderPoolState.tick <= TickMath.MAX_TICK, 'TICK_BOUND')

        // toFixed() implementation: https://github.com/Uniswap/sdk-core/blob/main/src/entities/fractions/price.ts
        this.priceUsdc = this.rangeOrderPool.token1Price.toFixed(2)

        this.swapPoolState = await getPoolState(this.swapPoolContract)
    }
  
    outOfRange() {
        return this.rangeOrderPoolState && (
            this.rangeOrderPoolState.tick < this.minTick ||
            this.rangeOrderPoolState.tick > this.maxTick)
    }
  
    // Note that if rangeWidthTicks is not a multiple of the tick spacing for the pool, the range
    // returned here can be quite different to rangeWidthTicks.
    updateRange() {
      if (this.rangeOrderPoolState == undefined) throw "Not updatePoolState()ed"

      if (this.poolImmutables == undefined || this.usdc == undefined || this.weth == undefined) throw "Not init()ed"

      this.minTick = Math.round(this.rangeOrderPoolState.tick - (this.rangeWidthTicks / 2))
      // Don't go under MIN_TICK, which can happen on testnets.
      this.minTick = Math.max(this.minTick, TickMath.MIN_TICK)
      this.minTick = nearestUsableTick(this.minTick, this.poolImmutables.tickSpacing)
  
      this.maxTick = Math.round(this.rangeOrderPoolState.tick + (this.rangeWidthTicks / 2))
      // Don't go over MAX_TICK, which can happen on testnets.
      this.maxTick = Math.min(this.maxTick, TickMath.MAX_TICK)
      this.maxTick = nearestUsableTick(this.maxTick, this.poolImmutables.tickSpacing)
  
      // tickToPrice() implementation:
      //   https://github.com/Uniswap/v3-sdk/blob/6c4242f51a51929b0cd4f4e786ba8a7c8fe68443/src/utils/priceTickConversions.ts#L14
      // Note that minimum USDC value per ETH corresponds to the maximum tick value and vice versa.
      const minUsdc = tickToPrice(this.weth, this.usdc, this.maxTick).toFixed(2)
      const maxUsdc = tickToPrice(this.weth, this.usdc, this.minTick).toFixed(2)
  
      console.log("New range: " + minUsdc + " USDC - " + maxUsdc + " USDC.")
    }
  
    // Checking unclaimed fees is a nice-to-have for the logs but essential if we want to actually
    // claim fees in ETH at the time of removing liquidity. The docs say:
    //   When collecting fees in ETH, you must precompute the fees owed to protect against
    //   reentrancy attacks. In order to set a safety check, set the minimum fees owed in
    //   expectedCurrencyOwed0 and expectedCurrencyOwed1. To calculate this, quote the collect
    //   function and store the amounts. The interface does similar behavior here
    //   https://github.com/Uniswap/interface/blob/eff512deb8f0ab832eb8d1834f6d1a20219257d0/src/hooks/useV3PositionFees.ts#L32
    async checkUnclaimedFees() {
      if (!this.position || !this.tokenId) {
        console.error("Can't check unclaimed fees. Not in a position yet.")
        return
      }
  
      const MAX_UINT128 = BigNumber.from(2).pow(128).sub(1)
  
      // TODO: Set this once we know the real underlying type of tokenId. BigintIsh is no use.
      // const tokenIdHexString = ethers.utils.hexValue(this.tokenId)
      const tokenIdHexString = "todo"
  
      // const collectOptions: CollectOptions = {
      //   tokenId: this.tokenId,
      //   expectedCurrencyOwed0: CurrencyAmount.fromRawAmount(this.usdc, 0),
      //   expectedCurrencyOwed1: CurrencyAmount.fromRawAmount(this.weth, 0),
      //   recipient: w.address
      // }
  
      // const { calldata, value } = NonfungiblePositionManager.collectCallParameters(collectOptions)
  
      this.positionManagerContract.callStatic.collect({
        tokenId: tokenIdHexString,
        recipient: this.owner.address,
        amount0Max: MAX_UINT128,
        amount1Max: MAX_UINT128,
      },
      { from: this.owner.address })
      .then((results) => {
        this.unclaimedFeesUsdc = results.amount0
        this.unclaimedFeesWeth = results.amount1
  
        console.log("Unclaimed fees: " + this.unclaimedFeesUsdc + " USDC, " + this.unclaimedFeesWeth + " WETH")
      })
    }
  
    async removeLiquidity() {
      if (!this.position || !this.tokenId) {
        console.error("Can't remove liquidity. Not in a position yet.")
        return
      }

      if (this.poolImmutables == undefined || this.usdc == undefined || this.weth == undefined) throw "Not init()ed"
  
      // If we're only ever collecting fees in WETH and USDC, then the expectedCurrencyOwed0 and
      // expectedCurrencyOwed1 can be zero (CurrencyAmount.fromRawAmount(this.usdc, 0). But if we
      // ever want fees in ETH, which we may do to cover gas costs, then we need to get these
      // using a callStatic on collect() ahead of time.
      const expectedCurrencyOwed0 = CurrencyAmount.fromRawAmount(this.usdc, this.unclaimedFeesUsdc ?? 0)
      const expectedCurrencyOwed1 = CurrencyAmount.fromRawAmount(this.weth, this.unclaimedFeesWeth ?? 0)
  
      const collectOptions: CollectOptions = {
        tokenId: this.tokenId,
        expectedCurrencyOwed0: expectedCurrencyOwed0,
        expectedCurrencyOwed1: expectedCurrencyOwed1,
        recipient: this.owner.address
      }
  
      const removeLiquidityOptions: RemoveLiquidityOptions = {
        tokenId: this.tokenId,
        liquidityPercentage: new Percent(1), // 100%
        slippageTolerance: this.chainConfig.slippageTolerance,
        deadline: moment().unix() + DEADLINE_SECONDS,
        collectOptions: collectOptions
      }
  
      const {calldata, value} = NonfungiblePositionManager.removeCallParameters(this.position, removeLiquidityOptions)
  
      const nonce = await this.owner.getTransactionCount("latest")
      console.log("nonce: ", nonce)
  
      const tx = {
        from: this.owner.address,
        to: CONFIG.addrPositionManager,
        value: VALUE_ZERO_ETHER,
        nonce: nonce,
        gasLimit: this.chainConfig.gasLimit,
        gasPrice: this.chainConfig.gasPrice,
        data: calldata
      }
  
      // TODO: Switch to Kovan, fund the account with USDC and WETH and test.
      // w.sendTransaction(tx).then((transaction) => {
      //   console.dir(transaction)
      //   console.log("Send finished!")
      // }).catch(console.error)
    }
  
    async swap() {
      if (this.position || this.tokenId) {
        console.error("Refusing to swap. Still in a position. Remove liquidity first.")
        return
      }

      if (this.poolImmutables == undefined || this.usdc == undefined || this.weth == undefined) throw "Not init()ed"
  
      const usdcIn = "3375560000" // USDC, 6 decimals
  
      const quotedWethOut = await this.quoterContract.callStatic.quoteExactInputSingle(
        this.poolImmutables.token0, // Token in: USDC
        this.poolImmutables.token1, // Token out: WETH
        this.poolImmutables.fee, // 0.30%
        usdcIn, // Amount in, USDC (6 decimals)
        0 // sqrtPriceLimitX96
      )
  
      // Given 3_375_560_000, currently returns 996_997_221_346_111_279, ie. approx. 1 * 10^18 wei.
      console.log("Swapping " + usdcIn + " USDC will get us " + quotedWethOut.toString() + " WETH")

      if (this.swapPoolState == undefined) return
  
      const poolEthUsdcForSwaps = new Pool(
        this.usdc,
        this.weth,
        this.poolImmutables.fee, // TODO: Wrong. The fee is 0.05% here, not 0.30%.
        this.swapPoolState.sqrtPriceX96.toString(),
        this.swapPoolState.liquidity.toString(),
        this.swapPoolState.tick
      )
  
      const swapRoute = new Route([poolEthUsdcForSwaps], this.usdc, this.weth)

      // TODO: Execute swap.
    }
  
    async addLiquidity() {
      if (this.position || this.tokenId) {
        console.error("Can't add liquidity. Already in a position. Remove liquidity and swap first.")
        return
      }

      if (this.poolImmutables == undefined || this.usdc == undefined || this.weth == undefined) throw "Not init()ed"

      if (this.rangeOrderPoolState == undefined) throw "Not updatePoolState()ed"
  
      // We can't instantiate this pool instance until we have the pool state.
      const poolEthUsdcForRangeOrder = new Pool(
        this.usdc,
        this.weth,
        this.poolImmutables.fee,
        this.rangeOrderPoolState.sqrtPriceX96.toString(),
        this.rangeOrderPoolState.liquidity.toString(),
        this.rangeOrderPoolState.tick
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
      const amountUsdc: number = 3385.00 * 10 ^ this.usdc.decimals // 6 decimals
      const amountEth: number = 1.00 * 10 ^ this.weth.decimals // 18 decimals
  
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
        slippageTolerance: this.chainConfig.slippageTolerance,
        deadline: moment().unix() + DEADLINE_SECONDS,
        recipient: this.owner.address,
        createPool: false
      }
  
      // addCallParameters() implementation:
      //   https://github.com/Uniswap/v3-sdk/blob/6c4242f51a51929b0cd4f4e786ba8a7c8fe68443/src/nonfungiblePositionManager.ts#L164
      const { calldata, value } = NonfungiblePositionManager.addCallParameters(position, mintOptions)
  
      // console.log("calldata: ", calldata)
      // console.log("value: ", value)
  
      const nonce = await this.owner.getTransactionCount("latest")
      console.log("nonce: ", nonce)
  
      const tx = {
        from: this.owner.address,
        to: CONFIG.addrPositionManager,
        value: VALUE_ZERO_ETHER,
        nonce: nonce,
        gasLimit: this.chainConfig.gasLimit,
        gasPrice: this.chainConfig.gasPrice,
        data: calldata
      }
  
      // Currently failing with insufficient funds, which is as expected.
      // TODO: Switch to Kovan, fund the account with USDC and WETH and test.
      // w.sendTransaction(tx).then((transaction) => {
      //   console.dir(transaction)
      //   console.log("Send finished!")
      // }).catch(console.error)
  
      // TODO: Set the token ID on the dro instance.
    }
  }
