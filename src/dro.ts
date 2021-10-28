import { config } from 'dotenv'
import { BigNumber } from '@ethersproject/bignumber'
import { CollectOptions, MintOptions, nearestUsableTick, NonfungiblePositionManager, Pool, Position, RemoveLiquidityOptions, Route, SwapOptions, SwapRouter, tickToPrice, Trade } from "@uniswap/v3-sdk"
import { Token, CurrencyAmount, Percent, BigintIsh, TradeType } from "@uniswap/sdk-core"
import { ethers } from 'ethers'
import { TransactionResponse, TransactionReceipt } from "@ethersproject/abstract-provider";
import { abi as QuoterABI } from "@uniswap/v3-periphery/artifacts/contracts/lens/Quoter.sol/Quoter.json"
import { abi as NonfungiblePositionManagerABI } from "@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json"
import { abi as IUniswapV3PoolABI } from "@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json"
import moment from 'moment'
import { Immutables, State, getPoolImmutables, getPoolState } from './uniswap'
import { useConfig, ChainConfig } from './config'
import { EthUsdcWallet } from './wallet'
import invariant from 'tiny-invariant'
import { TickMath } from '@uniswap/v3-sdk/'

// Read our .env file
config()

// Static config that doesn't belong in the .env file.
const CHAIN_CONFIG: ChainConfig = useConfig()

// On all transactions, set the deadline to 3 minutes from now
const DEADLINE_SECONDS = 180

const VALUE_ZERO_ETHER = ethers.utils.parseEther("0")

export class DRO {
    readonly owner: EthUsdcWallet
    readonly provider: ethers.providers.Provider
    readonly chainConfig: any
    readonly quoterContract: ethers.Contract
    readonly positionManagerContract: ethers.Contract
    readonly noops: boolean
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
        _owner: EthUsdcWallet,
        _chainConfig: any,
        _rangeWidthTicks: number,
        _noops: boolean) {
        this.owner = _owner
        this.provider = _chainConfig.provider()
        this.chainConfig = _chainConfig
        this.rangeWidthTicks = _rangeWidthTicks
        this.noops = _noops

        this.quoterContract = new ethers.Contract(
            CHAIN_CONFIG.addrQuoter,
            QuoterABI,
            this.provider
        )
          
        this.positionManagerContract = new ethers.Contract(
            CHAIN_CONFIG.addrPositionManager,
            NonfungiblePositionManagerABI,
            this.provider
        )

        this.rangeOrderPoolContract = new ethers.Contract(
            this.chainConfig.addrPoolRangeOrder,
            IUniswapV3PoolABI,
            this.provider
        )

        this.swapPoolContract = new ethers.Contract(
            this.chainConfig.addrPoolSwaps,
            IUniswapV3PoolABI,
            this.provider
        )
    }

    async init() {
      console.log(`[${this.rangeWidthTicks}] init`)

      // Get the range order pool's immutables once only.
      this.poolImmutables = await getPoolImmutables(this.rangeOrderPoolContract)

      this.usdc = new Token(this.chainConfig.chainId, this.poolImmutables.token0, 6, "USDC", "USD Coin")

      this.weth = new Token(this.chainConfig.chainId, this.poolImmutables.token1, 18, "WETH", "Wrapped Ether")

      // console.log("USDC: ", this.poolImmutables.token0)
      // console.log("WETH: ", this.poolImmutables.token1)
      // console.log("Fee: ", this.poolImmutables.fee)

      // Event emitted here:
      //   https://github.com/Uniswap/v3-core/blob/main/contracts/UniswapV3Pool.sol#L786
      // and defined here:
      //   https://github.com/Uniswap/v3-core/blob/main/contracts/interfaces/pool/IUniswapV3PoolEvents.sol#L72
      // TODO: Move this out to a swap-monitor.ts source and have it triggered by a command line arg.
      this.rangeOrderPoolContract.on('Swap', (sender, recipient, amount0, amount1, sqrtPriceX96, liquidity, tick) => {
        if (this.usdc == undefined || this.weth == undefined) throw "Not init()ed"

        const price = tickToPrice(this.weth, this.usdc, tick).toFixed(2)
        console.log("Swap price:", price)
      })

      // TODO: Put back once nonce error debugged.
      // await this.owner.approveAll()
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
  
        console.log(`[${this.rangeWidthTicks}] Unclaimed fees: ${this.unclaimedFeesUsdc} USDC, ${this.unclaimedFeesWeth} WETH`)
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
        to: CHAIN_CONFIG.addrPositionManager,
        value: VALUE_ZERO_ETHER,
        nonce: nonce,
        gasLimit: CHAIN_CONFIG.gasLimit,
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

      if (this.swapPoolState == undefined) throw "No swap pool state"

      const swapPoolFee = await this.swapPoolContract.fee()
      console.log("swapPoolFee: ", swapPoolFee)

      // Assume we're swapping our entire WETH balance for USDC for now.
      const weth = await this.owner.weth()
  
      const quotedUsdcOut = await this.quoterContract.callStatic.quoteExactInputSingle(
        this.poolImmutables.token1, // Token in: WETH
        this.poolImmutables.token0, // Token out: USDC
        swapPoolFee, // 0.05%
        weth, // Amount in, WETH (18 decimals), BigNumber
        0 // sqrtPriceLimitX96
      )
  
      // Swapping 1_000_000_000_000_000_000 WETH (18 zeroes) will get us 19_642_577_913_338_823 USDC (19B USDC)
      console.log(`[${this.rangeWidthTicks}] Swapping ${weth} WETH will get us ${quotedUsdcOut.toString()} USDC`)
  
      // The pool depends on the pool state so we need to reconstruct it every time the state changes.
      const poolEthUsdcForSwaps = new Pool(
        this.usdc,
        this.weth,
        swapPoolFee, // 0.05%
        this.swapPoolState.sqrtPriceX96.toString(),
        this.swapPoolState.liquidity.toString(),
        this.swapPoolState.tick
      )
  
      // The order of the tokens here is significant. Input first.
      const swapRoute = new Route([poolEthUsdcForSwaps], this.weth, this.usdc)

      const trade = await Trade.createUncheckedTrade({
        route: swapRoute,
        inputAmount: CurrencyAmount.fromRawAmount(this.weth, weth.toString()),
        outputAmount: CurrencyAmount.fromRawAmount(this.usdc, quotedUsdcOut.toString()),
        tradeType: TradeType.EXACT_INPUT,
      });
      console.log("Trade:")
      console.dir(trade)

      const options: SwapOptions = {
        slippageTolerance: this.chainConfig.slippageTolerance,
        recipient: this.owner.address,
        deadline: moment().unix() + DEADLINE_SECONDS
      }

      const { calldata, value } = SwapRouter.swapCallParameters(trade, options)
      console.log("calldata: ", calldata)

      const nonce = await this.owner.getTransactionCount("latest")
  
      // Sending WETH, not ETH, so value is zero here. WETH amount is in the call data.
      const txRequest = {
        from: this.owner.address,
        to: CHAIN_CONFIG.addrSwapRouter,
        value: VALUE_ZERO_ETHER,
        nonce: nonce,
        gasLimit: CHAIN_CONFIG.gasLimit,
        gasPrice: this.chainConfig.gasPrice,
        data: calldata
      }

      // If we run out of gas here on a testnet, note this comment from Uniswap's Discord dev-chat
      // channel:
      //   looks like that pool is probably sitting at a bad price
      //   in v3 it loops though the ticks and liquidity and when it has a bad price it has to
      //   loop more causing need for more gas
      //   if it's your pool fix the balance in the pool
      //   right now there is a lot of the USDC and very little weth
      const txResponse: TransactionResponse = await this.owner.sendTransaction(txRequest)

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
      this.swapPoolContract = this.swapPoolContract.connect(this.owner)

      const recipient = this.owner.address

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
  
      const nonce = await this.owner.getTransactionCount("latest")
  
      // Sending WETH, not ETH, so value is zero here. WETH amount is in the call data.
      const txRequest = {
        from: this.owner.address,
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
      const txResponse: TransactionResponse = await this.owner.sendTransaction(txRequest)

      console.log("swap() TX response: ", txResponse)
      console.log("swap() Max fee per gas: ", txResponse.maxFeePerGas?.toString())
      console.log("swap() Gas limit: ", txResponse.gasLimit?.toString())

      const txReceipt: TransactionReceipt = await txResponse.wait()

      console.log("swap() TX receipt:")
      console.dir(txReceipt)
      console.log("swap(): Effective gas price: ", txReceipt.effectiveGasPrice.toString())

      // TODO: Fails with UNPREDICTABLE_GAS_LIMIT. Execute this using the same approach as the other methods, ie:
      //   await this.owner.sendTransaction(txRequest)
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
      if (this.poolImmutables == undefined || this.usdc == undefined || this.weth == undefined) throw "Not init()ed"

      if (this.rangeOrderPoolState == undefined || this.rangeOrderPool == undefined) throw "Not updatePoolState()ed"

      if (this.position || this.tokenId)
        throw "Can't add liquidity. Already in a position. Remove liquidity and swap first."
  
      // Ethers.js uses its own BigNumber but Uniswap expects a JSBI, or a string. A String is easier.
      const amountUsdc = (await this.owner.usdc()).toString()
      const amountWeth = (await this.owner.weth()).toString()
      const amountEth = (await this.owner.getBalance()).toString()

      console.log("addLiquidity(): Amounts available: ", amountUsdc, " USDC", amountWeth, " WETH", amountEth, " ETH")
  
      // We don't know L, the liquidity, but we do know how much WETH and how much USDC we'd like to add.
      const position = Position.fromAmounts({
        pool: this.rangeOrderPool,
        tickLower: this.minTick,
        tickUpper: this.maxTick,
        amount0: amountUsdc,
        amount1: amountWeth,
        useFullPrecision: true
      })
  
      console.log("addLiquidity(): Amounts desired: ", position.mintAmounts.amount0.toString(), "USDC", position.mintAmounts.amount1.toString(), "WETH")
  
      const mintOptions: MintOptions = {
        slippageTolerance: this.chainConfig.slippageTolerance,
        deadline: moment().unix() + DEADLINE_SECONDS,
        recipient: this.owner.address,
        createPool: false
      }
  
      // addCallParameters() implementation:
      //   https://github.com/Uniswap/v3-sdk/blob/6c4242f51a51929b0cd4f4e786ba8a7c8fe68443/src/nonfungiblePositionManager.ts#L164
      const { calldata, value } = NonfungiblePositionManager.addCallParameters(position, mintOptions)
  
      console.log("calldata: ", calldata)
  
      const nonce = await this.owner.getTransactionCount("latest")
  
      // Sending WETH, not ETH, so value is zero here. WETH amount is in the call data.
      const txRequest = {
        from: this.owner.address,
        to: CHAIN_CONFIG.addrPositionManager,
        value: VALUE_ZERO_ETHER,
        // value: amountEth,
        nonce: nonce,
        gasLimit: CHAIN_CONFIG.gasLimit,
        gasPrice: this.chainConfig.gasPrice,
        data: calldata
      }
  
      // Send the transaction to the provider.
      const txResponse: TransactionResponse = await this.owner.sendTransaction(txRequest)

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

    async onBlock(wallet: EthUsdcWallet) {
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
