import { config } from 'dotenv'
import { BigNumber } from '@ethersproject/bignumber'
import { CollectOptions, FeeAmount, maxLiquidityForAmounts, MintOptions, nearestUsableTick, NonfungiblePositionManager, Pool, Position, RemoveLiquidityOptions, Route, SqrtPriceMath, SwapOptions, SwapRouter, Tick, tickToPrice, Trade } from '@uniswap/v3-sdk'
import { CurrencyAmount, Percent, BigintIsh, TradeType, Currency, Fraction } from '@uniswap/sdk-core'
import { TickMath } from '@uniswap/v3-sdk'
import { TransactionResponse, TransactionReceipt } from '@ethersproject/abstract-provider'
import moment, { Duration } from 'moment'
import { useConfig, ChainConfig } from './config'
import { wallet, gasPrice, readableJsbi } from './wallet'
import { insertRerangeEvent, insertOrReplacePosition, getTokenIdForOpenPosition, deletePosition } from './db'
import { rangeOrderPoolContract, swapPoolContract, quoterContract, positionManagerContract, usdcToken, wethToken, rangeOrderPoolTick, rangeOrderPoolPriceUsdc, rangeOrderPoolPriceUsdcAsBigNumber, rangeOrderPoolTickSpacing, extractTokenId, positionByTokenId, positionWebUrl, tokenOrderIsWethFirst, DEADLINE_SECONDS, VALUE_ZERO_ETHER } from './uniswap'
import { AlphaRouter, SwapToRatioResponse, SwapToRatioRoute, SwapToRatioStatus } from '@uniswap/smart-order-router'
import { forwardTestInit, forwardTestRerange } from './forward-test'
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
    readonly removeOnly: boolean

    minTick: number = 0
    maxTick: number = 0
    entryTick: number = 0
    wethFirst: boolean = true
    position?: Position
    tokenId?: number
    unclaimedFeesUsdc?: BigintIsh
    unclaimedFeesWeth?: BigintIsh
    lastRerangeTimestamp?: string
    locked: boolean = false
  
    constructor(
      _rangeWidthTicks: number,
      _noops: boolean,
      _removeOnly: boolean) {
      this.rangeWidthTicks = _rangeWidthTicks
      this.noops = _noops
      this.removeOnly = _removeOnly
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

          // Note that we never get our min and max ticks from the Position instance. Leave them as
          // zero here, meaning outOfRange() will return true on the first call and updateRange()
          // will set them based on the range width in the .env file.
          // This enables us to kill the process, change the range width in the .env file, restart
          // and get a re-range to happen based on the new range.
          // this.minTick = position.tickLower
          // this.maxTick = position.tickUpper
          console.log(`[${this.rangeWidthTicks}] Using existing position NFT`)
        }
        else {
          throw `No position for token ID ${this.tokenId}`
        }
      }

      // No more forward testing for now.
      // forwardTestInit(this.rangeWidthTicks)
    }
  
    outOfRange() {
      // When newly constructed, this.minTick == this.maxTick == 0 and we return true here.
        return rangeOrderPoolTick &&
          (rangeOrderPoolTick < this.minTick || rangeOrderPoolTick > this.maxTick)
    }
  
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

      // Note that if rangeWidthTicks is not a multiple of the tick spacing for the pool, the range
      // returned here can be quite different to rangeWidthTicks.
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

      // if (forwardTestLogLine.length > 0) {
      //   console.log(forwardTestLogLine)
      // }
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
  
      const MAX_UINT128 = BigNumber.from(2).pow(128).sub(1)
  
      const tokenIdHexString = ethers.utils.hexValue(this.tokenId)
  
      // Contract function: https://github.com/Uniswap/v3-periphery/blob/main/contracts/NonfungiblePositionManager.sol#L309
      // Function params: https://github.com/Uniswap/v3-periphery/blob/main/contracts/interfaces/INonfungiblePositionManager.sol#L160
      positionManagerContract.callStatic.collect({
        tokenId: tokenIdHexString,
        recipient: wallet.address,
        amount0Max: MAX_UINT128,
        amount1Max: MAX_UINT128,
      },
      { from: wallet.address })
      .then((results) => {
        if (results.amount0 === undefined || results.amount1 === undefined) {
          console.log(`[${this.rangeWidthTicks}] One amount is undefined`)
          return
        }

        if (this.wethFirst) {
          this.unclaimedFeesWeth = JSBI.BigInt(results.amount0)
          this.unclaimedFeesUsdc = JSBI.BigInt(results.amount1)
        }
        else {
          this.unclaimedFeesUsdc = JSBI.BigInt(results.amount0)
          this.unclaimedFeesWeth = JSBI.BigInt(results.amount1)
        }

        console.log(`[${this.rangeWidthTicks}] Unclaimed fees: \
${readableJsbi(this.unclaimedFeesUsdc, 6, 4)} USDC, ${readableJsbi(this.unclaimedFeesWeth, 18, 6)} WETH`)
      })
    }
  
    async removeLiquidity() {
      if (!this.position || !this.tokenId) {
        console.error("Can't remove liquidity. Not in a position yet.")
        return
      }

      // TODO: Remove when run once:
      // await deletePosition(this.rangeWidthTicks)
      // if (this.tokenId !== undefined) throw `done`
  
      // If we're only ever collecting fees in WETH and USDC, then the expectedCurrencyOwed0 and
      // expectedCurrencyOwed1 can be zero (CurrencyAmount.fromRawAmount(usdcToken, 0). But if we
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
        liquidityPercentage: new Percent(1), // All of our liquidity
        slippageTolerance: CHAIN_CONFIG.slippageTolerance,
        deadline: moment().unix() + DEADLINE_SECONDS,
        collectOptions: collectOptions
      }
  
      /*
      Width, Token ID
      120, 35416, https://app.uniswap.org/#/pool/35416?chain=arbitrum, CLOSED
      360, 35395, https://app.uniswap.org/#/pool/35395?chain=arbitrum, IN RANGE
      */
      // This will throw an error 'ZERO_LIQUIDITY' on an invariant if the position is already closed.
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
      console.log(`removeLiquidity() TX hash: ${txResponse.hash}`)
      // console.log(`removeLiquidity() TX response:`)
      // console.dir(txResponse)

      const txReceipt: TransactionReceipt = await txResponse.wait()
      // console.log(`removeLiquidity() TX receipt:`)
      // console.dir(txReceipt)

      // Forget our old token ID and position details so that we can move on.
      this.tokenId = undefined
      this.position = undefined
      deletePosition(this.rangeWidthTicks)

      this.logGasUsed(`removeLiquidity()`, txReceipt)
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

      // // TODO: Zero is no use to us here. Fake it on testnets, or fix the pool we're in.
      // console.log(`Range order pool price: ${rangeOrderPoolPriceUsdc} USDC`)

      // // This is USDC * 10^-6 as an integer (BigNumber).
      // const u = rangeOrderPoolPriceUsdcAsBigNumber()

      // let usdcValueOfWethBalance = BigNumber.from(u).mul(weth)

      // // Avoid a division by zero error below. Any very small integer will do here.
      // if (usdcValueOfWethBalance.eq(BigNumber.from(0))) {
      //   usdcValueOfWethBalance = BigNumber.from(1)
      // }

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
        console.log(`[${this.rangeWidthTicks}] swap() We have USDC and WETH in the ratio: ${ratio}. We're mostly in USDC now. Swapping half our USDC to WETH.`)

        tokenIn = CHAIN_CONFIG.addrTokenUsdc
        tokenOut = CHAIN_CONFIG.addrTokenWeth
        amountIn = usdc.div(2)

        // The order of the tokens here is significant. Input first.
        swapRoute = new Route([poolEthUsdcForSwaps], usdcToken, wethToken)
      }
      else if (ratio > 0.5 && ratio <= 1.5) {
        console.log(`[${this.rangeWidthTicks}] swap() We have USDC and WETH in the ratio: ${ratio}. We already have fairly even values of USDC and WETH.\
 No need for a swap.`)

        return
      }
      else { // ratio <= 0.5
        console.log(`[${this.rangeWidthTicks}] swap() We have USDC and WETH in the ratio: ${ratio}. We're mostly in WETH now. Swapping half our WETH to USDC.`)

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

      if (ratio > 1.5) {
        // Swapping USDC to WETH
        trade = await Trade.createUncheckedTrade({
          route: swapRoute,
          inputAmount: CurrencyAmount.fromRawAmount(usdcToken, usdc.div(2).toString()),
          outputAmount: CurrencyAmount.fromRawAmount(wethToken, quotedAmountOut.toString()),
          tradeType: TradeType.EXACT_INPUT,
        })
      }
      else { // ratio <= 0.5
        // Swapping WETH to USDC
        trade = await Trade.createUncheckedTrade({
          route: swapRoute,
          inputAmount: CurrencyAmount.fromRawAmount(wethToken, weth.div(2).toString()),
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

      // If we run out of gas here on a testnet, note this comment from Uniswap's Discord dev-chat
      // channel:
      //   looks like that pool is probably sitting at a bad price
      //   in v3 it loops though the ticks and liquidity and when it has a bad price it has to
      //   loop more causing need for more gas
      //   if it's your pool fix the balance in the pool
      //   right now there is a lot of the USDC and very little weth
      const txResponse: TransactionResponse = await wallet.sendTransaction(txRequest)
      console.log(`swap() TX hash: ${txResponse.hash}`) 
      // console.log(`swap() TX response:`)
      // console.dir(txResponse)

      const txReceipt: TransactionReceipt = await txResponse.wait()
      // console.log(`swap() TX receipt:`)
      // console.dir(txReceipt)

      this.logGasUsed(`swap()`, txReceipt)
    }
  
    async addLiquidity() {
      if (this.position || this.tokenId)
        throw "Can't add liquidity. Already in a position. Remove liquidity and swap first."
  
      // Ethers.js uses its own BigNumber but Uniswap expects a JSBI, or a string. A string is
      // easier.
      const availableUsdc = (await wallet.usdc()).toString()
      const availableWeth = (await wallet.weth()).toString()
      // console.log(`addLiquidity() Amounts available: ${availableUsdc} USDC, ${availableWeth} WETH`)

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
        // Rather than require minTick and maxTick to be valid, replace them with valid values on
        // testnets. These were observed on a manually created position, therefore they're valid.
        this.minTick = 191580
        this.maxTick = 195840
      }
  
      // Get ahead of the invariant test in v3-sdk's Position constructor:
      // invariant(tickLower >= TickMath.MIN_TICK && tickLower % pool.tickSpacing === 0, 'TICK_LOWER')
      if (this.minTick < TickMath.MIN_TICK) {
        throw `Lower tick of ${this.minTick} is below TickMath.MIN_TICK (${TickMath.MIN_TICK}). \
Can't create position.`
      }

      if (this.minTick % rangeOrderPool.tickSpacing !== 0) {
        throw `Lower tick of ${this.minTick} is not aligned with the tick spacing of \
${rangeOrderPool.tickSpacing}. Can't create position.`
      }

      // We don't know L, the liquidity, but we do know how much WETH and how much USDC we'd like
      // to add, which is all of it. Position.fromAmounts() just calls maxLiquidityForAmounts() to
      // figure out the liquidity then uses that in the Position constructor.
      let position = Position.fromAmounts({
        pool: rangeOrderPool,
        tickLower: this.minTick,
        tickUpper: this.maxTick,
        amount0: amount0,
        amount1: amount1,
        useFullPrecision: false
      })

      if (this.wethFirst) {
        console.log(`addLiquidity() Amounts available: ${availableUsdc} USDC, ${availableWeth} WETH. Mint amounts: ${position.mintAmounts.amount1.toString()} USDC, ${position.mintAmounts.amount0.toString()} WETH`)
      }
      else {
        console.log(`addLiquidity() Amounts available: ${availableUsdc} USDC, ${availableWeth} WETH. Mint amounts: ${position.mintAmounts.amount0.toString()} USDC, ${position.mintAmounts.amount1.toString()} WETH`)
      }
  
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
  
      // Send the transaction to the provider.
      const txResponse: TransactionResponse = await wallet.sendTransaction(txRequest)
      console.log(`addLiquidity() TX hash: ${txResponse.hash}`)
      // console.log(`addLiquidity() TX response:`)
      // console.dir(txResponse)

      const txReceipt: TransactionReceipt = await txResponse.wait()
      // console.log(`addLiquidity() TX receipt:`)
      // console.dir(txReceipt)

      this.tokenId = extractTokenId(txReceipt)
      this.position = position

      if (this.tokenId) {
        const webUrl = positionWebUrl(this.tokenId)
        console.log(`addLiquidity() Position URL: ${webUrl}`)

        insertOrReplacePosition(this.rangeWidthTicks, moment().toISOString(), this.tokenId)
      }
      else {
        console.error(`addLiquidity() No token ID from logs. We won't be able to remove this liquidity.`)
      }

      this.logGasUsed(`addLiquidity()`, txReceipt)
    }

    async swapAndAddLiquidity() {
      if (this.position || this.tokenId)
         throw "Refusing to swap and add liquidity. Still in a position. Remove liquidity first."

      // The order of the tokens in the pool varies from chain to chain, annoyingly.
      // Ethereum mainnet: USDC is first
      // Arbitrum mainnet: WETH is first
      let token0
      let token1

      let token0Balance
      let token1Balance

      if (this.wethFirst) {
        token0 = wethToken
        token1 = usdcToken

        // The wallet gives us BigNumbers for balances, but Uniswap's CurrencyAmount takes a
        // BigintIsh, which is a JSBI, string or number.
        token0Balance = CurrencyAmount.fromRawAmount(wethToken, await (await wallet.weth()).toString())
        token1Balance = CurrencyAmount.fromRawAmount(usdcToken, await (await wallet.usdc()).toString())
      }
      else {
        token0 = usdcToken
        token1 = wethToken

        token0Balance = CurrencyAmount.fromRawAmount(usdcToken, await (await wallet.usdc()).toString())
        token1Balance = CurrencyAmount.fromRawAmount(wethToken, await (await wallet.weth()).toString())
      }

      console.log(`[dro.ts] Token 0 balance: ${token0Balance.toFixed(4)}, token 1 balance: ${token1Balance.toFixed(4)}`)

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

      // Do NOT pass a string for the sqrtRatioX96 parameter below! JSBI does very little type checking.
      const sqrtRatioX96AsJsbi = JSBI.BigInt(slot[0].toString())

      console.log(`[dro.ts] sqrtRatioX96AsJsbi.toString(): ${sqrtRatioX96AsJsbi.toString()}`)
      console.log(`[dro.ts] sqrtRatioX96AsJsbi instanceof JSBI: ${sqrtRatioX96AsJsbi instanceof JSBI}`)
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
        // Rather than require minTick and maxTick to be valid, replace them with valid values on
        // testnets. These were observed on a manually created position, therefore they're valid.
        this.minTick = 191580
        this.maxTick = 195840
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
        tickLower: this.minTick,
        tickUpper: this.maxTick,
        liquidity: 1
      })

      const deadlineValue = moment().unix() + 1800

      console.log(`[dro.ts] deadline: ${deadlineValue}`)

      const router = new AlphaRouter({chainId: CHAIN_CONFIG.chainId, provider: CHAIN_CONFIG.provider()})

      console.log(`[dro.ts] Poistion tickLower: ${p.tickLower}`)
      console.log(`[dro.ts] Poistion tickUpper: ${p.tickUpper}`)

      const ZERO = JSBI.BigInt(0) // Same as v3-sdk/src/internalConstants.ts
      const slippageTolerance = new Percent(5, 100)
      console.log(`[dro.ts] slippageTolerance.lessThan(ZERO): ${slippageTolerance.lessThan(ZERO)}`)

      // From sdk-core:
      if (slippageTolerance instanceof JSBI || typeof slippageTolerance === 'number' || typeof slippageTolerance === 'string')
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

        console.log(`[dro.ts] number of swaps:`)
        console.dir(route.trade.swaps.length)

        console.log(`[dro.ts] first trade swap:`)
        console.dir(route.trade.swaps[0])

        console.log(`[dro.ts] number of routes:`)
        console.dir(route.trade.routes.length)

        console.log(`[dro.ts] first trade route:`)
        console.dir(route.trade.routes[0])

        console.log(`[dro.ts] trade input amount: ${route.trade.inputAmount.toFixed(2)} ${route.trade.inputAmount.currency.symbol}, output amount: ${route.trade.outputAmount.toFixed(2)} ${route.trade.outputAmount.currency.symbol}`)

        console.log(`[dro.ts] optimalRatio: ${route.optimalRatio.toFixed(4)}`)

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
        console.log(`swapAndAddLiquidity() TX hash: ${txResponse.hash}`)
        // console.log(`swapAndAddLiquidity() TX response:`)
        // console.dir(txResponse)

        const txReceipt: TransactionReceipt = await txResponse.wait()
        // console.log(`swapAndAddLiquidity() TX receipt:`)
        // console.dir(txReceipt)

        // The token ID is a small positive integer.
        this.tokenId = extractTokenId(txReceipt)
        this.position = p

        if (this.tokenId) {
          const webUrl = positionWebUrl(this.tokenId)
          console.log(`swapAndAddLiquidity() Position URL: ${webUrl}`)

          insertOrReplacePosition(this.rangeWidthTicks, moment().toISOString(), this.tokenId)
        }
        else {
          throw `swapAndAddLiquidity() No token ID from logs. We won't be able to remove this liquidity.`
        }
      }
      else {
        console.log(`[dro.ts] routeToRatioResponse:`)
        console.dir(routeToRatioResponse)

        // const responseAsFail: SwapToRatioFail = routeToRatioResponse
        // throw `Swap to ratio failed. Status: ${SwapToRatioStatus[routeToRatioResponse.status]}, error: ${responseAsFail.error}`
        throw `Swap to ratio failed. Status: ${SwapToRatioStatus[routeToRatioResponse.status]}`
      }
    }

    logGasUsed(logLinePrefix: string, txReceipt: TransactionReceipt) {
      // What did we just sepnd on gas? None of these are actually large integers.

      // Corresponds to "Gas Used by Transaction" on Etherscan
      const gasUsed: BigNumber = txReceipt.gasUsed
      // console.log(`Gas used: ${gasUsed.toNumber()}`)

      // txReceipt.cumulativeGasUsed: No idea what this is. Ignore it.

      // Corresponds to "Gas Price Paid" on Etherscan. Quoted in wei, typically about 0.66 gwei for Arbitrum.
      const effectiveGasPrice: BigNumber = txReceipt.effectiveGasPrice
      // console.log(`Effective gas price: ${effectiveGasPrice.toNumber()}`)

      const price: BigNumber = rangeOrderPoolPriceUsdcAsBigNumber()

      // USD cost of tx = gasUsed * effectiveGasPrice * price of Ether in USDC / 10^18 / 10^6
      const usdCostOfTx: BigNumber = gasUsed.mul(effectiveGasPrice).mul(price)

      const f: number = usdCostOfTx.mul(100).div(BigNumber.from(10).pow(24)).toNumber() / 100

      console.log(`${logLinePrefix} TX cost: USD ${f.toFixed(2)}`)
    }

    async onPriceChanged() {
      await this.checkUnclaimedFees()
    }

    async onBlock() {
      // When in no-op mode, don't execute any transactions but do find new ranges when necessary.
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

        // Check fees before removing liquidity.
        await this.checkUnclaimedFees()

        // Take note of what assets we now hold
        await wallet.logBalances()

        // Remove all of our liquidity now and burn the NFT for our position.
        await this.removeLiquidity()

        // Take note of what assets we now hold
        await wallet.logBalances()

        if (this.removeOnly) {
          console.log(`Done`)
          process.exit()
        }

        // Find our new range around the current price.
        this.updateRange()

        // Swap half our assets to the other asset so that we have equal value of assets.
        await this.swap()

        // Add all our WETH and USDC to a new liquidity position.
        await this.addLiquidity()

        // Deposit assets and let the protocol swap the optimal size for the liquidity position,
        // then enter the liquidity position all in one transaction.
        // Uniswap repo smart-order-router is not ready for production use. Wait for these blocking bugs to get a response before using it:
        //   https://github.com/Uniswap/smart-order-router/issues/64
        //   https://github.com/Uniswap/smart-order-router/issues/65
        // await this.swapAndAddLiquidity()

        // Take note of what assets we now hold
        await wallet.logBalances()

        this.locked = false
      }
    }
  }
