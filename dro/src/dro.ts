import { config } from 'dotenv'
import { FeeAmount, MintOptions, nearestUsableTick, NonfungiblePositionManager, Pool, Position, Route, SwapOptions, SwapRouter, tickToPrice, Trade } from '@uniswap/v3-sdk'
import { CurrencyAmount, Percent, TradeType, Currency, Fraction } from '@uniswap/sdk-core'
import { TickMath } from '@uniswap/v3-sdk'
import { TransactionResponse, TransactionReceipt, TransactionRequest } from '@ethersproject/abstract-provider'
import moment, { Duration } from 'moment'
import { useConfig, ChainConfig } from './config'
import { wallet, gasPrice, gasPriceFormatted, jsbiFormatted } from './wallet'
import { insertRerangeEvent, insertOrReplacePosition, getTokenIdForOpenPosition, deletePosition } from './db'
import { rangeOrderPoolContract, swapPoolContract, quoterContract, positionManagerContract, usdcToken, wethToken, rangeOrderPoolTick, RANGE_ORDER_POOL_TICK_SPACING, extractTokenId, positionByTokenId, positionWebUrl, tokenOrderIsWethFirst, DEADLINE_SECONDS, VALUE_ZERO_ETHER, removeCallParameters, price, rangeAround } from './uniswap'
import { AlphaRouter, SwapToRatioResponse, SwapToRatioRoute, SwapToRatioStatus } from '@uniswap/smart-order-router'
import JSBI from 'jsbi'
import { ethers } from 'ethers'

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
    wethFirst: boolean = true
    position?: Position
    tokenId?: number
    unclaimedFeesUsdc: bigint = 0n
    unclaimedFeesWeth: bigint = 0n
    lastRerangeTimestamp?: string
    locked: boolean = false
    totalGasCost: number = 0
  
    constructor(
      _rangeWidthTicks: number,
      _noops: boolean) {
      this.rangeWidthTicks = _rangeWidthTicks
      this.noops = _noops
    }

    async init() {
      // The order of the tokens in the pool varies from chain to chain, annoyingly.
      // Ethereum mainnet: USDC is first
      // Arbitrum mainnet: WETH is first
      this.wethFirst = await tokenOrderIsWethFirst()

      // Get the token ID for our position from the database. This is a small positive integer.
      const tokenId = await getTokenIdForOpenPosition()

      if (tokenId === undefined) {
        console.log(`[${this.rangeWidthTicks}] No existing position NFT`)
      }
      else {
        this.tokenId = tokenId

        console.log(`[${this.rangeWidthTicks}] Token ID: ${this.tokenId}`)

        // Now get the position from Uniswap for the given token ID.
        const position: Position = await positionByTokenId(tokenId, this.wethFirst)

        // console.log(`Position:`)
        // console.dir(position)

        if (position) {
          this.position = position
          this.tickLower = position.tickLower
          this.tickUpper = position.tickUpper

          // Note that at this point, tickLower and tickUpper are based on the existing position
          // whereas rangeWidthTicks is from the .env file. The two may not agree!

          if (JSBI.EQ(JSBI.BigInt(0), this.position.liquidity)) {
            // Logging suggests that removeLiquidity() is executing completely and the position has
            // been deleted from the db, and yet we continue to see this happen.
            console.error(`[${this.rangeWidthTicks}] Existing position has no liquidity. Did we \
remove liquidity but retain our token ID? Deleting it now.`)

            deletePosition(this.rangeWidthTicks)
            this.tokenId = undefined
            this.position = undefined
            this.totalGasCost = 0
            
            return
          }

          // Note that we never get our min and max ticks from the Position instance. Leave them as
          // zero here, meaning outOfRange() will return true on the first call and setNewRange()
          // will set them based on the range width in the .env file.
          // This enables us to kill the process, change the range width in the .env file, restart
          // and get a re-range to happen based on the new range.
          // this.tickLower = position.tickLower
          // this.tickUpper = position.tickUpper
          console.log(`[${this.rangeWidthTicks}] Using existing position NFT: \
${positionWebUrl(this.tokenId)}`)

          console.log(`[${this.rangeWidthTicks}] Liquidity: \
${jsbiFormatted(this.position.liquidity)}`)

          this.logRangeInUsdcTerms()
        }
        else {
          console.error(`No position for token ID ${this.tokenId}`)
          process.exit(99)
        }
      }

      // No more forward testing for now.
      // forwardTestInit(this.rangeWidthTicks)
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
      let minUsdc
      let maxUsdc

      // tickToPrice() implementation:
      //   https://github.com/Uniswap/v3-sdk/blob/6c4242f51a51929b0cd4f4e786ba8a7c8fe68443/src/utils/priceTickConversions.ts#L14
      if (this.wethFirst) {
        // Arbitrum mainnet
        //   WETH is token 0, USDC is token 1
        //   Minimum USDC value per ETH corresponds to the minimum tick value
        minUsdc = tickToPrice(wethToken, usdcToken, this.tickLower).toFixed(2, {groupSeparator: ','})
        maxUsdc = tickToPrice(wethToken, usdcToken, this.tickUpper).toFixed(2, {groupSeparator: ','})
      }
      else {
        // Ethereum mainnet:
        //   USDC is token 0, WETH is token 1
        //   Minimum USDC value per ETH corresponds to the maximum tick value
        //   Counterintuitively, WETH is still the first token we pass to tickToPrice()
        minUsdc = tickToPrice(wethToken, usdcToken, this.tickUpper).toFixed(2, {groupSeparator: ','})
        maxUsdc = tickToPrice(wethToken, usdcToken, this.tickLower).toFixed(2, {groupSeparator: ','})
      }

      console.log(`[${this.rangeWidthTicks}] Range: ${minUsdc} <-> ${maxUsdc}`)
    }
  
    setNewRange() {
      if (rangeOrderPoolTick == undefined) throw 'No tick yet.'

      const [lower, upper] = rangeAround(rangeOrderPoolTick, this.rangeWidthTicks)
      this.tickLower = lower
      this.tickUpper = upper

      this.logRangeInUsdcTerms()
    }

    trackRerangeEvent() {
      const notInitialRange: boolean = (this.tickLower != 0)

      let direction: Direction
      
      if (this.wethFirst) {
        // Pool on Arbitrum mainnet: A lower tick value means a lower price in USDC.
        direction = rangeOrderPoolTick < this.tickLower ? Direction.Down : Direction.Up
      }
      else {
        // Pool on Ethereum mainnet: A lower tick value means a higher price in USDC.
        direction = rangeOrderPoolTick < this.tickLower ? Direction.Up : Direction.Down
      }

      let timeInRange: Duration
      let timeInRangeReadable: string = 'an unknown period'

      // No more forward testing for now.
      // let forwardTestLogLine: string = ''

      if (this.lastRerangeTimestamp) {
        const a = moment(this.lastRerangeTimestamp)
        const b = moment() // Now
        const timeToRerangingMillis = b.diff(a)
        timeInRange = moment.duration(timeToRerangingMillis, 'milliseconds')
        timeInRangeReadable = timeInRange.humanize()

        // Do some forward testing on how this range width is performing.
        // forwardTestLogLine = forwardTestRerange(this.rangeWidthTicks,
        //   timeInRange,
        //   direction)
      }

      this.lastRerangeTimestamp = moment().toISOString()

      if (notInitialRange) {
        // Insert a row in the database for analytics, except when we're just starting up and there's
        // no range yet.
        insertRerangeEvent(this.rangeWidthTicks, moment().toISOString(), direction)

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
      if (!this.position || !this.tokenId) {
        // This is expected when running in noop mode, or when running one width in prod but
        // forward testing a bunch of other range widths. No need to log it.
        // console.error(`[${this.rangeWidthTicks}] Can't check unclaimed fees. Not in a position yet.`)
        return
      }
  
      const MAX_UINT128 = 340282366920938463463374607431768211455n // 2^128 - 1
  
      const tokenIdHexString = ethers.utils.hexValue(this.tokenId)
  
      // Contract function: https://github.com/Uniswap/v3-periphery/blob/main/contracts/NonfungiblePositionManager.sol#L309
      // Function params: https://github.com/Uniswap/v3-periphery/blob/main/contracts/interfaces/INonfungiblePositionManager.sol#L160
      positionManagerContract.callStatic.collect({
        tokenId: tokenIdHexString,
        recipient: wallet.address,
        amount0Max: MAX_UINT128, // Solidity type: uint128
        amount1Max: MAX_UINT128, // Solidity type: uint128
      },
      { from: wallet.address })
      .then((results) => {
        if (results.amount0 === undefined || results.amount1 === undefined) {
          console.log(`[${this.rangeWidthTicks}] One amount is undefined`)
          return
        }

        if (this.wethFirst) {
          this.unclaimedFeesWeth = BigInt(results.amount0)
          this.unclaimedFeesUsdc = BigInt(results.amount1)
        }
        else {
          this.unclaimedFeesUsdc = BigInt(results.amount0)
          this.unclaimedFeesWeth = BigInt(results.amount1)
        }
      })
    }

    logUnclaimedFees() {
      const n10ToThe6 = BigInt(1_000_000)
      const n10ToThe18 = BigInt(1_000_000_000_000_000_000)

      const usdValueOfUnclaimedWethFees = this.unclaimedFeesWeth * price() / n10ToThe18

      const unclaimedFeesTotalUsdc = this.unclaimedFeesUsdc + usdValueOfUnclaimedWethFees

      if (unclaimedFeesTotalUsdc == 0n) return

      const readable = Number(unclaimedFeesTotalUsdc * 100n / n10ToThe6) / 100

      console.log(`[${this.rangeWidthTicks}] Unclaimed fees: ${readable.toFixed(2)} USD`)
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
      try {
        const txResponse: TransactionResponse = await wallet.sendTransaction(txRequest)
        // console.log(`${logLinePrefix} TX hash: ${txResponse.hash}`) 
        // console.dir(txResponse)

        const txReceipt: TransactionReceipt = await txResponse.wait()
        // console.dir(txReceipt)

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
      if (!this.position || !this.tokenId) {
        console.error(`[${this.rangeWidthTicks}] Can't remove liquidity. Not in a position yet.`)
        return
      }

      // Take note of how the liquidity in the position has changed since we opened the position
      // (or restarted the dro process). Calling decreaseLiquidity() with a liquidity parameter
      // that is not equal to the liquidity currently in the position can cause the TX to fail.
      const liquidityBefore = this.position.liquidity

      this.position = await positionByTokenId(this.tokenId, this.wethFirst)

      const liquidityAfter = this.position.liquidity

      console.log(`[${this.rangeWidthTicks}] removeLiquidity() Liquidity was \
${jsbiFormatted(liquidityBefore)} at opening of position/restarting and is now \
${jsbiFormatted(liquidityAfter)}`)

      const deadline = moment().unix() + DEADLINE_SECONDS

      const calldata = removeCallParameters(this.position, this.tokenId, deadline, wallet.address)
  
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

      const txReceipt: TransactionReceipt = await this.sendTx(
        `[${this.rangeWidthTicks}] removeLiquidity()`, txRequest)

      // Delete our position from the database as soon after this transaction as possible.
      deletePosition(this.rangeWidthTicks)

      const gasCost = this.gasCost(txReceipt)

      // Removing liquidity is the last tx in the set of three. We're interested in the total gas
      // cost of the roundtrip position.
      this.totalGasCost += gasCost
      console.log(`[${this.rangeWidthTicks}] removeLiquidity() Total gas cost: \
${this.totalGasCost.toFixed(2)}`)

      // Forget our old token ID and position details so that we can move on.
      this.tokenId = undefined
      this.position = undefined
      this.totalGasCost = 0

      // this.logGasUsed(`removeLiquidity()`, txReceipt)
    }

    async topUpEth() {
      if (this.position || this.tokenId)
         throw "Refusing to top up ETH. Still in a position. Remove liquidity first."

      const ethBalance = await wallet.eth()

      if (ethBalance >= CHAIN_CONFIG.ethBalanceMin) {
        return
      }

      const deficit = CHAIN_CONFIG.ethBalanceMin - ethBalance

      console.log(`Running low on ETH. Unwrapping some WETH to top up.`)

      await wallet.unwrapWeth(deficit)
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

      if (usdc == 0n && weth == 0n) {
        console.log(`This account has no USDC or WETH. Fatal. HFSP.`)
        process.exit(420)
      }

      // What is the ratio of our USDC balance to the USDC value of our WETH balance?
      const ratio = await wallet.tokenRatioByValue()

      let tokenIn
      let tokenOut
      let amountIn
      let swapRoute

      // We should be almost entirely in one asset or the other, because we only removed liquidity
      // once we were at the edge of our range. We do have some fees just claimed in the other
      // asset, however.
      if (ratio > 1.5) {
        console.log(`[${this.rangeWidthTicks}] swap() We're mostly in USDC now. Swapping half our \
USDC to WETH.`)

        tokenIn = CHAIN_CONFIG.addrTokenUsdc
        tokenOut = CHAIN_CONFIG.addrTokenWeth
        amountIn = usdc / 2n

        // The order of the tokens here is significant. Input first.
        swapRoute = new Route([poolEthUsdcForSwaps], usdcToken, wethToken)
      }
      else if (ratio > 0.5 && ratio <= 1.5) {
        console.log(`[${this.rangeWidthTicks}] swap() We already have fairly even values of USDC \
and WETH. No need for a swap.`)

        return
      }
      else { // ratio <= 0.5
        console.log(`[${this.rangeWidthTicks}] swap() We're mostly in WETH now. Swapping half our \
WETH to USDC.`)

        tokenIn = CHAIN_CONFIG.addrTokenWeth
        tokenOut = CHAIN_CONFIG.addrTokenUsdc
        amountIn = weth / 2n

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

      if (ratio > 1.5) {
        // Swapping USDC to WETH
        trade = await Trade.createUncheckedTrade({
          route: swapRoute,
          inputAmount: CurrencyAmount.fromRawAmount(usdcToken, (usdc / 2n).toString()),
          outputAmount: CurrencyAmount.fromRawAmount(wethToken, quotedAmountOut.toString()),
          tradeType: TradeType.EXACT_INPUT,
        })
      }
      else { // ratio <= 0.5
        // Swapping WETH to USDC
        trade = await Trade.createUncheckedTrade({
          route: swapRoute,
          inputAmount: CurrencyAmount.fromRawAmount(wethToken, (weth / 2n).toString()),
          outputAmount: CurrencyAmount.fromRawAmount(usdcToken, quotedAmountOut.toString()),
          tradeType: TradeType.EXACT_INPUT,
        })
      }

      // console.log(`[${this.rangeWidthTicks}] Trade: ${JSON.stringify(trade)}`)

      const options: SwapOptions = {
        slippageTolerance: CHAIN_CONFIG.slippageTolerance,
        recipient: wallet.address,
        deadline: moment().unix() + DEADLINE_SECONDS
      }

      const { calldata, value } = SwapRouter.swapCallParameters(trade, options)
      // console.log(`[${this.rangeWidthTicks}] calldata: `, calldata)

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

      const txReceipt: TransactionReceipt = await this.sendTx(
        `[${this.rangeWidthTicks}] swap()`, txRequest)

      const gasCost = this.gasCost(txReceipt)
      this.totalGasCost += gasCost
    }
  
    async addLiquidity() {
      if (this.position || this.tokenId)
        throw `[${this.rangeWidthTicks}] Can't add liquidity. Already in a position. Remove \
liquidity and swap first.`
  
      // Go from native bigint to JSBI via string.
      const availableUsdc = JSBI.BigInt((await wallet.usdc()).toString())
      const availableWeth = JSBI.BigInt((await wallet.weth()).toString())
      console.log(`[${this.rangeWidthTicks}] addLiquidity() Amounts available: \
${availableUsdc} USDC, ${availableWeth} WETH`)

      const slot = await rangeOrderPoolContract.slot0()

      // The fee in the pool determines the tick spacing and if it's zero, the tick spacing will be
      // undefined. This will throw an error when the position gets created.
      // invariant(slot[5] > 0, 'Pool has no fee')
      const fee = slot[5] > 0 ? slot[5] : FeeAmount.MEDIUM

      // Do NOT pass a string for the sqrtRatioX96 parameter below! JSBI does very little type checking.
      const sqrtRatioX96AsJsbi = JSBI.BigInt(slot[0].toString())

      const liquidity = await rangeOrderPoolContract.liquidity()
      const liquidityAsJsbi = JSBI.BigInt(liquidity.toString())

      const tick = slot[1]

      // The order of the tokens in the pool varies from chain to chain, annoyingly.
      // Ethereum mainnet: USDC is first
      // Arbitrum mainnet: WETH is first
      let token0
      let token1

      let amount0
      let amount1

      if (this.wethFirst) {
        token0 = wethToken
        token1 = usdcToken

        amount0 = availableWeth
        amount1 = availableUsdc
      }
      else {
        token0 = usdcToken
        token1 = wethToken

        amount0 = availableUsdc
        amount1 = availableWeth
      }

      // A position instance requires a Pool instance.
      let rangeOrderPool = new Pool(
        token0,
        token1,
        fee, // Fee: 0.30%
        sqrtRatioX96AsJsbi, // SqrtRatioX96 of type BigIntish which includes JSBI
        liquidityAsJsbi, // Liquidity of type BigIntish which includes JSBI
        slot[1], // Tick
        // ticks
      )

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

      if (this.tickLower % rangeOrderPool.tickSpacing !== 0) {
        throw `[${this.rangeWidthTicks}] Lower tick of ${this.tickLower} is not aligned with the tick \
spacing of ${rangeOrderPool.tickSpacing}. Can't create position.`
      }

      // We don't know L, the liquidity, but we do know how much WETH and how much USDC we'd like
      // to add, which is all of it. Position.fromAmounts() just calls maxLiquidityForAmounts() to
      // figure out the liquidity then uses that in the Position constructor.
      let position = Position.fromAmounts({
        pool: rangeOrderPool,
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
        gasPrice: CHAIN_CONFIG.gasPrice,
        data: calldata
      }

      const txReceipt: TransactionReceipt = await this.sendTx(
        `[${this.rangeWidthTicks}] addLiquidity()`, txRequest)

      this.tokenId = extractTokenId(txReceipt)
      this.position = position

      if (this.tokenId) {
        const webUrl = positionWebUrl(this.tokenId)
        console.log(`[${this.rangeWidthTicks}] addLiquidity() Position URL: ${webUrl}`)

        insertOrReplacePosition(this.rangeWidthTicks, moment().toISOString(), this.tokenId)
      }
      else {
        console.error(`[${this.rangeWidthTicks}] addLiquidity() No token ID from logs. We won't \
be able to remove this liquidity.`)
      }

      const gasCost = this.gasCost(txReceipt)
      this.totalGasCost += gasCost

      console.log(`[${this.rangeWidthTicks}] addLiquidity() Starting liquidity: \
${jsbiFormatted(this.position.liquidity)}`)
    }

    async swapAndAddLiquidity() {
      if (this.position || this.tokenId)
         throw `[${this.rangeWidthTicks}] Refusing to swap and add liquidity. Still in a \
position. Remove liquidity first.`

      // The order of the tokens in the pool varies from chain to chain, annoyingly.
      // Ethereum mainnet: USDC is first
      // Arbitrum mainnet: WETH is first
      let token0
      let token1

      let token0Balance
      let token1Balance

      // Go from native bigint to JSBI via string.
      const availableUsdc = JSBI.BigInt((await wallet.usdc()).toString())
      const availableWeth = JSBI.BigInt((await wallet.weth()).toString())
      console.log(`swapAndAddLiquidity() Amounts available: ${availableUsdc} USDC, \
${availableWeth} WETH`)

      if (this.wethFirst) {
        token0 = wethToken
        token1 = usdcToken

        token0Balance = CurrencyAmount.fromRawAmount(wethToken, availableWeth)
        token1Balance = CurrencyAmount.fromRawAmount(usdcToken, availableUsdc)
      }
      else {
        token0 = usdcToken
        token1 = wethToken

        token0Balance = CurrencyAmount.fromRawAmount(usdcToken, availableUsdc)
        token1Balance = CurrencyAmount.fromRawAmount(wethToken, availableWeth)
      }

      console.log(`[dro.ts] Token 0 balance: ${token0Balance.toFixed(4)}, \
token 1 balance: ${token1Balance.toFixed(4)}`)

      console.log(`[dro.ts] output balance quotient: ${token1Balance.quotient}`)

      const slot = await rangeOrderPoolContract.slot0()

      // The fee in the pool determines the tick spacing and if it's zero, the tick spacing will be
      // undefined. This will throw an error when the position gets created.
      // invariant(slot[5] > 0, 'Pool has no fee')
      const fee = slot[5] > 0 ? slot[5] : FeeAmount.MEDIUM

      const sqrtRatioX96 = slot[0]

      console.log(`[dro.ts] sqrtRatioX96.toString(): ${sqrtRatioX96.toString()}`)
      console.log(`[dro.ts] sqrtRatioX96 instanceof JSBI: ${sqrtRatioX96 instanceof JSBI}`)
      console.log(`[dro.ts] typeof sqrtRatioX96 ${typeof(sqrtRatioX96)}`)

      // Do NOT pass a string for the sqrtRatioX96 parameter below! JSBI does very little type
      // checking.
      const sqrtRatioX96AsJsbi = JSBI.BigInt(slot[0].toString())

      console.log(`[dro.ts] sqrtRatioX96AsJsbi.toString(): ${sqrtRatioX96AsJsbi.toString()}`)
      console.log(`[dro.ts] sqrtRatioX96AsJsbi instanceof JSBI: \
${sqrtRatioX96AsJsbi instanceof JSBI}`)
      console.log(`[dro.ts] typeof sqrtRatioX96AsJsbi ${typeof(sqrtRatioX96AsJsbi)}`)

      const liquidity = await rangeOrderPoolContract.liquidity()

      // A position instance requires a Pool instance.
      const rangeOrderPool = new Pool(
        token0,
        token1,
        fee, // Fee: 0.30%
        sqrtRatioX96AsJsbi, // SqrtRatioX96 of type BigIntish which includes JSBI
        liquidity.toString(), // Liquidity
        slot[1], // Tick
        // ticks
      )

      // It's difficult to keep a range order pool liquid on testnet, even one we've created
      // ourselves.
      if (CHAIN_CONFIG.isTestnet) {
        // Rather than require tickLower and tickUpper to be valid, replace them with valid values on
        // testnets. These were observed on a manually created position, therefore they're valid.
        this.tickLower = 191580
        this.tickUpper = 195840
      }

      // From the SDK docs: "The position liquidity can be set to 1, since liquidity is still
      // unknown and will be set inside the call to routeToRatio()."

      /*
      Position from smart-order-router's node_modules/.../v3-sdk is not compatible with node_modules/.../v3-sdk.
      Does smart-order-router depend on the right version of v3-sdk?
      v3-sdk version (from Github latest at time of pulling): 3.8.2
      smart-order-router's dependency: "@uniswap/v3-sdk": "^3.7.0"

      sdk-core uses "jsbi": "^3.1.4",
      smart-order-router uses JSBI: "3.2.4" indirectly
      */
      const p = new Position({
        pool: rangeOrderPool,
        tickLower: this.tickLower,
        tickUpper: this.tickUpper,
        liquidity: 1
      })

      const deadlineValue = moment().unix() + 1800

      console.log(`[dro.ts] deadline: ${deadlineValue}`)

      const router = new AlphaRouter({chainId: CHAIN_CONFIG.chainId,
        provider: CHAIN_CONFIG.provider()})

      console.log(`[dro.ts] Poistion tickLower: ${p.tickLower}`)
      console.log(`[dro.ts] Poistion tickUpper: ${p.tickUpper}`)

      const ZERO = JSBI.BigInt(0) // Same as v3-sdk/src/internalConstants.ts
      const slippageTolerance = new Percent(5, 100)
      console.log(`[dro.ts] slippageTolerance.lessThan(ZERO): ${slippageTolerance.lessThan(ZERO)}`)

      // From sdk-core:
      if (slippageTolerance instanceof JSBI || typeof slippageTolerance === 'number'
        || typeof slippageTolerance === 'string')
        console.log(`[dro.ts] sdk-core will use new Fraction for tryParseFraction()`)
      else if ('numerator' in slippageTolerance && 'denominator' in slippageTolerance)
        console.log(`[dro.ts] sdk-core will use argument as return value`)
      else console.log(`[dro.ts] sdk-core will throw 'Could not parse fraction'`)

      console.log(`[dro.ts] Calling routeToRatio()`)

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
          maxIterations: 2,
        },
        // swapAndAddOptions
        {
           swapOptions: {
             recipient: wallet.address,
             slippageTolerance: slippageTolerance,
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

        console.log(`[dro.ts] route:`)
        console.dir(route)

        console.log(`[dro.ts] methodParameters:`)
        console.dir(route.methodParameters)

        if (route.methodParameters === undefined) throw `No method parameters`

        console.log(`[dro.ts] number of swaps:`)
        console.dir(route.trade.swaps.length)

        console.log(`[dro.ts] first trade swap:`)
        console.dir(route.trade.swaps[0])

        console.log(`[dro.ts] number of routes:`)
        console.dir(route.trade.routes.length)

        console.log(`[dro.ts] first trade route:`)
        console.dir(route.trade.routes[0])

        console.log(`[dro.ts] trade input amount: ${route.trade.inputAmount.toFixed(2)} \
${route.trade.inputAmount.currency.symbol}, output amount: ${route.trade.outputAmount.toFixed(2)} \
${route.trade.outputAmount.currency.symbol}`)

        console.log(`[dro.ts] optimalRatio: ${route.optimalRatio.toFixed(4)}`)

        // console.log(`Gas price from route: ${route.gasPriceWei} wei`)
        // console.log(`Gas price from config: ${CHAIN_CONFIG.gasPrice.toString()}`)

        // calldata is generated by the router-sdk module, here:
        // https://github.com/Uniswap/router-sdk/blob/7d989fbe285abf32a63c602221cd136651e39103/src/swapRouter.ts#L376

        const nonce = await wallet.getTransactionCount("latest")

        // Value is probably zero anyway, if we deal in WETH.
        const value = BigInt(route.methodParameters.value)
        console.log(`swapAndAddLiquidity() value: ${value}`)

        // Not providing the gasLimit will throw UNPREDICTABLE_GAS_LIMIT.
        // Using gasLimit of 1_000_000 will throw "not enough funds for gas", even with 0.04 ETH in the account.
        // Same for 500_000.
        // Same for 100_000.
        const txRequest = {
          from: wallet.address,
          to: CHAIN_CONFIG.addrSwapRouter2,
          value: value,
          nonce: nonce,
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
        // const txResponse: TransactionResponse = await wallet.sendTransaction(txRequest)
        // console.log(`swapAndAddLiquidity() TX hash: ${txResponse.hash}`)
        // console.log(`swapAndAddLiquidity() TX response:`)
        // console.dir(txResponse)

        // const txReceipt: TransactionReceipt = await txResponse.wait()
        // console.log(`swapAndAddLiquidity() TX receipt:`)
        // console.dir(txReceipt)

        const txReceipt: TransactionReceipt = await this.sendTx(`addLiquidity()`, txRequest)

        // The token ID is a small positive integer.
        this.tokenId = extractTokenId(txReceipt)
        this.position = p

        if (this.tokenId) {
          const webUrl = positionWebUrl(this.tokenId)
          console.log(`swapAndAddLiquidity() Position URL: ${webUrl}`)

          insertOrReplacePosition(this.rangeWidthTicks, moment().toISOString(), this.tokenId)
        }
        else {
          throw `[${this.rangeWidthTicks}] swapAndAddLiquidity() No token ID from logs. We won't \
be able to remove this liquidity.`
        }

        const gasCost = this.gasCost(txReceipt)
        this.totalGasCost += gasCost
      }
      else {
        console.log(`[dro.ts] routeToRatioResponse:`)
        console.dir(routeToRatioResponse)

        // const responseAsFail: SwapToRatioFail = routeToRatioResponse
        // throw `Swap to ratio failed. Status: ${SwapToRatioStatus[routeToRatioResponse.status]}, error: ${responseAsFail.error}`
        throw `Swap to ratio failed. Status: ${SwapToRatioStatus[routeToRatioResponse.status]}`
      }
    }

    gasCost(txReceipt: TransactionReceipt): number {
      // What did we just sepnd on gas? None of these are actually large integers.

      // Corresponds to "Gas Used by Transaction" on Etherscan
      const gasUsed = txReceipt.gasUsed.toBigInt()
      // console.log(`Gas used: ${gasUsed}`)

      // txReceipt.cumulativeGasUsed: No idea what this is. Ignore it.

      // Corresponds to "Gas Price Paid" on Etherscan. Quoted in wei, typically about 0.66 gwei for Arbitrum.
      const effectiveGasPrice = txReceipt.effectiveGasPrice.toBigInt()
      // console.log(`Effective gas price: ${effectiveGasPrice}`)

      const p: bigint = price()

      // USD cost of tx = gasUsed * effectiveGasPrice * price of Ether in USDC / 10^18 / 10^6
      const usdCostOfTx = gasUsed * effectiveGasPrice * p

      const f: number = Number(usdCostOfTx * 100n / 1_000_000_000_000_000_000_000_000n) / 100

      // console.log(`TX cost: USD ${f.toFixed(2)}`)

      return f
    }

    async onPriceChanged() {
      await this.checkUnclaimedFees()
      this.logUnclaimedFees()
    }

    async onBlock() {
      // When in no-op mode, don't execute any transactions but do find new ranges when necessary.
      if (this.noops) {
        if (this.outOfRange()) {
          if (gasPrice > CHAIN_CONFIG.gasPriceMax) {
            return
          }
          
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

        await wallet.logBalances()

        // Check fees before removing liquidity.
        await this.checkUnclaimedFees()

        // Log the fees we're about to claim so that we can compare them to the total gas cost,
        // coming next.
        this.logUnclaimedFees()

        // Remove all of our liquidity now and close our position.
        await this.removeLiquidity()

        await wallet.logBalances()

        // Find our new range around the current price.
        this.setNewRange()

        // Put a row in our analytics table and log the re-ranging.
        this.trackRerangeEvent()

        // Swap half our one asset to the other asset so that we have equal value of assets.
        await this.swap()

        // Make sure we have enough ETH (not WETH) on hand to execute the next three transactions
        // (add, remove, swap). This is the only point in the cycle where we're guaranteed to have
        // a non zero amount of WETH. Unwrap some to ETH now if we need to.
        await this.topUpEth()

        // Add all our WETH and USDC to a new liquidity position.
        await this.addLiquidity()

        // Deposit assets and let the protocol swap the optimal size for the liquidity position,
        // then enter the liquidity position all in one transaction.
        // Uniswap repo smart-order-router is not ready for production use. Wait for these
        // blocking bugs to get a response before using it:
        //   https://github.com/Uniswap/smart-order-router/issues/64
        //   https://github.com/Uniswap/smart-order-router/issues/65
        // await this.swapAndAddLiquidity()

        // We should now hold as close to zero USDC and WETH as possible.
        await wallet.logBalances()

        this.locked = false
      }
    }
  }
