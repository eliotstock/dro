import { config } from 'dotenv'
import { BigNumber } from '@ethersproject/bignumber'
import { CollectOptions, FeeAmount, MintOptions, nearestUsableTick, NonfungiblePositionManager, Pool, Position, RemoveLiquidityOptions, Route, SwapOptions, SwapRouter, Tick, tickToPrice, Trade } from "@uniswap/v3-sdk"
import { CurrencyAmount, Percent, BigintIsh, TradeType, Currency, Fraction } from "@uniswap/sdk-core"
import { TickMath } from '@uniswap/v3-sdk/'
import { TransactionResponse, TransactionReceipt } from '@ethersproject/abstract-provider'
import moment, { Duration } from 'moment'
import { useConfig, ChainConfig } from './config'
import { wallet, gasPrice } from './wallet'
import { insertRerangeEvent, insertOrReplacePosition, getTokenIdForPosition } from './db'
import { rangeOrderPoolContract, swapPoolContract, quoterContract, positionManagerContract, usdcToken, wethToken, rangeOrderPoolTick, rangeOrderPoolPriceUsdc, rangeOrderPoolPriceUsdcAsBigNumber, rangeOrderPoolTickSpacing, extractTokenId, positionByTokenId, positionWebUrl, tokenOrderIsWethFirst, DEADLINE_SECONDS, VALUE_ZERO_ETHER } from './uniswap'
import { AlphaRouter, SwapToRatioResponse, SwapToRatioRoute, SwapToRatioStatus } from '@uniswap/smart-order-router'
import { forwardTestInit, forwardTestRerange } from './forward-test'
import invariant from 'tiny-invariant'

const OUT_DIR = './out'

// Read our .env file
config()

// Static config that doesn't belong in the .env file.
const CHAIN_CONFIG: ChainConfig = useConfig()

export enum Direction {
  Up = 'up',
  Down = 'down'
}

export class DRO {
    readonly rangeWidthTicks: number
    readonly noops: boolean

    minTick: number = 0
    maxTick: number = 0
    entryTick: number = 0
    wethFirst: boolean = true
    position?: Position
    tokenId?: BigintIsh
    unclaimedFeesUsdc?: BigintIsh
    unclaimedFeesWeth?: BigintIsh
    lastRerangeTimestamp?: string
    locked: boolean = false
  
    constructor(
      _rangeWidthTicks: number,
      _noops: boolean) {
      this.rangeWidthTicks = _rangeWidthTicks
      this.noops = _noops
    }

    async init() {      
      // Get the token ID for our position from the database.
      const tokenId = await getTokenIdForPosition(this.rangeWidthTicks)

      if (tokenId) {
        this.tokenId = tokenId

        // Now get the position from Uniswap for the given token ID.
        const position: Position = await positionByTokenId(tokenId)

        if (position) {
          // TODO: Won't this.minTick be undefined at this point? updateRange() has not been called
          // yet.
          if (position.tickLower != this.minTick || position.tickUpper != this.maxTick) {
            console.log(`Expected min and max ticks: ${this.minTick}, ${this.maxTick}. \
Got: ${position.tickLower}, ${position.tickUpper}`)
            // TODO: Make that a console.error() and return here.
          }

          this.position = position
        }

        console.log(`[${this.rangeWidthTicks}] Token ID: ${this.tokenId}`)
      }
      else {
        console.log(`[${this.rangeWidthTicks}] No existing position NFT`)
      }

      // The order of the tokens in the pool varies from chain to chain, annoyingly.
      // Ethereum mainnet: USDC is first
      // Arbitrum mainnet: WETH is first
      this.wethFirst = await tokenOrderIsWethFirst()

      forwardTestInit(this.rangeWidthTicks)
    }
  
    outOfRange() {
        return rangeOrderPoolTick &&
          (rangeOrderPoolTick < this.minTick || rangeOrderPoolTick > this.maxTick)
    }
  
    // Note that if rangeWidthTicks is not a multiple of the tick spacing for the pool, the range
    // returned here can be quite different to rangeWidthTicks.
    updateRange() {
      if (rangeOrderPoolTick == undefined) throw 'No tick yet.'

      const noRangeYet: boolean = (this.minTick == 0)

      let direction: Direction
      
      if (this.wethFirst) {
        // Pool on Arbitrum mainnet: A lower tick value means a lower price in USDC.
        direction = rangeOrderPoolTick < this.minTick ? Direction.Down : Direction.Up
      }
      else {
        // Pool on Ethereum mainnet: A lower tick value means a higher price in USDC.
        direction = rangeOrderPoolTick < this.minTick ? Direction.Up : Direction.Down
      }

      let timeInRange: Duration
      let timeInRangeReadable: string = 'an unknown period'
      let forwardTestLogLine: string = ''

      if (this.lastRerangeTimestamp) {
        const a = moment(this.lastRerangeTimestamp)
        const b = moment() // Now
        const timeToRerangingMillis = b.diff(a)
        timeInRange = moment.duration(timeToRerangingMillis, 'milliseconds')
        timeInRangeReadable = timeInRange.humanize()

        // Do some forward testing on how this range width is performing.
        forwardTestLogLine = forwardTestRerange(this.rangeWidthTicks,
          timeInRange,
          direction)
      }

      this.lastRerangeTimestamp = moment().toISOString()

      this.minTick = Math.round(rangeOrderPoolTick - (this.rangeWidthTicks / 2))

      // Don't go under MIN_TICK, which can happen on testnets.
      this.minTick = Math.max(this.minTick, TickMath.MIN_TICK)
      this.minTick = nearestUsableTick(this.minTick, rangeOrderPoolTickSpacing)
  
      this.maxTick = Math.round(rangeOrderPoolTick + (this.rangeWidthTicks / 2))

      // Don't go over MAX_TICK, which can happen on testnets.
      this.maxTick = Math.min(this.maxTick, TickMath.MAX_TICK)
      this.maxTick = nearestUsableTick(this.maxTick, rangeOrderPoolTickSpacing)
  
      let minUsdc = 'unknown'
      let maxUsdc = 'unknown'

      // tickToPrice() implementation:
      //   https://github.com/Uniswap/v3-sdk/blob/6c4242f51a51929b0cd4f4e786ba8a7c8fe68443/src/utils/priceTickConversions.ts#L14
      if (this.wethFirst) {
        // Arbitrum mainnet
        //   WETH is token 0, USDC is token 1
        //   Minimum USDC value per ETH corresponds to the minimum tick value
        minUsdc = tickToPrice(wethToken, usdcToken, this.minTick).toFixed(2)
        maxUsdc = tickToPrice(wethToken, usdcToken, this.maxTick).toFixed(2)
      }
      else {
        // Ethereum mainnet:
        //   USDC is token 0, WETH is token 1
        //   Minimum USDC value per ETH corresponds to the maximum tick value
        //   Counterintuitively, WETH is still the first token we pass to tickToPrice()
        minUsdc = tickToPrice(wethToken, usdcToken, this.maxTick).toFixed(2)
        maxUsdc = tickToPrice(wethToken, usdcToken, this.minTick).toFixed(2)
      }

      this.entryTick = rangeOrderPoolTick

      if (noRangeYet) {
        console.log(`[${this.rangeWidthTicks}] Initial range: ${minUsdc} <-> ${maxUsdc}`)
      }
      else {
        // Insert a row in the database for analytics, except when we're just starting up and there's
        // no range yet.
        insertRerangeEvent(this.rangeWidthTicks, moment().toISOString(), direction)

        console.log(`[${this.rangeWidthTicks}] Re-ranging ${direction} after ${timeInRangeReadable} to ${minUsdc} <-> ${maxUsdc}`)
      }

      if (forwardTestLogLine.length > 0) {
        console.log(forwardTestLogLine)
      }
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
  
      positionManagerContract.callStatic.collect({
        tokenId: tokenIdHexString,
        recipient: wallet.address,
        amount0Max: MAX_UINT128,
        amount1Max: MAX_UINT128,
      },
      { from: wallet.address })
      .then((results) => {
        this.unclaimedFeesUsdc = results.amount0
        this.unclaimedFeesWeth = results.amount1
  
        console.log(`[${this.rangeWidthTicks}] Unclaimed fees: ${this.unclaimedFeesUsdc} USDC, ${this.unclaimedFeesWeth} WETH`)
      })
    }
  
    async removeLiquidity() {
      if (!this.position || !this.tokenId) {
        console.error("Can't remove liquidity. Not in a position yet.")
        return
      }
  
      // If we're only ever collecting fees in WETH and USDC, then the expectedCurrencyOwed0 and
      // expectedCurrencyOwed1 can be zero (CurrencyAmount.fromRawAmount(this.usdc, 0). But if we
      // ever want fees in ETH, which we may do to cover gas costs, then we need to get these
      // using a callStatic on collect() ahead of time.
      const expectedCurrencyOwed0 = CurrencyAmount.fromRawAmount(usdcToken, this.unclaimedFeesUsdc ?? 0)
      const expectedCurrencyOwed1 = CurrencyAmount.fromRawAmount(wethToken, this.unclaimedFeesWeth ?? 0)
  
      const collectOptions: CollectOptions = {
        tokenId: this.tokenId,
        expectedCurrencyOwed0: expectedCurrencyOwed0,
        expectedCurrencyOwed1: expectedCurrencyOwed1,
        recipient: wallet.address
      }
  
      const removeLiquidityOptions: RemoveLiquidityOptions = {
        tokenId: this.tokenId,
        liquidityPercentage: new Percent(1),
        slippageTolerance: CHAIN_CONFIG.slippageTolerance,
        deadline: moment().unix() + DEADLINE_SECONDS,
        collectOptions: collectOptions
      }
  
      const {calldata, value} = NonfungiblePositionManager.removeCallParameters(this.position,
        removeLiquidityOptions)
  
      const nonce = await wallet.getTransactionCount("latest")
  
      const txRequest = {
        from: wallet.address,
        to: CHAIN_CONFIG.addrPositionManager,
        value: VALUE_ZERO_ETHER,
        nonce: nonce,
        gasLimit: CHAIN_CONFIG.gasLimit,
        gasPrice: CHAIN_CONFIG.gasPrice,
        data: calldata
      }
  
      const txResponse: TransactionResponse = await wallet.sendTransaction(txRequest)
      console.log(`removeLiquidity() TX response:`)
      console.dir(txResponse)

      const txReceipt: TransactionReceipt = await txResponse.wait()
      console.log(`removeLiquidity() TX receipt:`)
      console.dir(txReceipt)

      // Forget our old token ID and position details so that we can move on.
      this.tokenId = undefined
      this.position = undefined
    }
  
    async swap() {
      if (this.position || this.tokenId)
         throw "Refusing to swap. Still in a position. Remove liquidity first."

      const swapPoolFee = await swapPoolContract.fee()

      // The Pool instance depends on the pool liquidity and slot 0 so we need to reconstruct it
      // every time.
      const liquidity = await swapPoolContract.liquidity()
      const slot = await swapPoolContract.slot0()

      const poolEthUsdcForSwaps = new Pool(
        usdcToken,
        wethToken,
        swapPoolFee, // 0.05%
        slot[0].toString(), // sqrtRatioX96
        liquidity.toString(),
        slot[1] // tickCurrent
      )

      const usdc = await wallet.usdc()
      const weth = await wallet.weth()

      // TODO: Zero is no use to us here. Fake it on testnets, or fix the pool we're in.
      console.log(`Range order pool price: ${rangeOrderPoolPriceUsdc} USDC`)

      // This is USDC * 10^-6 as an integer (BigNumber).
      const u = rangeOrderPoolPriceUsdcAsBigNumber()

      let usdcValueOfWethBalance = BigNumber.from(u).mul(weth)

      // Avoid a division by zero error below. Any very small integer will do here.
      if (usdcValueOfWethBalance.eq(BigNumber.from(0))) {
        usdcValueOfWethBalance = BigNumber.from(1)
      }

      console.log(`[${this.rangeWidthTicks}] We have ${usdc.toString()} USDC and \
${u.toString()} USDC worth of WETH.`)

      // What is the ratio of the value of our USDC balance to our WETH balance? Note that we're
      // using the price in the range order pool, not the swap pool, but the difference will be
      // small and we only need very low precision here.
      const ratioUsdcToWeth = usdc.div(usdcValueOfWethBalance)

      let tokenIn
      let tokenOut
      let amountIn
      let swapRoute

      // We should be almost entirely in one asset or the other, because we only removed liquidity
      // once we were at the edge of our range. We do have some fees just claimed in the other
      // asset, however.
      if (ratioUsdcToWeth.gt(1.0)) {
        console.log(`[${this.rangeWidthTicks}] We're mostly in USDC now. Swapping half our USDC to WETH.`)

        tokenIn = CHAIN_CONFIG.addrTokenUsdc
        tokenOut = CHAIN_CONFIG.addrTokenWeth
        amountIn = usdc.div(2)

        // The order of the tokens here is significant. Input first.
        swapRoute = new Route([poolEthUsdcForSwaps], usdcToken, wethToken)
      }
      else {
        console.log(`[${this.rangeWidthTicks}] We're mostly in WETH now. Swapping half our WETH to USDC.`)

        tokenIn = CHAIN_CONFIG.addrTokenWeth
        tokenOut = CHAIN_CONFIG.addrTokenUsdc
        amountIn = weth.div(2)

        swapRoute = new Route([poolEthUsdcForSwaps], wethToken, usdcToken)
      }
  
      // This will revert with code -32015 on testnets if there is no pool for the token addresses
      // passed in. Create a pool first.
      // It would be nice to try/catch here, inspect error.body.error.code here and handle -32015
      // but the type of e is always unknown.
      const quotedAmountOut = await quoterContract.callStatic.quoteExactInputSingle(
        tokenIn,
        tokenOut,
        swapPoolFee, // 0.05%
        amountIn,
        0 // sqrtPriceLimitX96
      )

      let trade: Trade<Currency, Currency, TradeType>

      if (ratioUsdcToWeth.gt(1.0)) {
        // Swapping USDC to WETH
        trade = await Trade.createUncheckedTrade({
          route: swapRoute,
          inputAmount: CurrencyAmount.fromRawAmount(usdcToken, usdc.toString()),
          outputAmount: CurrencyAmount.fromRawAmount(wethToken, quotedAmountOut.toString()),
          tradeType: TradeType.EXACT_INPUT,
        })
      }
      else {
        // Swapping WETH to USDC
        trade = await Trade.createUncheckedTrade({
          route: swapRoute,
          inputAmount: CurrencyAmount.fromRawAmount(wethToken, weth.toString()),
          outputAmount: CurrencyAmount.fromRawAmount(usdcToken, quotedAmountOut.toString()),
          tradeType: TradeType.EXACT_INPUT,
        })
      }

      console.log(`[${this.rangeWidthTicks}] Trade:`)
      console.dir(trade)

      const options: SwapOptions = {
        slippageTolerance: CHAIN_CONFIG.slippageTolerance,
        recipient: wallet.address,
        deadline: moment().unix() + DEADLINE_SECONDS
      }

      const { calldata, value } = SwapRouter.swapCallParameters(trade, options)
      // console.log("calldata: ", calldata)

      const nonce = await wallet.getTransactionCount("latest")
  
      // Sending WETH, not ETH, so value is zero here. WETH amount is in the call data.
      const txRequest = {
        from: wallet.address,
        to: CHAIN_CONFIG.addrSwapRouter,
        value: VALUE_ZERO_ETHER,
        nonce: nonce,
        gasLimit: CHAIN_CONFIG.gasLimit,
        gasPrice: CHAIN_CONFIG.gasPrice,
        data: calldata
      }

      // If we run out of gas here on a testnet, note this comment from Uniswap's Discord dev-chat
      // channel:
      //   looks like that pool is probably sitting at a bad price
      //   in v3 it loops though the ticks and liquidity and when it has a bad price it has to
      //   loop more causing need for more gas
      //   if it's your pool fix the balance in the pool
      //   right now there is a lot of the USDC and very little weth
      const txResponse: TransactionResponse = await wallet.sendTransaction(txRequest)
      console.log(`swap() TX response:`)
      console.dir(txResponse)

      const txReceipt: TransactionReceipt = await txResponse.wait()
      console.log(`swap() TX receipt:`)
      console.dir(txReceipt)
    }
  
    async addLiquidity() {
      if (this.position || this.tokenId)
        throw "Can't add liquidity. Already in a position. Remove liquidity and swap first."
  
      // Ethers.js uses its own BigNumber but Uniswap expects a JSBI, or a string. A String is
      // easier.
      const availableUsdc = (await wallet.usdc()).toString()
      const availableWeth = (await wallet.weth()).toString()

      const slot = await rangeOrderPoolContract.slot0()

      // The fee in the pool determines the tick spacing and if it's zero, the tick spacing will be
      // undefined. This will throw an error when the position gets created.
      invariant(slot[5] > 0, 'Pool has no fee')

      const liquidity = await rangeOrderPoolContract.liquidity()

      // A position instance requires a Pool instance.
      let rangeOrderPool: Pool

      // It's difficult to keep a range order pool liquid on testnet, even one we've created
      // ourselves.
      if (CHAIN_CONFIG.isTestnet) {
        // If we don't pass some ticks to the Pool constructor, the pool's tick spacing is
        // undefined and creating the position instance fails.
        // const ticks: Tick[] = [
        //   {
        //     index: nearestUsableTick(TickMath.MIN_TICK, rangeOrderPoolTickSpacing),
        //     liquidityNet: liquidity,
        //     liquidityGross: liquidity
        //   },
        //   {
        //     index: nearestUsableTick(TickMath.MAX_TICK, rangeOrderPoolTickSpacing),
        //     liquidityNet: BigNumber.from(liquidity).mul(-1).toString(),
        //     liquidityGross: liquidity
        //   }
        // ]
        // TODO: Actually it's probably just passing FeeAmount.MEDIUM below that fixed this. Remove
        // the above if so.

        rangeOrderPool = new Pool(
          usdcToken,
          wethToken,
          FeeAmount.MEDIUM, // Fee: 0.30%
          slot[0].toString(), // SqrtRatioX96
          liquidity.toString(), // Liquidity
          slot[1], // Tick
          // ticks
        )

        // Rather than require minTick and maxTick to be valid, replace them with valid values on
        // testnets. These were observed on a manually created position, therefore they're valid.
        this.minTick = 191580
        this.maxTick = 195840
      }
      else {
        rangeOrderPool = new Pool(
          usdcToken,
          wethToken,
          slot[5], // Fee: 0.30%
          slot[0].toString(), // SqrtRatioX96
          liquidity.toString(), // Liquidity
          slot[1] // Tick
        )
      }
  
      // We don't know L, the liquidity, but we do know how much WETH and how much USDC we'd like
      // to add, which is all of it.
      const position = Position.fromAmounts({
        pool: rangeOrderPool,
        tickLower: this.minTick,
        tickUpper: this.maxTick,
        amount0: availableUsdc,
        amount1: availableWeth,
        useFullPrecision: true
      })
  
      // console.log(`addLiquidity() Amounts desired: ${position.mintAmounts.amount0.toString()} USDC \
      // ${position.mintAmounts.amount1.toString()} WETH`)
  
      const mintOptions: MintOptions = {
        slippageTolerance: CHAIN_CONFIG.slippageTolerance,
        deadline: moment().unix() + DEADLINE_SECONDS,
        recipient: wallet.address,
        createPool: false
      }
  
      // addCallParameters() implementation:
      //   https://github.com/Uniswap/v3-sdk/blob/6c4242f51a51929b0cd4f4e786ba8a7c8fe68443/src/nonfungiblePositionManager.ts#L164
      // TODO: Prevent this error here when on testnets:
      /*
      Error: Invariant failed: ZERO_LIQUIDITY
          at invariant (/home/e/r/dro/dro/node_modules/tiny-invariant/dist/tiny-invariant.cjs.js:13:11)
          at Function.addCallParameters (/home/e/r/dro/dro/node_modules/@uniswap/v3-sdk/src/nonfungiblePositionManager.ts:200:5)
          at DRO.<anonymous> (/home/e/r/dro/dro/src/dro.ts:456:62)
      */
      const { calldata, value } = NonfungiblePositionManager.addCallParameters(position, mintOptions)
  
      // console.log(`addLiquidity() calldata: ${calldata}`)
  
      const nonce = await wallet.getTransactionCount("latest")
  
      // Sending WETH, not ETH, so value is zero here. WETH amount is in the call data.
      const txRequest = {
        from: wallet.address,
        to: CHAIN_CONFIG.addrPositionManager,
        value: VALUE_ZERO_ETHER,
        nonce: nonce,
        gasLimit: CHAIN_CONFIG.gasLimit,
        gasPrice: CHAIN_CONFIG.gasPrice,
        data: calldata
      }
  
      // Send the transaction to the provider.
      const txResponse: TransactionResponse = await wallet.sendTransaction(txRequest)
      console.log(`addLiquidity() TX response:`)
      console.dir(txResponse)

      const txReceipt: TransactionReceipt = await txResponse.wait()
      console.log(`addLiquidity() TX receipt:`)
      console.dir(txReceipt)

      this.tokenId = extractTokenId(txReceipt)
      this.position = position

      if (this.tokenId) {
        const webUrl = positionWebUrl(this.tokenId)
        console.log(`Position URL: ${webUrl}`)

        insertOrReplacePosition(this.rangeWidthTicks, moment().toISOString(), this.tokenId)
      }
      else {
        console.error(`No token ID from logs. We won't be able to remove this liquidity.`)
      }
    }

    async swapAndAddLiquidity() {
      if (this.position || this.tokenId)
         throw "Refusing to swap and add liquidity. Still in a position. Remove liquidity first."

      // The order of the tokens in the pool varies from chain to chain, annoyingly.
      // Ethereum mainnet: USDC is first
      // Arbitrum mainnet: WETH is first
      let token0Balance
      let token1Balance

      // The wallet gives us BigNumbers for balances, but Uniswap's CurrencyAmount takes a
      // BigintIsh, which is a JSBI, string or number.
      if (this.wethFirst) {
        token0Balance = CurrencyAmount.fromRawAmount(wethToken, await (await wallet.weth()).toString())
        token1Balance = CurrencyAmount.fromRawAmount(usdcToken, await (await wallet.usdc()).toString())
      }
      else {
        token0Balance = CurrencyAmount.fromRawAmount(usdcToken, await (await wallet.usdc()).toString())
        token1Balance = CurrencyAmount.fromRawAmount(wethToken, await (await wallet.weth()).toString())
      }

      console.log(`Token 0 balance: ${token0Balance.toFixed(4)}, token 1 balance: ${token1Balance.toFixed(4)}`)

      const slot = await rangeOrderPoolContract.slot0()

      // The fee in the pool determines the tick spacing and if it's zero, the tick spacing will be
      // undefined. This will throw an error when the position gets created.
      // invariant(slot[5] > 0, 'Pool has no fee')
      const fee = slot[5] > 0 ? slot[5] : FeeAmount.MEDIUM

      const liquidity = await rangeOrderPoolContract.liquidity()

      // A position instance requires a Pool instance.
      let rangeOrderPool: Pool

      // It's difficult to keep a range order pool liquid on testnet, even one we've created
      // ourselves.
      if (CHAIN_CONFIG.isTestnet) {
        rangeOrderPool = new Pool(
          usdcToken,
          wethToken,
          fee, // Fee: 0.30%
          slot[0].toString(), // SqrtRatioX96
          liquidity.toString(), // Liquidity
          slot[1], // Tick
          // ticks
        )

        // Rather than require minTick and maxTick to be valid, replace them with valid values on
        // testnets. These were observed on a manually created position, therefore they're valid.
        this.minTick = 191580
        this.maxTick = 195840
      }
      else {
        rangeOrderPool = new Pool(
          usdcToken,
          wethToken,
          fee, // Fee: 0.30%
          slot[0].toString(), // SqrtRatioX96
          liquidity.toString(), // Liquidity
          slot[1] // Tick
        )
      }

      // From the SDK docs: "The position liquidity can be set to 1, since liquidity is still
      // unknown and will be set inside the call to routeToRatio()."
      const p = new Position({
        pool: rangeOrderPool,
        tickLower: this.minTick,
        tickUpper: this.maxTick,
        liquidity: 1
      })

      const deadlineValue = moment().unix() + 1800

      console.log(`deadline: ${deadlineValue}`)

      const router = new AlphaRouter({chainId: CHAIN_CONFIG.chainId, provider: CHAIN_CONFIG.provider()})

      console.log(`Calling routeToRatio()`)

      // Source: https://github.com/Uniswap/smart-order-router/blob/main/src/routers/alpha-router/alpha-router.ts
      //         https://github.com/Uniswap/smart-order-router/blob/main/src/routers/alpha-router/functions/calculate-ratio-amount-in.ts#L17
      // calldata built here:
      //   https://github.com/Uniswap/smart-order-router/blob/b19ebcb3f3e2b6b10a8021884f5336c8735ba8a5/src/routers/alpha-router/alpha-router.ts#L1303
      //   SwapRouter.swapAndAddCallParameters(): https://github.com/Uniswap/router-sdk/blob/7d989fbe285abf32a63c602221cd136651e39103/src/swapRouter.ts#L376
      // Adding the repos for the Uniswap projects locally and then adding this to package.json doesn't work for debugging:
      //     "@uniswap/sdk-core": "file:../sdk-core",
      //     "@uniswap/smart-order-router": "file:../smart-order-router",
      //     "@uniswap/v3-sdk": "file:../v3-sdk",
      //     "@uniswap/router-sdk": "file:../router-sdk",
      // Latest version numbers:
      //     "@uniswap/sdk-core": "^3.0.1",
      //     "@uniswap/smart-order-router": "^2.5.15",
      //     "@uniswap/v3-sdk": "^3.8.1",
      const routeToRatioResponse: SwapToRatioResponse = await router.routeToRatio(
        token0Balance,
        token1Balance,
        p,
        // swapAndAddConfig
        {
          ratioErrorTolerance: new Fraction(5, 100),
          maxIterations: 1,
        },
        // swapAndAddOptions
        {
           swapOptions: {
             recipient: wallet.address,
             slippageTolerance: new Percent(5, 100),
             deadline: deadlineValue
           },
           addLiquidityOptions: {
             recipient: wallet.address
           }
         }
      )

      // console.log(`routeToRatioResponse:`)
      // console.dir(routeToRatioResponse)

      if (routeToRatioResponse.status == SwapToRatioStatus.SUCCESS) {
        const route: SwapToRatioRoute = routeToRatioResponse.result

        console.log(`route:`)
        console.dir(route)

        console.log(`methodParameters:`)
        console.dir(route.methodParameters)

        console.log(`first trade swap:`)
        console.dir(route.trade.swaps[0])

        console.log(`first trade route:`)
        console.dir(route.trade.routes[0])

        console.log(`trade input amount: ${route.trade.inputAmount.toFixed(2)} ${route.trade.inputAmount.currency.symbol}, output amount: ${route.trade.outputAmount.toFixed(2)} ${route.trade.outputAmount.currency.symbol}`)

        console.log(`optimalRatio: ${route.optimalRatio.toFixed(4)}`)

        // console.log(`Gas price from route: ${route.gasPriceWei} wei`)
        // console.log(`Gas price from config: ${CHAIN_CONFIG.gasPrice.toString()}`)

        // calldata is generated by the router-sdk module, here:
        // https://github.com/Uniswap/router-sdk/blob/7d989fbe285abf32a63c602221cd136651e39103/src/swapRouter.ts#L376

        const nonce = await wallet.getTransactionCount("latest")

        // Not providing the gasLimit will throw UNPREDICTABLE_GAS_LIMIT.
        // Using gasLimit of 1_000_000 will throw "not enough funds for gas", even with 0.04 ETH in the account.
        // Same for 500_000.
        // Same for 100_000.
        const txRequest = {
          from: wallet.address,
          to: CHAIN_CONFIG.addrSwapRouter2,
          value: BigNumber.from(route.methodParameters?.value),
          nonce: nonce,
          // gasPrice: BigNumber.from(route.gasPriceWei),
          gasPrice: CHAIN_CONFIG.gasPrice,
          gasLimit: CHAIN_CONFIG.gasLimit,
          data: route.methodParameters?.calldata,
        }

        // If we run out of gas here on a testnet, note this comment from Uniswap's Discord dev-chat
        // channel:
        //   looks like that pool is probably sitting at a bad price
        //   in v3 it loops though the ticks and liquidity and when it has a bad price it has to
        //   loop more causing need for more gas
        //   if it's your pool fix the balance in the pool
        //   right now there is a lot of the USDC and very little weth
        const txResponse: TransactionResponse = await wallet.sendTransaction(txRequest)
        console.log(`swapAndAddLiquidity() TX response:`)
        console.dir(txResponse)

        const txReceipt: TransactionReceipt = await txResponse.wait()
        console.log(`swapAndAddLiquidity() TX receipt:`)
        console.dir(txReceipt)

        this.tokenId = extractTokenId(txReceipt)
        this.position = p

        if (this.tokenId) {
          const webUrl = positionWebUrl(this.tokenId)
          console.log(`Position URL: ${webUrl}`)

          insertOrReplacePosition(this.rangeWidthTicks, moment().toISOString(), this.tokenId)
        }
        else {
          throw `No token ID from logs. We won't be able to remove this liquidity.`
        }
      }
      else {
        throw `Swap to ratio failed. Status: ${SwapToRatioStatus[routeToRatioResponse.status]}`
      } 
    }

    async onBlock() {
      // When in no-op mode, don't execute any transactions but do re-range when necessary.
      if (this.noops) {
        if (this.outOfRange()) {
          if (gasPrice?.gt(CHAIN_CONFIG.gasPriceMax)) {
            return
          }
          
          this.updateRange()
        }

        return
      }

      // Are we now out of range?
      if (this.outOfRange()) {
        if (this.locked) {
          // console.log(`[${this.rangeWidthTicks}] Skipping block. Already busy re-ranging.`)
          return
        }

        if (gasPrice?.gt(CHAIN_CONFIG.gasPriceMax)) {
          console.log(`Gas price of ${gasPrice.div(1e9).toNumber()} is over our max of \
${CHAIN_CONFIG.gasPriceMax.div(1e9).toNumber()} gwei. Not re-ranging yet.`)
          return
        }

        this.locked = true

        // Check fees before removing liquidity. Not strictly required if we're never claiming fees
        // in ETH.
        // await this.checkUnclaimedFees()

        // Take note of what assets we now hold
        await wallet.logBalances()

        // Remove all of our liquidity now and burn the NFT for our position.
        await this.removeLiquidity()

        // Take note of what assets we now hold
        await wallet.logBalances()

        // Find our new range around the current price.
        this.updateRange()

        // Swap half our assets to the other asset so that we have equal value of assets.
        // await this.swap()

        // Add all our WETH and USDC to a new liquidity position.
        // await this.addLiquidity()

        // Deposit assets and let the protocol swap the optimal size for the liquidity position,
        // then enter the liquidity position all in one transaction.
        await this.swapAndAddLiquidity()

        // Take note of what assets we now hold
        await wallet.logBalances()

        this.locked = false
      }
    }
  }
