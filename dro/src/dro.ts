import { config } from 'dotenv'
import JSBI from 'jsbi'
import { ethers } from 'ethers'
import {
  TransactionResponse,
  TransactionReceipt,
  TransactionRequest
} from '@ethersproject/abstract-provider'
import moment, { Duration } from 'moment'
import { useConfig, ChainConfig, useProvider } from './config'
import { wallet, gasPrice, gasPriceFormatted, jsbiFormatted, updateGasPrice } from './wallet'
import { TOKEN_USDC, TOKEN_WETH } from './tokens'

import {
  rangeOrderPoolContract,
  positionManagerContract,
  rangeOrderPoolTick,
  useSwapPool,
  useRangeOrderPool,
  extractTokenId,
  positionWebUrl,
  tokenOrderIsWethFirst,
  DEADLINE_SECONDS,
  VALUE_ZERO_ETHER,
  removeCallParameters,
  price,
  rangeAround,
  calculateRatioAmountIn,
  currentPosition,
  PositionWithTokenId
} from './uniswap'

// Uniswap SDK interface
import {
  Currency,
  CurrencyAmount,
  Fraction,
  Token,
  TradeType
} from '@uniswap/sdk-core'
import {
  MintOptions,
  NonfungiblePositionManager,
  Pool,
  Position,
  Route,
  SwapOptions,
  SwapRouter,
  TickMath,
  tickToPrice,
  Trade
} from '@uniswap/v3-sdk'
import { AlphaRouter } from '@uniswap/smart-order-router'
import { formatUnits } from 'ethers/lib/utils'
import { metrics } from './metrics'

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

    tickLower: number = 0
    tickUpper: number = 0
    rangeOrderPool?: Pool
    swapPool?: Pool
    wethFirstInRangeOrderPool: boolean = true
    wethFirstInSwapPool: boolean = true
    position?: PositionWithTokenId
    tickSpacing?: number
    unclaimedFeesUsdc: bigint = 0n
    unclaimedFeesWeth: bigint = 0n
    lastRerangeTimestamp?: string
    locked: boolean = false
    totalGasCost: number = 0
    alphaRouter: AlphaRouter
  
    constructor(
      _rangeWidthTicks: number,
      _noops: boolean) {
      this.rangeWidthTicks = _rangeWidthTicks
      this.noops = _noops
      this.alphaRouter = new AlphaRouter({chainId: CHAIN_CONFIG.chainId, provider: useProvider()})
    }

    async init() {
      // The order of the tokens in the pool varies from chain to chain, annoyingly.
      // Ethereum mainnet: USDC is first
      // Arbitrum mainnet: WETH is first
      this.wethFirstInRangeOrderPool = await tokenOrderIsWethFirst(rangeOrderPoolContract)

      // We need this in order to find the new range each time.
      this.tickSpacing = await rangeOrderPoolContract.tickSpacing()

      const p = await currentPosition(wallet.address)

      if (p === undefined) {
        // Expected when in no-op mode.
      }
      else {
        this.position = p
        this.tickLower = p.position.tickLower
        this.tickUpper = p.position.tickUpper

        // Note that at this point, tickLower and tickUpper are based on the existing position
        // whereas rangeWidthTicks is from the .env file. The two may not agree!

        this.logRangeInUsdcTerms()
      }
    }

    // Refresh our Position and Pool instances from the current state on the chain before we use
    // them.
    async reinitMutables() {
      // We are not in a position when run in no-op mode.
      if (this.position !== undefined) {
        // Take note of how the liquidity in the position has changed since we opened the position
        // (or restarted the dro process). Calling decreaseLiquidity() with a liquidity parameter
        // that is not equal to the liquidity currently in the position can cause the TX to fail.
        const liquidityBefore = this.position.position.liquidity

        this.position = await currentPosition(wallet.address)

        if (this.position === undefined) {
          throw `[${this.rangeWidthTicks}] Position disappeared on reinit.`
        }

        const liquidityAfter = this.position.position.liquidity

        if (JSBI.notEqual(JSBI.BigInt(liquidityBefore), JSBI.BigInt(liquidityAfter))) {
          console.log(`[${this.rangeWidthTicks}] removeLiquidity() Liquidity was \
  ${jsbiFormatted(liquidityBefore)} at opening of position/restarting and is now \
  ${jsbiFormatted(liquidityAfter)}`)
        }
      }

      const [swapPool, wethFirstInSwapPool] = await useSwapPool()

      this.swapPool = swapPool
      this.wethFirstInSwapPool = wethFirstInSwapPool

      const [rangeOrderPool, wethFirstInRangeOrderPool] = await useRangeOrderPool()

      this.rangeOrderPool = rangeOrderPool
      this.wethFirstInRangeOrderPool = wethFirstInRangeOrderPool

      // Force a gas price update and logging, even on L2.
      updateGasPrice(true)
    }
  
    outOfRange() {
      // When newly constructed, this.tickLower == this.tickUpper == 0 and we return true here.
      return rangeOrderPoolTick &&
        (rangeOrderPoolTick < this.tickLower || rangeOrderPoolTick > this.tickUpper)
    }

    inPosition(): boolean {
      return this.position !== undefined
    }

    logRangeInUsdcTerms() {
      let lowerTickPrice = tickToPrice(TOKEN_WETH, TOKEN_USDC, this.tickLower)
      let upperTickPrice = tickToPrice(TOKEN_WETH, TOKEN_USDC, this.tickUpper)

      metrics.rangeUpperBound.set(Number(upperTickPrice.toFixed(2)));
      metrics.rangeLowerBound.set(Number(lowerTickPrice.toFixed(2)));

      let minUsdc
      let maxUsdc

      // tickToPrice() implementation:
      //   https://github.com/Uniswap/v3-sdk/blob/6c4242f51a51929b0cd4f4e786ba8a7c8fe68443/src/utils/priceTickConversions.ts#L14
      if (this.wethFirstInRangeOrderPool) {
        // Arbitrum mainnet
        //   WETH is token 0, USDC is token 1
        //   Minimum USDC value per ETH corresponds to the minimum tick value
        minUsdc = lowerTickPrice.toFixed(2, {groupSeparator: ','})
        maxUsdc = upperTickPrice.toFixed(2, {groupSeparator: ','})
      }
      else {
        // Ethereum mainnet:
        //   USDC is token 0, WETH is token 1
        //   Minimum USDC value per ETH corresponds to the maximum tick value
        //   Counterintuitively, WETH is still the first token we pass to tickToPrice()
        minUsdc = upperTickPrice.toFixed(2, {groupSeparator: ','})
        maxUsdc = lowerTickPrice.toFixed(2, {groupSeparator: ','})
      }

      console.log(`[${this.rangeWidthTicks}] Range: ${minUsdc} <-> ${maxUsdc}`)
    }
  
    setNewRange() {
      if (rangeOrderPoolTick == undefined) throw 'No tick yet.'
      if (this.tickSpacing == undefined) throw 'No tick spacing'

      const [lower, upper] = rangeAround(rangeOrderPoolTick, this.rangeWidthTicks, this.tickSpacing)
      this.tickLower = lower
      this.tickUpper = upper

      this.logRangeInUsdcTerms()
    }

    logRerangeEvent() {
      const notInitialRange: boolean = (this.tickLower != 0)

      let direction: Direction
      
      if (this.wethFirstInRangeOrderPool) {
        // Pool on Arbitrum: A lower tick value means a lower price in USDC.
        direction = rangeOrderPoolTick < this.tickLower ? Direction.Down : Direction.Up
      }
      else {
        // Pool on Ethereum Mainnet: A lower tick value means a higher price in USDC.
        direction = rangeOrderPoolTick < this.tickLower ? Direction.Up : Direction.Down
      }

      let timeInRange: Duration
      let timeInRangeReadable: string = 'an unknown period'

      if (this.lastRerangeTimestamp) {
        const a = moment(this.lastRerangeTimestamp)
        const b = moment() // Now
        const timeToRerangingMillis = b.diff(a)
        timeInRange = moment.duration(timeToRerangingMillis, 'milliseconds')
        timeInRangeReadable = timeInRange.humanize()
      }

      this.lastRerangeTimestamp = moment().toISOString()

      if (notInitialRange) {
        console.log(`[${this.rangeWidthTicks}] Re-ranging ${direction} after ${timeInRangeReadable}`)
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
      if (this.position === undefined) {
        // Expected when in no-op mode.
        return
      }
  
      const MAX_UINT128 = 340282366920938463463374607431768211455n // 2^128 - 1
  
      const tokenIdHexString = ethers.utils.hexValue(this.position.tokenId)

      const collectParams = {
        tokenId: tokenIdHexString,
        recipient: wallet.address,
        amount0Max: MAX_UINT128, // Solidity type: uint128
        amount1Max: MAX_UINT128, // Solidity type: uint128
      }

      const callOverrides = {
        from: wallet.address
      }
  
      // Contract function: https://github.com/Uniswap/v3-periphery/blob/main/contracts/NonfungiblePositionManager.sol#L309
      // Function params: https://github.com/Uniswap/v3-periphery/blob/main/contracts/interfaces/INonfungiblePositionManager.sol#L160
      // collect() returns Promise<[BigNumber, BigNumber] & { amount0: BigNumber; amount1: BigNumber }
      // Uniswap interface invocation: https://github.com/Uniswap/interface/blob/main/src/hooks/useV3PositionFees.ts#L33
      const [amount0, amount1] = await positionManagerContract.callStatic.collect(collectParams,
        callOverrides)

      if (amount0 === undefined || amount1 === undefined) {
        console.log(`[${this.rangeWidthTicks}] checkUnclaimedFees(): One amount is undefined`)
        return
      }

      if (this.wethFirstInRangeOrderPool) {
        this.unclaimedFeesWeth = BigInt(amount0)
        this.unclaimedFeesUsdc = BigInt(amount1)
      }
      else {
        this.unclaimedFeesUsdc = BigInt(amount0)
        this.unclaimedFeesWeth = BigInt(amount1)
      }
    }

    logUnclaimedFees() {
      const n10ToThe6 = BigInt(1_000_000)
      const n10ToThe18 = BigInt(1_000_000_000_000_000_000)

      const usdValueOfUnclaimedWethFees = this.unclaimedFeesWeth * price() / n10ToThe18

      const unclaimedFeesTotalUsdc = this.unclaimedFeesUsdc + usdValueOfUnclaimedWethFees

      if (unclaimedFeesTotalUsdc == 0n) return

      const readable = Number(unclaimedFeesTotalUsdc * 100n / n10ToThe6) / 100

      console.log(`[${this.rangeWidthTicks}] Unclaimed fees: ${readable.toFixed(2)} USD`)

      metrics.unclaimedFeesInUsdc.set(readable)
    }

    // Note that we consciously do no error handing or retries here. These are now handled by the
    // process manager, a sibling Node.js module to this one.
    // Also note that Ethers.js will do its own exponential back-off but only if the provider does
    // NOT provide a retry-after header. Alchemy does provide this header. And yet we continue to
    // see HTTP errors, which means we must be maxing out on retries.
    // See:
    //   https://github.com/ethers-io/ethers.js/issues/1162#issuecomment-1057422329
    //   https://docs.alchemy.com/alchemy/documentation/rate-limits#option-2-retry-after
    async sendTx(logLinePrefix: string, txRequest: TransactionRequest): Promise<TransactionReceipt> {
      // Time our tx.
      const stopwatchStart = Date.now()

      try {
        const txResponse: TransactionResponse = await wallet.sendTransaction(txRequest)
        // console.log(`${logLinePrefix} TX hash: ${txResponse.hash}`) 
        // console.dir(txResponse)

        const txReceipt: TransactionReceipt = await txResponse.wait()
        // console.dir(txReceipt)

        const gasPriceReadable = txRequest.gasPrice === undefined ? 'unknown' :
          formatUnits(txRequest.gasPrice, 'gwei')

        const stopwatchMillis = (Date.now() - stopwatchStart)
        console.log(`${logLinePrefix} Transaction took ${Math.round(stopwatchMillis / 1_000)}s \
at gas price ${gasPriceReadable} gwei bid`)

        return txReceipt
      }
      catch (e: unknown) {
        // TODO: Log:
        // * HTTP status code and message
        // * Alchemy's status code (eg. -32000)
        // * Alchemy's message
        // * The retry-after header, although by the time Ethers.js throws an error, this may no
        //   longer be interesting.
        if (e instanceof Error) {
          console.error(`${logLinePrefix} Error message: ${e.message}`)
        }
        else {
          console.error(`${logLinePrefix} Error: ${e}`)
        }

        console.log(`Ending dro process.`)
        throw e
      }
    }
  
    async removeLiquidity() {
      if (this.position === undefined) {
        console.error(`[${this.rangeWidthTicks}] Can't remove liquidity. Not in a position yet.`)
        return
      }

      const deadline = moment().unix() + DEADLINE_SECONDS

      const calldata = removeCallParameters(this.position.position, this.position.tokenId,
        deadline, wallet.address)
  
      const nonce = await wallet.getTransactionCount("latest")
  
      const txRequest = {
        from: wallet.address,
        to: CHAIN_CONFIG.addrPositionManager,
        value: VALUE_ZERO_ETHER,
        nonce: nonce,
        gasLimit: CHAIN_CONFIG.gasLimit,
        gasPrice: this.gasPriceBid(),
        data: calldata
      }

      const end = metrics.removeLiquidityTxnTimeMs.startTimer()
      const txReceipt: TransactionReceipt = await this.sendTx(
        `[${this.rangeWidthTicks}] removeLiquidity()`, txRequest)
      end()

      const gasCost = this.gasCost(txReceipt)
      if (gasCost != undefined) {
        this.totalGasCost += gasCost
        metrics.removeLiquidityGasCost.set(gasCost)
      }

      // Removing liquidity is the last tx in the set of three. We're interested in the total gas
      // cost of the roundtrip position.
      console.log(`[${this.rangeWidthTicks}] removeLiquidity() Total gas cost: \
${this.totalGasCost.toFixed(2)}`)

      // Forget our old position details so that we can move on.
      this.position = undefined
      this.totalGasCost = 0

      // this.logGasUsed(`removeLiquidity()`, txReceipt)
    }

    async topUpEth() {
      if (this.position !== undefined)
         throw "Refusing to top up ETH. Still in a position. Remove liquidity first."

      const [ethBalance, wethBalance] = await Promise.all([
        wallet.eth(),
        wallet.weth()
      ])

      if (ethBalance >= CHAIN_CONFIG.ethBalanceMin) {
        return
      }

      const deficit = CHAIN_CONFIG.ethBalanceMin - ethBalance
      const enoughForThreeWorstCaseReRanges = CHAIN_CONFIG.ethBalanceMin * 3n

      // Typical tx cost: USD 10.00
      if (wethBalance > enoughForThreeWorstCaseReRanges) {
        console.log(`[${this.rangeWidthTicks}] topUpEth() Running low on ETH. Unwrapping enough \
WETH for three wost case re-ranges.`)

        await wallet.unwrapWeth(enoughForThreeWorstCaseReRanges)
      }
      else {
        console.log(`[${this.rangeWidthTicks}] topUpEth() Running low on ETH but also on WETH. \
Unwrapping just enough WETH for the next re-range.`)

        await wallet.unwrapWeth(deficit)
      }
    }

    // Use the liquidity maths in Uniswap's calculateRatioAmountIn() function in the
    // smart-order-router repo to swap an optimal amount of the input token.
    async swap() {
      if (this.position !== undefined)
         throw "Refusing to swap. Still in a position. Remove liquidity first."

      if (this.swapPool == undefined || this.rangeOrderPool == undefined)
          throw "Call refresh() first"

      // What are our balances and the ratio of our USDC balance to the USDC value of our WETH
      // balance?
      const [usdc, weth, ratio] = await wallet.tokenBalancesAndRatio()

      if (usdc == 0n && weth == 0n) {
        console.log(`This account has no USDC or WETH. Fatal. HFSP.`)
        process.exit(412)
      }

      // const [swapPool, wethFirstInSwapPool] = await useSwapPool()

      // console.log(`Token 0 symbol: ${token0.symbol}, token 1 symbol: ${token1.symbol}`)

      let inputToken: Token
      let outputToken: Token
      let inputTokenPrice: Fraction
      let inputBalance
      let outputBalance
      let swapRoute
      let zeroForOne: boolean

      if (ratio > 1.5) {
        // We're mostly in USDC now, so:
        //   The input token is USDC.
        //   The output token is WETH.
        //   We want the price of USDC in terms of WETH.
        inputToken = TOKEN_USDC
        outputToken = TOKEN_WETH

        // The order of the tokens here is significant. Input first.
        swapRoute = new Route([this.swapPool], TOKEN_USDC, TOKEN_WETH)

        if (this.wethFirstInSwapPool) {
          inputTokenPrice = this.swapPool.token1Price
          inputBalance = CurrencyAmount.fromRawAmount(this.swapPool.token1, usdc.toString())
          outputBalance = CurrencyAmount.fromRawAmount(this.swapPool.token0, weth.toString())
          zeroForOne = false // USDC for WETH, token one for token zero
        }
        else {
          inputTokenPrice = this.swapPool.token0Price
          inputBalance = CurrencyAmount.fromRawAmount(this.swapPool.token0, usdc.toString())
          outputBalance = CurrencyAmount.fromRawAmount(this.swapPool.token1, weth.toString())
          zeroForOne = true // USDC for WETH, token zero for token one
        }
      }
      else if (ratio > 0.5 && ratio <= 1.5) {
        // This should only be the case when restarting after an error that occured after the swap
        // but before adding liquidity again.
        console.log(`[${this.rangeWidthTicks}] swap() We already have\
 fairly even values of USDC and WETH. No need for a swap.`)

        return
      }
      else { // ratio <= 0.5
        // We're mostly in WETH now, so:
        //   The input token is WETH.
        //   The output token is USDC.
        //   We want the price of WETH in terms of USDC.
        inputToken = TOKEN_WETH
        outputToken = TOKEN_USDC

        // The order of the tokens here is significant. Input first.
        swapRoute = new Route([this.swapPool], TOKEN_WETH, TOKEN_USDC)

        if (this.wethFirstInSwapPool) {
          inputTokenPrice = this.swapPool.token0Price
          inputBalance = CurrencyAmount.fromRawAmount(this.swapPool.token0, weth.toString())
          outputBalance = CurrencyAmount.fromRawAmount(this.swapPool.token1, usdc.toString())
          zeroForOne = true // WETH for USDC, token zero for token one
        }
        else {
          inputTokenPrice = this.swapPool.token1Price
          inputBalance = CurrencyAmount.fromRawAmount(this.swapPool.token1, weth.toString())
          outputBalance = CurrencyAmount.fromRawAmount(this.swapPool.token0, usdc.toString())
          zeroForOne = false // WETH for USDC, token one for token zero
        }
      }

      // let rangeOrderPool

      // Performance optimisation. Some 'await's can be avoided when the range order pool is the
      // same as the swap pool.
      // if (rangeOrderPoolIsSwapPool()) {
      //   rangeOrderPool = swapPool
      // }
      // else {
      //   // Only interested in the first element from the tuple returned.
      //   rangeOrderPool = (await useRangeOrderPool())[0]
      // }

      // Because we're using this tick to get the optimal ratio of assets to put into the range
      // order position, use the range order pool here, not the swap pool.
      const p = new Position({
        pool: this.rangeOrderPool,
        tickLower: this.tickLower,
        tickUpper: this.tickUpper,
        liquidity: 1 // calculateOptimalRatio() doesn't use the liquidity on the position
      })

      const sqrtRatioX96 = TickMath.getSqrtRatioAtTick(rangeOrderPoolTick)

      // Call private method on AlphaRouter.
      const optimalRatio: Fraction = this.alphaRouter['calculateOptimalRatio'](p, sqrtRatioX96,
        zeroForOne)

      const amountToSwap = calculateRatioAmountIn(optimalRatio, inputTokenPrice, inputBalance,
        outputBalance)

      if (JSBI.lessThan(amountToSwap.quotient, JSBI.BigInt(0))) {
        // Tokens in wrong order?
        // Optimal ratio inverted?
        // zeroForOne wrong?
        throw `Amount to swap is negative. Fatal.`
      }

      // Note: Never pass an argument to toFixed() here. If it's less than the decimals on the
      // token, this will fail an invariant. If it's not provided, we just get the decimals on
      // the token, which is what we want anyway.
      console.log(`[${this.rangeWidthTicks}] swap() Optimal swap is from\
 ${amountToSwap.toFixed()} ${amountToSwap.currency.symbol}`)

      // Note: Although Trade.exactIn(swapRoute, amountToSwap) looks to be exactly what we want,
      // it's not fully implemented in the SDK. It always throws:
      //   Error: No tick data provider was given
      // Uniswap dev suggests using createUncheckedTrade() here:
      //   https://github.com/Uniswap/v3-sdk/issues/52#issuecomment-888549553

      const trade: Trade<Currency, Currency, TradeType> = await Trade.createUncheckedTrade({
        route: swapRoute,
        inputAmount: amountToSwap,
        outputAmount: CurrencyAmount.fromRawAmount(outputToken, 0), // Zero here means 'don't care'
        tradeType: TradeType.EXACT_INPUT,
      })

      const options: SwapOptions = {
        slippageTolerance: CHAIN_CONFIG.slippageTolerance,
        recipient: wallet.address,
        deadline: moment().unix() + DEADLINE_SECONDS
      }

      const { calldata, value } = SwapRouter.swapCallParameters(trade, options)

      const nonce = await wallet.getTransactionCount("latest")
  
      // Sending WETH, not ETH, so value is zero here. WETH amount is in the call data.
      const txRequest = {
        from: wallet.address,
        to: CHAIN_CONFIG.addrSwapRouter,
        value: VALUE_ZERO_ETHER,
        nonce: nonce,
        gasLimit: CHAIN_CONFIG.gasLimit,
        gasPrice: this.gasPriceBid(),
        data: calldata
      }

      const end = metrics.swapTxnTimeMs.startTimer()
      const txReceipt: TransactionReceipt = await this.sendTx(
        `[${this.rangeWidthTicks}] swap()`, txRequest)
      end()

      const gasCost = this.gasCost(txReceipt)
      if (gasCost != undefined) {
        this.totalGasCost += gasCost
        metrics.swapGasCost.set(gasCost)
      }
    }
  
    async addLiquidity() {
      if (this.position !== undefined)
        throw `[${this.rangeWidthTicks}] Can't add liquidity. Already in a position. Remove \
liquidity and swap first.`

      if (this.rangeOrderPool == undefined)
        throw `Call refresh() first`

      // What are our balances? We don't need the ratio here.
      const [usdcNative, wethNative, ratio] = await wallet.tokenBalancesAndRatio()
  
      // Go from native bigint to JSBI via string.
      const availableUsdc = JSBI.BigInt((usdcNative).toString())
      const availableWeth = JSBI.BigInt((wethNative).toString())

      const amount0 = this.wethFirstInRangeOrderPool ? availableWeth : availableUsdc
      const amount1 = this.wethFirstInRangeOrderPool ? availableUsdc : availableWeth

      // It's difficult to keep a range order pool liquid on testnet, even one we've created
      // ourselves.
      if (CHAIN_CONFIG.isTestnet) {
        // Rather than require tickLower and tickUpper to be valid, replace them with valid values on
        // testnets. These were observed on a manually created position, therefore they're valid.
        this.tickLower = 191580
        this.tickUpper = 195840
      }
  
      // Get ahead of the invariant test in v3-sdk's Position constructor:
      // invariant(tickLower >= TickMath.MIN_TICK && tickLower % pool.tickSpacing === 0, 'TICK_LOWER')
      if (this.tickLower < TickMath.MIN_TICK) {
        throw `[${this.rangeWidthTicks}] Lower tick of ${this.tickLower} is below TickMath.MIN_TICK \
(${TickMath.MIN_TICK}). Can't create position.`
      }

      if (this.tickLower % this.rangeOrderPool.tickSpacing !== 0) {
        throw `[${this.rangeWidthTicks}] Lower tick of ${this.tickLower} is not aligned with the tick \
spacing of ${this.rangeOrderPool.tickSpacing}. Can't create position.`
      }

      // We don't know L, the liquidity, but we do know how much WETH and how much USDC we'd like
      // to add, which is all of it. Position.fromAmounts() just calls maxLiquidityForAmounts() to
      // figure out the liquidity then uses that in the Position constructor.
      let position = Position.fromAmounts({
        pool: this.rangeOrderPool,
        tickLower: this.tickLower,
        tickUpper: this.tickUpper,
        amount0: amount0,
        amount1: amount1,
        useFullPrecision: false
      })

//       if (this.wethFirst) {
//         console.log(`[${this.rangeWidthTicks}] addLiquidity() Amounts available: ${availableUsdc} \
// USDC, ${availableWeth} WETH. Mint amounts: ${position.mintAmounts.amount1.toString()} USDC, \
// ${position.mintAmounts.amount0.toString()} WETH`)
//       }
//       else {
//         console.log(`[${this.rangeWidthTicks}] addLiquidity() Amounts available: ${availableUsdc} \
// USDC, ${availableWeth} WETH. Mint amounts: ${position.mintAmounts.amount0.toString()} USDC, \
// ${position.mintAmounts.amount1.toString()} WETH`)
//       }
  
      const mintOptions: MintOptions = {
        slippageTolerance: CHAIN_CONFIG.slippageTolerance,
        deadline: moment().unix() + DEADLINE_SECONDS,
        recipient: wallet.address,
        createPool: false
      }
  
      // addCallParameters() implementation:
      //   https://github.com/Uniswap/v3-sdk/blob/6c4242f51a51929b0cd4f4e786ba8a7c8fe68443/src/nonfungiblePositionManager.ts#L164
      // Expect this error here when on testnets. Just use Arbitrum and pay the tx costs.
      /*
      Error: Invariant failed: ZERO_LIQUIDITY
          at invariant (/home/e/r/dro/dro/node_modules/tiny-invariant/dist/tiny-invariant.cjs.js:13:11)
          at Function.addCallParameters (/home/e/r/dro/dro/node_modules/@uniswap/v3-sdk/src/nonfungiblePositionManager.ts:200:5)
          at DRO.<anonymous> (/home/e/r/dro/dro/src/dro.ts:456:62)
      */
      const {calldata, value} = NonfungiblePositionManager.addCallParameters(position, mintOptions)
  
      const nonce = await wallet.getTransactionCount("latest")
  
      // Sending WETH, not ETH, so value is zero here. WETH amount is in the call data.
      const txRequest = {
        from: wallet.address,
        to: CHAIN_CONFIG.addrPositionManager,
        value: VALUE_ZERO_ETHER,
        nonce: nonce,
        gasLimit: CHAIN_CONFIG.gasLimit,
        gasPrice: this.gasPriceBid(),
        data: calldata
      }

      const end = metrics.addLiquidityTxnTimeMs.startTimer()
      const txReceipt: TransactionReceipt = await this.sendTx(
        `[${this.rangeWidthTicks}] addLiquidity()`, txRequest)
      end()

      const t = extractTokenId(txReceipt)

      if (t === undefined) {
        console.error(`[${this.rangeWidthTicks}] addLiquidity() No token ID from logs. We won't \
be able to remove this liquidity.`)
      }
      else {
        this.position = new PositionWithTokenId(position, t)

        const webUrl = positionWebUrl(t)
        console.log(`[${this.rangeWidthTicks}] addLiquidity() Position URL: ${webUrl}`)
      }

      const gasCost = this.gasCost(txReceipt)
      if (gasCost != undefined) {
        this.totalGasCost += gasCost
        metrics.addLiquidityTxnGasCost.set(gasCost)
      }
    }

    gasCost(txReceipt: TransactionReceipt): number | undefined {
      // What did we just sepnd on gas? None of these are actually large integers.

      // Corresponds to "Gas Used by Transaction" on Etherscan
      const gasUsed = txReceipt.gasUsed.toBigInt()
      // console.log(`Gas used: ${gasUsed}`)

      // txReceipt.cumulativeGasUsed: No idea what this is. Ignore it.

      // effectiveGasPrice corresponds to "Gas Price Paid" on Etherscan. Quoted in wei, typically
      // about 0.66 gwei for Arbitrum.
      // effectiveGasPrice property is undefined on Optimism.
      if (txReceipt.effectiveGasPrice == undefined) return undefined

      const effectiveGasPrice = txReceipt.effectiveGasPrice.toBigInt()
      // console.log(`Effective gas price: ${effectiveGasPrice}`)

      const p: bigint = price()

      // USD cost of tx = gasUsed * effectiveGasPrice * price of Ether in USDC / 10^18 / 10^6
      const usdCostOfTx = gasUsed * effectiveGasPrice * p

      const f: number = Number(usdCostOfTx * 100n / 1_000_000_000_000_000_000_000_000n) / 100

      // console.log(`TX cost: USD ${f.toFixed(2)}`)

      return f
    }

    gasPriceBid(): bigint {
      if (gasPrice === undefined) {
        console.error(`No gas price yet. Don't know what to bid. Defaulting to a safe high bid.`)

        if (CHAIN_CONFIG.isL2) {
          // Optimism gas price dashboard:
          //   https://public-grafana.optimism.io/d/9hkhMxn7z/public-dashboard?orgId=1&refresh=5m
          // Gas price is pinned to 0.001 gwei as of 2022-04.
          return ethers.utils.parseUnits("0.001", "gwei").toBigInt()
        }
        else {
          return ethers.utils.parseUnits("80", "gwei").toBigInt()
        }
      }

      if (CHAIN_CONFIG.isL2) {
        // Arbitrum:
        //   95%: Remove/swap/add roundtrip took 14s. See if we can go slower.
        //   85%: testing now
        //   75%: 'gas price too low' error
        // return gasPrice * 85n / 100n
        
        // Optimism gas price dashboard:
        //   https://public-grafana.optimism.io/d/9hkhMxn7z/public-dashboard?orgId=1&refresh=5m
        // Gas price is pinned to 0.001 gwei as of 2022-04.
        return ethers.utils.parseUnits("0.001", "gwei").toBigInt()
      }

      // TODO: On L1 consider specifying the maxFeePerGas instead of the gasPrice.
      // See: https://docs.alchemy.com/alchemy/guides/eip-1559/send-tx-eip-1559
      // maxFeePerGas is often double the gasPrice:
      //   1. maxFeePerGas: 36.301396484 gwei, maxPriorityFeePerGas: 2.5 gwei, gasPrice: 17.987767833 gwei
      //   2. maxFeePerGas: 63.332724206 gwei, maxPriorityFeePerGas: 2.5 gwei, gasPrice: 31.416362103 gwei
      //   3. maxFeePerGas: 82.020751718 gwei, maxPriorityFeePerGas: 2.5 gwei, gasPrice: 40.760375859 gwei
      //   4. maxFeePerGas: 325.271465568 gwei, maxPriorityFeePerGas: 2.5 gwei, gasPrice: 162.483922785 gwei
      // Using maxFeePerGas is probably safer than using gasPrice.

      // Bid a little bit higher than the going rate.
      // 110%: > 60 mins for remove tx. Can easily priced out of the gas market on a big move (bad)
      // 130%: 1. Remove/swap/add roundtrip took 117s
      //          21.92 + 11.90 + 49.96 = 83.78 (good)
      //       2. Remove/swap/add roundtrip took 61s
      //          23.10 + 14.01 + 58.83 = 95.94 (good)
      //       3. Remove/swap/add roundtrip took 73s
      //          30.38 + 20.92 + 68.10 = 119.40 (ok)
      //       4. Remove/swap/add roundtrip took 52s
      //          121.00 + 92.00 + 341.61 = 554.61 (terrible)
      // 125%: testing now
      return gasPrice * 125n / 100n
    }

    async onPriceChanged() {
      if (this.locked) {
        // Stay quiet while we're busy re-ranging.
        return
      }

      await this.checkUnclaimedFees()
      this.logUnclaimedFees()
    }

    async onBlock() {
      // When in no-op mode, don't execute any transactions but do find new ranges when necessary.
      if (this.noops) {
        if (this.outOfRange()) {
          this.setNewRange()
        }

        return
      }

      // Are we now out of range (or are we not yet in a position)?
      if (this.outOfRange() || !this.inPosition()) {
        if (this.locked) {
          // console.log(`[${this.rangeWidthTicks}] Skipping block. Already busy re-ranging.`)
          return
        }

        if (gasPrice > CHAIN_CONFIG.gasPriceMax) {
          console.log(`Gas price of ${gasPriceFormatted()} is over our max of \
${CHAIN_CONFIG.gasPriceMaxFormatted()}. Not re-ranging yet.`)
          return
        }

        this.locked = true

        // TODO: Consider reloading the .env file here so that we can change the range without
        // restaritng the process, which loses us our tx costs so far. See:
        //   https://github.com/motdotla/dotenv/issues/122

        this.logRerangeEvent()

        await wallet.logBalances()

        // Check fees before removing liquidity.
        await this.checkUnclaimedFees()

        // Log the fees we're about to claim so that we can compare them to the total gas cost,
        // coming next.
        this.logUnclaimedFees()

        // Refresh our Position and Pool instances before we use them.
        await this.reinitMutables()

        // Time our remove/swap/add roundtrip.
        const stopwatchStart = Date.now()
        const endMetricsTimer = metrics.totoalRerangeTimeMs.startTimer()

        // Remove all of our liquidity now and close our position.
        await this.removeLiquidity()

        // Find our new range around the current price.
        this.setNewRange()

        // Swap the exact amount of one token that will give us the right balance of assets for the
        // new position.
        await this.swap()

        // Make sure we have enough ETH (not WETH) on hand to execute the next three transactions
        // (add, remove, swap). We could do tihs at two points in the cycle:
        // 1. After the swap. We're guaranteed to have a non zero amount of WETH, but this will
        //    move us slightly away from the optimal ratio of assets we just swapped to.
        // 2. After the remove, but only when we re-range down, such that we're all in WETH. This
        //    will let our swaps be closer to optimal, but we'll be doing it less often. There's a
        //    risk that if we happen to get five re-ranges up in a row, we'll run out of ETH.
        // Go with option 1 for now.
        await this.topUpEth()

        // Add all our WETH and USDC to a new liquidity position.
        await this.addLiquidity()

        // stop and register our time for the remove/swap/add roundtrip
        endMetricsTimer()
        metrics.reRangeTime.setToCurrentTime()

        const stopwatchMillis = (Date.now() - stopwatchStart)
        console.log(`[${this.rangeWidthTicks}] Remove/swap/add roundtrip took \
${Math.round(stopwatchMillis / 1_000)}s`)

        // We should now hold as close to zero USDC and WETH as possible.
        await wallet.logBalances()

        this.locked = false
      }
    }
  }
