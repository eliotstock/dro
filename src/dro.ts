import { config } from 'dotenv'
import { BigNumber } from '@ethersproject/bignumber'
import { CollectOptions, MintOptions, nearestUsableTick, NonfungiblePositionManager, Pool, Position, RemoveLiquidityOptions, Route, SwapOptions, SwapRouter, tickToPrice, Trade } from "@uniswap/v3-sdk"
import { CurrencyAmount, Percent, BigintIsh, TradeType } from "@uniswap/sdk-core"
import { TickMath } from '@uniswap/v3-sdk/'
import { ethers } from 'ethers'
import { TransactionResponse, TransactionReceipt } from "@ethersproject/abstract-provider";
import moment from 'moment'
import { useConfig, ChainConfig } from './config'
import { wallet } from './wallet'
import { rangeOrderPoolContract, swapPoolContract, quoterContract, positionManagerContract, usdcToken, wethToken, rangeOrderPoolTick, rangeOrderPoolTickSpacing } from './uniswap'

// Read our .env file
config()

// Static config that doesn't belong in the .env file.
const CHAIN_CONFIG: ChainConfig = useConfig()

// On all transactions, set the deadline to 3 minutes from now
const DEADLINE_SECONDS = 180

const VALUE_ZERO_ETHER = ethers.utils.parseEther("0")

export class DRO {
    readonly rangeWidthTicks: number
    readonly noops: boolean

    minTick: number = 0
    maxTick: number = 0
    position?: Position
    tokenId?: BigintIsh
    unclaimedFeesUsdc?: BigintIsh
    unclaimedFeesWeth?: BigintIsh
  
    constructor(
        _rangeWidthTicks: number,
        _noops: boolean) {
        this.rangeWidthTicks = _rangeWidthTicks
        this.noops = _noops

        console.log(`[${this.rangeWidthTicks}] init`)
    }
  
    outOfRange() {
        return rangeOrderPoolTick &&
          (rangeOrderPoolTick < this.minTick || rangeOrderPoolTick > this.maxTick)
    }
  
    // Note that if rangeWidthTicks is not a multiple of the tick spacing for the pool, the range
    // returned here can be quite different to rangeWidthTicks.
    updateRange() {
      if (rangeOrderPoolTick == undefined) throw "No tick yet."

      // console.log(`updateRange() Width: ${this.rangeWidthTicks}, rangeOrderPoolTick: ${rangeOrderPoolTick}`)

      this.minTick = Math.round(rangeOrderPoolTick - (this.rangeWidthTicks / 2))

      // console.log(`updateRange() minTick: ${this.minTick}`)

      // Don't go under MIN_TICK, which can happen on testnets.
      this.minTick = Math.max(this.minTick, TickMath.MIN_TICK)
      this.minTick = nearestUsableTick(this.minTick, rangeOrderPoolTickSpacing)

      // console.log(`updateRange() minTick usable: ${this.minTick}`)
  
      this.maxTick = Math.round(rangeOrderPoolTick + (this.rangeWidthTicks / 2))

      // console.log(`updateRange() maxTick: ${this.maxTick}`)

      // Don't go over MAX_TICK, which can happen on testnets.
      this.maxTick = Math.min(this.maxTick, TickMath.MAX_TICK)
      this.maxTick = nearestUsableTick(this.maxTick, rangeOrderPoolTickSpacing)

      // console.log(`updateRange() maxTick usable: ${this.maxTick}`)
  
      // tickToPrice() implementation:
      //   https://github.com/Uniswap/v3-sdk/blob/6c4242f51a51929b0cd4f4e786ba8a7c8fe68443/src/utils/priceTickConversions.ts#L14
      // Note that minimum USDC value per ETH corresponds to the maximum tick value and vice versa.
      const minUsdc = tickToPrice(wethToken, usdcToken, this.maxTick).toFixed(2)
      const maxUsdc = tickToPrice(wethToken, usdcToken, this.minTick).toFixed(2)
  
      console.log(`[${this.rangeWidthTicks}] New range: ${minUsdc} USDC - ${maxUsdc} USDC.`)
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
        liquidityPercentage: new Percent(1), // 100%
        slippageTolerance: CHAIN_CONFIG.slippageTolerance,
        deadline: moment().unix() + DEADLINE_SECONDS,
        collectOptions: collectOptions
      }
  
      const {calldata, value} = NonfungiblePositionManager.removeCallParameters(this.position, removeLiquidityOptions)
  
      const nonce = await wallet.getTransactionCount("latest")
      console.log("nonce: ", nonce)
  
      const tx = {
        from: wallet.address,
        to: CHAIN_CONFIG.addrPositionManager,
        value: VALUE_ZERO_ETHER,
        nonce: nonce,
        gasLimit: CHAIN_CONFIG.gasLimit,
        gasPrice: CHAIN_CONFIG.gasPrice,
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

      const swapPoolFee = await swapPoolContract.fee()
      console.log("swapPoolFee: ", swapPoolFee)

      // Assume we're swapping our entire WETH balance for USDC for now.
      const weth = await wallet.weth()
  
      const quotedUsdcOut = await quoterContract.callStatic.quoteExactInputSingle(
        CHAIN_CONFIG.addrTokenWeth, // Token in
        CHAIN_CONFIG.addrTokenUsdc, // Token out
        swapPoolFee, // 0.05%
        weth, // Amount in, WETH (18 decimals), BigNumber
        0 // sqrtPriceLimitX96
      )
  
      // Swapping 1_000_000_000_000_000_000 WETH (18 zeroes) will get us 19_642_577_913_338_823 USDC (19B USDC)
      console.log(`[${this.rangeWidthTicks}] Swapping ${weth} WETH will get us ${quotedUsdcOut.toString()} USDC`)
  
      // The pool depends on the pool liquidity and slot 0 so we need to reconstruct it every time.
      const liquidity = await swapPoolContract.liquidity()
      const slot = await swapPoolContract.slot0()

      const poolEthUsdcForSwaps = new Pool(
        usdcToken,
        wethToken,
        swapPoolFee, // 0.05%
        slot[0].toString(),
        liquidity.toString(),
        slot[1]
      )
  
      // The order of the tokens here is significant. Input first.
      const swapRoute = new Route([poolEthUsdcForSwaps], wethToken, usdcToken)

      const trade = await Trade.createUncheckedTrade({
        route: swapRoute,
        inputAmount: CurrencyAmount.fromRawAmount(wethToken, weth.toString()),
        outputAmount: CurrencyAmount.fromRawAmount(usdcToken, quotedUsdcOut.toString()),
        tradeType: TradeType.EXACT_INPUT,
      });
      console.log("Trade:")
      console.dir(trade)

      const options: SwapOptions = {
        slippageTolerance: CHAIN_CONFIG.slippageTolerance,
        recipient: wallet.address,
        deadline: moment().unix() + DEADLINE_SECONDS
      }

      const { calldata, value } = SwapRouter.swapCallParameters(trade, options)
      console.log("calldata: ", calldata)

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

      console.log("swap() TX response: ", txResponse)
      // console.log("swap() Max fee per gas: ", txResponse.maxFeePerGas?.toString())
      // console.log("swap() Gas limit: ", txResponse.gasLimit?.toString())

      const txReceipt: TransactionReceipt = await txResponse.wait()

      console.log("swap() TX receipt:")
      console.dir(txReceipt)
      console.log("swap(): Effective gas price: ", txReceipt.effectiveGasPrice.toString())

      /*
      // The other approach here is to execute the swap directly on the pool contract, skipping the
      // router.
      // See: https://github.com/Uniswap/v3-core/blob/main/contracts/UniswapV3Pool.sol#L596
      // We may need to calculate the sqrtPriceLimitX96 based on the unchecked trade object.
      this.swapPoolContract = this.swapPoolContract.connect(wallet)

      const recipient = wallet.address

      // The direction of the swap, true for token0 to token1, false for token1 to token0
      const zeroForOne = true

      // The amount of the swap, which implicitly configures the swap as exact input (positive), or exact output (negative)
      const amountSpecified = 1

      // The Q64.96 sqrt price limit. If zero for one, the price cannot be less than this value after the swap. If one for zero, the price cannot be greater than this value after the swap
      const sqrtPriceLimitX96 = 1

      // Any data to be passed through to the callback
      const data = 0x0

      const calldata: string = this.swapPoolContract.interface.encodeFunctionData('swap', [
          recipient,
          zeroForOne,
          amountSpecified,
          sqrtPriceLimitX96,
          data
      ])

      console.log("calldata: ", calldata)
  
      const nonce = await wallet.getTransactionCount("latest")
  
      // Sending WETH, not ETH, so value is zero here. WETH amount is in the call data.
      const txRequest = {
        from: wallet.address,
        to: this.chainConfig.addrPoolSwaps,
        value: VALUE_ZERO_ETHER,
        nonce: nonce,
        gasLimit: CHAIN_CONFIG.gasLimit,
        gasPrice: this.chainConfig.gasPrice,
        data: calldata
      }

      // Send the transaction to the provider.
      // TODO: Fix:
      //   reason: 'transaction failed',
      //   code: 'CALL_EXCEPTION',
      const txResponse: TransactionResponse = await wallet.sendTransaction(txRequest)

      console.log("swap() TX response: ", txResponse)
      console.log("swap() Max fee per gas: ", txResponse.maxFeePerGas?.toString())
      console.log("swap() Gas limit: ", txResponse.gasLimit?.toString())

      const txReceipt: TransactionReceipt = await txResponse.wait()

      console.log("swap() TX receipt:")
      console.dir(txReceipt)
      console.log("swap(): Effective gas price: ", txReceipt.effectiveGasPrice.toString())

      // TODO: Fails with UNPREDICTABLE_GAS_LIMIT. Execute this using the same approach as the other methods, ie:
      //   await wallet.sendTransaction(txRequest)
      // Construct the calldata from these parameters.
      // await this.swapPoolContract.swap(recipient,
      //   zeroForOne,
      //   amountSpecified,
      //   sqrtPriceLimitX96,
      //   data
      // )
      */
    }
  
    async addLiquidity() {
      if (this.position || this.tokenId)
        throw "Can't add liquidity. Already in a position. Remove liquidity and swap first."
  
      // Ethers.js uses its own BigNumber but Uniswap expects a JSBI, or a string. A String is easier.
      const amountUsdc = (await wallet.usdc()).toString()
      const amountWeth = (await wallet.weth()).toString()
      const amountEth = (await wallet.getBalance()).toString()

      console.log("addLiquidity(): Amounts available: ", amountUsdc, " USDC", amountWeth, " WETH", amountEth, " ETH")

      const slot = await rangeOrderPoolContract.slot0()
      const liquidity = await rangeOrderPoolContract.liquidity()

      // A position instance requires a Pool instance.
      const rangeOrderPool = new Pool(
        usdcToken,
        wethToken,
        slot[5], // Fee: 0.30%
        slot[0].toString(), // SqrtRatioX96
        liquidity.toString(), // Liquidity
        slot[1] // Tick
      )
  
      // We don't know L, the liquidity, but we do know how much WETH and how much USDC we'd like to add.
      const position = Position.fromAmounts({
        pool: rangeOrderPool,
        tickLower: this.minTick,
        tickUpper: this.maxTick,
        amount0: amountUsdc,
        amount1: amountWeth,
        useFullPrecision: true
      })
  
      console.log("addLiquidity(): Amounts desired: ", position.mintAmounts.amount0.toString(), "USDC", position.mintAmounts.amount1.toString(), "WETH")
  
      const mintOptions: MintOptions = {
        slippageTolerance: CHAIN_CONFIG.slippageTolerance,
        deadline: moment().unix() + DEADLINE_SECONDS,
        recipient: wallet.address,
        createPool: false
      }
  
      // addCallParameters() implementation:
      //   https://github.com/Uniswap/v3-sdk/blob/6c4242f51a51929b0cd4f4e786ba8a7c8fe68443/src/nonfungiblePositionManager.ts#L164
      const { calldata, value } = NonfungiblePositionManager.addCallParameters(position, mintOptions)
  
      console.log("calldata: ", calldata)
  
      const nonce = await wallet.getTransactionCount("latest")
  
      // Sending WETH, not ETH, so value is zero here. WETH amount is in the call data.
      const txRequest = {
        from: wallet.address,
        to: CHAIN_CONFIG.addrPositionManager,
        value: VALUE_ZERO_ETHER,
        // value: amountEth,
        nonce: nonce,
        gasLimit: CHAIN_CONFIG.gasLimit,
        gasPrice: CHAIN_CONFIG.gasPrice,
        data: calldata
      }
  
      // Send the transaction to the provider.
      const txResponse: TransactionResponse = await wallet.sendTransaction(txRequest)

      console.log("addLiquidity() TX response: ", txResponse)
      console.log("addLiquidity() Max fee per gas: ", txResponse.maxFeePerGas?.toString()) // 100_000_000_000 wei or 100 gwei
      console.log("addLiquidity() Gas limit: ", txResponse.gasLimit?.toString()) // 450_000

      const txReceipt: TransactionReceipt = await txResponse.wait()

      console.log("addLiquidity() TX receipt:")
      console.dir(txReceipt)
      console.log("addLiquidity(): Effective gas price: ", txReceipt.effectiveGasPrice.toString())
  
      // TODO: This is failing. No position is created.
      //   When on a testnet, don't use anyone else's pool. Create one ourselves, even if it means
      //     using a newly deploy contract for USDC.
      //   Can we turn on tracing? Does Infura support it?
      //   If not can we run geth locally and test with tracing on?
      //   Are we running out of gas? Is Kovan unrealistic for gas cost?
      //   Would this actually work on Mainnet?
      //   Can we decode the calldata using an ethers Interface and check it?

      // TODO: Call tokenOfOwnerByIndex() on an ERC-721 ABI and pass in our own address to get the token ID.
    }

    async onBlock() {
      // When in no-op mode, don't execute any transactions but do re-range when necessary.
      if (this.noops) {
        if (this.outOfRange()) {
          this.updateRange()
        }

        return
      }

      // Are we now out of range?
      if (this.outOfRange()) {
        // Remove all of our liquidity now and burn the NFT for our position.
        await this.removeLiquidity()

        // Take note of what assets we now hold
        wallet.logBalances()

        // Find our new range around the current price.
        this.updateRange()

        // Swap half our assets to the other asset so that we have equal value of assets.
        await this.swap()

        // Add all our WETH and USDC to a new liquidity position.
        await this.addLiquidity()
      }
    }
  }
