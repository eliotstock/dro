import { config } from 'dotenv'
import { BigNumber } from '@ethersproject/bignumber'
import { CollectOptions, MintOptions, nearestUsableTick, NonfungiblePositionManager, Pool, Position, RemoveLiquidityOptions, Route, tickToPrice } from "@uniswap/v3-sdk"
import { Token, CurrencyAmount, Percent, BigintIsh } from "@uniswap/sdk-core"
import { ethers } from 'ethers'
import { abi as QuoterABI } from "@uniswap/v3-periphery/artifacts/contracts/lens/Quoter.sol/Quoter.json"
import { abi as NonfungiblePositionManagerABI } from "@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json"
import moment from 'moment'
import { Immutables, State } from './uniswap'
import { useConfig } from './config'

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
    readonly poolImmutables: Immutables
    readonly usdc: Token
    readonly weth: Token
    readonly quoterContract: ethers.Contract
    readonly positionManagerContract: ethers.Contract
    priceUsdc: string = "unknown"
    minTick: number = 0
    maxTick: number = 0
    rangeWidthTicks = 0
    position?: Position
    tokenId?: BigintIsh
    unclaimedFeesUsdc?: BigintIsh
    unclaimedFeesWeth?: BigintIsh
  
    constructor(
        _owner: ethers.Wallet,
        _provider: ethers.providers.Provider,
        _chainConfig: any,
        _poolImmutables: Immutables,
        _usdc: Token,
        _weth: Token,
        _rangeWidthTicks: number) {
        this.owner = _owner
        this.provider = _provider
        this.chainConfig = _chainConfig
        this.poolImmutables = _poolImmutables
        this.usdc = _usdc
        this.weth = _weth
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
  
    async swap(swapPoolState: State) {
      if (this.position || this.tokenId) {
        console.error("Refusing to swap. Still in a position. Remove liquidity first.")
        return
      }

  
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
  
      const poolEthUsdcForSwaps = new Pool(
        this.usdc,
        this.weth,
        this.poolImmutables.fee, // TODO: Wrong. The fee is 0.05% here, not 0.30%.
        swapPoolState.sqrtPriceX96.toString(),
        swapPoolState.liquidity.toString(),
        swapPoolState.tick
      )
  
      const swapRoute = new Route([poolEthUsdcForSwaps], this.usdc, this.weth)
    }
  
    async addLiquidity(poolState: State) {
      if (this.position || this.tokenId) {
        console.error("Can't add liquidity. Already in a position. Remove liquidity and swap first.")
        return
      }
  
      // We can't instantiate this pool instance until we have the pool state.
      const poolEthUsdcForRangeOrder = new Pool(
        this.usdc,
        this.weth,
        this.poolImmutables.fee,
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
