import { config } from 'dotenv'
import { ethers } from 'ethers'
import { TransactionResponse, TransactionReceipt } from '@ethersproject/abstract-provider'
import { log } from './logger'
import { useConfig, ChainConfig, useProvider } from './config'
import { wallet } from './wallet'
import { TOKEN_USDC, TOKEN_WETH } from './tokens'
import moment from 'moment'
import JSBI from 'jsbi'

// Uniswap SDK interface
import { abi as IUniswapV3PoolABI }
    from '@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json'
import { abi as QuoterABI }
    from '@uniswap/v3-periphery/artifacts/contracts/lens/Quoter.sol/Quoter.json'
import { abi as NonfungiblePositionManagerABI }
    from '@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json'
import { BigintIsh, Fraction, Token } from '@uniswap/sdk-core'
import {
    tickToPrice,
    TickMath,
    Pool,
    Position,
    MintOptions,
    NonfungiblePositionManager,
    toHex,
    Multicall,
    nearestUsableTick,
    SqrtPriceMath
} from '@uniswap/v3-sdk'
import { CurrencyAmount } from '@uniswap/smart-order-router'
import { metrics } from './metrics'

// Read our .env file
config()

// Static config that doesn't belong in the .env file.
const CHAIN_CONFIG: ChainConfig = useConfig()

const N_10_TO_THE_18 = BigInt(1_000_000_000_000_000_000)

const TOPIC_0_INCREASE_LIQUIDITY = '0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f'

export class PositionWithTokenId {
    readonly position: Position
    readonly tokenId: number

    constructor(
        _position: Position,
        _tokenId: number) {
        this.position = _position
        this.tokenId = _tokenId
    }
}

export let rangeOrderPoolTick: number

// On all transactions, set the deadline to 3 minutes from now
export const DEADLINE_SECONDS = 180

export const VALUE_ZERO_ETHER = ethers.utils.parseEther("0")

export const rangeOrderPoolContract = new ethers.Contract(
    CHAIN_CONFIG.addrPoolRangeOrder,
    IUniswapV3PoolABI,
    useProvider()
)

export const swapPoolContract = new ethers.Contract(
    CHAIN_CONFIG.addrPoolSwaps,
    IUniswapV3PoolABI,
    useProvider()
)

export const quoterContract = new ethers.Contract(
    CHAIN_CONFIG.addrQuoter,
    QuoterABI,
    useProvider()
)

// Contract source:
//   https://github.com/Uniswap/v3-periphery/blob/main/contracts/NonfungiblePositionManager.sol
// Etherscan UI for read functions:
//   https://etherscan.io/address/0xC36442b4a4522E871399CD717aBDD847Ab11FE88#readContract
export const positionManagerContract = new ethers.Contract(
    CHAIN_CONFIG.addrPositionManager,
    NonfungiblePositionManagerABI,
    useProvider()
)

export async function updateTick() {
    const slot = await rangeOrderPoolContract.slot0()

    rangeOrderPoolTick = slot[1]
}

export async function useSwapPool(): Promise<[Pool, boolean]> {
    return usePool(swapPoolContract)
}

export async function useRangeOrderPool(): Promise<[Pool, boolean]> {
    return usePool(rangeOrderPoolContract)
}

// Returns USDC's small units (USDC has six decimals)
// When the price in the pool is USDC 3,000, this will return 3_000_000_000.
export function price(): bigint {
    if (rangeOrderPoolTick === undefined) return 0n

    // tickToPrice() returns a Price<Token, Token> which extends Fraction in which numerator
    // and denominator are both JSBIs.
    const p = tickToPrice(TOKEN_WETH, TOKEN_USDC, rangeOrderPoolTick)

    // The least bad way to get from JSBI to BigInt is via strings for numerator and denominator.
    const num = BigInt(p.numerator.toString())
    const denom = BigInt(p.denominator.toString())

    return num * N_10_TO_THE_18 / denom
}

export function priceFormatted(): string {
    if (rangeOrderPoolTick === undefined) return 'unknown'

    // tickToPrice() returns a Price<Token, Token> which extends Fraction in which numerator
    // and denominator are both JSBIs.
    const p = tickToPrice(TOKEN_WETH, TOKEN_USDC, rangeOrderPoolTick)

    return p.toFixed(2, {groupSeparator: ','})
}


// Given the current tick (price) in the pool and a range width in ticks, what are the lower and
// upper ticks of the range? 
export function rangeAround(tick: number, width: number, tickSpacing: number): [number, number] {
    // Note that if rangeWidthTicks is not a multiple of the tick spacing for the pool, the range
    // returned here can be quite different to rangeWidthTicks.
    let tickLower = Math.round(tick - (width / 2))

    // Don't go under MIN_TICK, which can happen on testnets.
    tickLower = Math.max(tickLower, TickMath.MIN_TICK)
    tickLower = nearestUsableTick(tickLower, tickSpacing)

    let tickUpper = Math.round(tick + (width / 2))

    // Don't go over MAX_TICK, which can happen on testnets.
    tickUpper = Math.min(tickUpper, TickMath.MAX_TICK)
    tickUpper = nearestUsableTick(tickUpper, tickSpacing)

    return [tickLower, tickUpper]
}

export async function currentPosition(address: string): Promise<PositionWithTokenId | undefined> {
    // Get the token ID for our position from the position manager contract/NFT.
    const tokenId = await currentTokenId(address)

    if (tokenId === undefined) {
        log.info(`No existing position NFT`)
        metrics.currentPositionNft.set(0)

        return undefined
    }
    else {
        log.info(`Position NFT: ${positionWebUrl(tokenId)}`)
        metrics.currentPositionNft.set(Math.floor(tokenId)) // Why is the token id a float?
    }

    const position = await positionManagerContract.positions(tokenId)

    const [rangeOrderPool, wethFirstInRangeOrderPool] = await useRangeOrderPool()

    const usablePosition = new Position({
        pool: rangeOrderPool,
        liquidity: position.liquidity,
        tickLower: position.tickLower,
        tickUpper: position.tickUpper
    })

    return new PositionWithTokenId(usablePosition, tokenId)
}

// Every pool we use has WETH as one token and USDC as the other, but the order varies from Mainnet
// to Arbitrum, annoyingly.
export async function tokenOrderIsWethFirst(poolContract: ethers.Contract): Promise<boolean> {
    const token0 = await poolContract.token0()
    const token1 = await poolContract.token1()

    if (token0.toUpperCase() == CHAIN_CONFIG.addrTokenWeth.toUpperCase() &&
        token1.toUpperCase() == CHAIN_CONFIG.addrTokenUsdc.toUpperCase()) {
        // log.info(`Token order in the pool is 0: WETH, 1: USDC`)
        return true
    }
    else if (token0.toUpperCase() == CHAIN_CONFIG.addrTokenUsdc.toUpperCase() &&
        token1.toUpperCase() == CHAIN_CONFIG.addrTokenWeth.toUpperCase()) {
        // log.info(`Token order in the pool is 0: USDC, 1: WETH`)
        return false
    }
    else {
        throw 'Tokens in range order pool contract are not WETH and USDC. WTF.'
    }
}

export function extractTokenId(txReceipt: TransactionReceipt): number | undefined {
    if (!Array.isArray(txReceipt.logs)) throw `Expected a logs array`

    for (const log of txReceipt.logs) {
        if (log.topics[0] === TOPIC_0_INCREASE_LIQUIDITY && log.topics[1]) {
            const tokenIdHexString = log.topics[1]
            const tokenId = ethers.BigNumber.from(tokenIdHexString)

            // This will throw an error if Uniswap ever has more LP positions than Number.MAX_SAFE_INTEGER.
            return tokenId.toNumber()
        }
    }

    return undefined
}

// Replaced by currentPosition()
/*
export async function positionByTokenId(tokenId: number, wethFirst: boolean): Promise<Position> {
    // Do NOT call these once on startup. They need to be called every time we use the pool.
    const [position, liquidity, slot, fee, tickSpacing] = await Promise.all([
        positionManagerContract.positions(tokenId),
        rangeOrderPoolContract.liquidity(),
        rangeOrderPoolContract.slot0(),
        rangeOrderPoolContract.fee(),
        rangeOrderPoolContract.tickSpacing()
    ])

    // The fee in the pool determines the tick spacing and if it's zero, the tick spacing will be
    // undefined. This will throw an error when the position gets created.
    if (fee == 0) throw `No fee. WTF.`
    if (tickSpacing == 0) throw `No tick spacing. WTF.`

    // The Pool instance on the position at this point is sorely lacking. Replace it. Because all
    // the properties on the Position are readonly this means constructing a new one.

    // The order of the tokens in the pool varies from chain to chain, annoyingly.
    //   Ethereum mainnet: USDC is first
    //   Arbitrum mainnet: WETH is first
    let token0
    let token1

    if (wethFirst) {
        token0 = TOKEN_WETH
        token1 = TOKEN_USDC
    }
    else {
        token0 = TOKEN_USDC
        token1 = TOKEN_WETH
    }

    const usablePool = new Pool(
        token0,
        token1,
        fee,
        slot[0].toString(), // SqrtRatioX96
        liquidity.toString(), // Liquidity
        slot[1] // Tick
    )

    // log.info(`Tick lower, upper: ${position.tickLower}, ${position.tickUpper}`)

    // Note that in some previous versions of the Uniswap modules we used to have to replace the
    // position.liquidity property with a JSBI in order for removeCallParameters() to work. We no
    // longer need to, it seems.
    // const liquidityJsbi = JSBI.BigInt(position.liquidity)
    // log.info(`Position liquidity: ${liquidityJsbi.toString()}`)

    const usablePosition = new Position({
        pool: usablePool,
        liquidity: position.liquidity,
        tickLower: position.tickLower,
        tickUpper: position.tickUpper
    })

    return usablePosition
}
*/

export function positionWebUrl(tokenId: number): string {
    // TODO: Add chain parameter. Works without one for L1 of if you're already on the right chain.
    return `https://app.uniswap.org/#/pool/${tokenId}`
}

// Simplified fork of Uniswap's NonfungiblePositionManager.removeCallParameters(), which has given
// us grief in the past (liquidity in call params higher than position liquidity). We always want
// to remove 100% of our liquidity.
//   https://github.com/Uniswap/v3-sdk/blob/main/src/nonfungiblePositionManager.ts#L341
export function removeCallParameters(position: Position,
    tokenId: number,
    deadline: BigintIsh,
    recipient: string): string {
    const calldatas: string[] = []

    const deadlineHex = toHex(deadline)
    const tokenIdHex = toHex(tokenId)

    // Verbatim from NonfungiblePositionManager
    const MaxUint128 = toHex(JSBI.subtract(JSBI.exponentiate(JSBI.BigInt(2), JSBI.BigInt(128)), JSBI.BigInt(1)))

    // Remove liquidity function call.
    calldatas.push(
      NonfungiblePositionManager.INTERFACE.encodeFunctionData('decreaseLiquidity', [
        {
          tokenId,
          liquidity: toHex(position.liquidity),
          amount0Min: toHex(0),
          amount1Min: toHex(0),
          deadline
        }
      ])
    )

    // Collect function call.
    calldatas.push(
      NonfungiblePositionManager.INTERFACE.encodeFunctionData('collect', [
        {
          tokenId,
          recipient: recipient,
          amount0Max: MaxUint128,
          amount1Max: MaxUint128
        }
      ])
    )

    return Multicall.encodeMulticall(calldatas)
}

// Simplied fork of Uniswap's calculateOptimalRatio() function in the smart-order-router repo.
// We are always swapping token0 for token1 wrt "amount0" and "amount1" below.
//   https://github.com/Uniswap/smart-order-router/blob/3e4b8ba06f78930a7310ca7880df136592c98549/src/routers/alpha-router/alpha-router.ts#L1444
export function calculateOptimalRatio(tickLower: number, tickUpper: number, tickCurrent: number): Fraction {
    const lowerSqrtRatioX96 = TickMath.getSqrtRatioAtTick(tickLower)
    const upperSqrtRatioX96 = TickMath.getSqrtRatioAtTick(tickUpper)

    const sqrtRatioX96 = TickMath.getSqrtRatioAtTick(tickCurrent)

    const precision = JSBI.BigInt('1' + '0'.repeat(18))

    const optimalRatio = new Fraction(
      SqrtPriceMath.getAmount0Delta(
        sqrtRatioX96,
        upperSqrtRatioX96,
        precision,
        true
      ),
      SqrtPriceMath.getAmount1Delta(
        sqrtRatioX96,
        lowerSqrtRatioX96,
        precision,
        true
      )
    )

    return optimalRatio
}

// This is functionally verbatim from:
//   https://github.com/Uniswap/smart-order-router/blob/main/src/routers/alpha-router/functions/calculate-ratio-amount-in.ts
// but this function is not exported by that module. License is GPL v3.
export function calculateRatioAmountIn(
    optimalRatio: Fraction,
    inputTokenPrice: Fraction,
    inputBalance: CurrencyAmount,
    outputBalance: CurrencyAmount
  ): CurrencyAmount {
    // formula: amountToSwap = (inputBalance - (optimalRatio * outputBalance)) / ((optimalRatio * inputTokenPrice) + 1))
    const amountToSwapRaw = new Fraction(inputBalance.quotient)
        .subtract(optimalRatio.multiply(outputBalance.quotient))
        .divide(optimalRatio.multiply(inputTokenPrice).add(1));

    if (amountToSwapRaw.lessThan(0)) {
        // should never happen since we do checks before calling in
        throw new Error('calculateRatioAmountIn: insufficient input token amount');
    }

    return CurrencyAmount.fromRawAmount(
        inputBalance.currency,
        amountToSwapRaw.quotient
    );
}

export function calculateRatioAmountInWithDebugging(
  optimalRatio: Fraction,
  inputTokenPrice: Fraction,
  inputBalance: CurrencyAmount,
  outputBalance: CurrencyAmount
): CurrencyAmount {
    // Swapping USDC to WETH
    // calculateRatioAmountIn() inputTokenPrice: 0.00033484
    // calculateRatioAmountIn() inputBalance.quotient: 1_511_316_988 (1511.31 USDC)
    // calculateRatioAmountIn() outputBalance.quotient: 148_525_588_264_069_585 (0.148 WETH)
    // calculateRatioAmountIn() inputQuotient: 1_511_316_988
    // calculateRatioAmountIn() optimalRatio multiplied by output balance quotient: 29872368485216593065608194.81148793
    // calculateRatioAmountIn() optimalRatio multiplied by input token price: 67344886988928548.57381418
    // calculateRatioAmountIn() denominator: 67344886988928548.57381418
    // calculateRatioAmountIn() numerator: -29872368485216591554291206.81148793
    // calculateRatioAmountIn() amountToSwapRaw2: -443572924.69920674
    
  log.info(`calculateRatioAmountIn() inputTokenPrice: ${inputTokenPrice.toFixed(8)}`)
  log.info(`calculateRatioAmountIn() inputBalance.quotient: ${inputBalance.quotient}`)
  log.info(`calculateRatioAmountIn() outputBalance.quotient: ${outputBalance.quotient}`) // 0

  // TODO: Our optimal ratio looks fine, but the amount to swap can be negative if optimalRatio * outputBalance > inputBalance
  // Consider:
  //   Not using this function and solving the simultaneous equation in code.
  //   Solving iteratively by increasing the input amount 1 USDC or 0.0001 ETH at a time using a Position instace.
  //   Hit the author of this up for help: https://atiselsts.github.io/pdfs/uniswap-v3-liquidity-math.pdf
  //   Rounding the output balance down to zero when it is below some trivial amount. Pointless - it's when output balance is high that we're more likely to run into a negative swap amount.
  // Done:
  //   Opening a bug on the smart-order-router SDK, with valid inputs

  // 1_998_121_297
  const inputQuotient = new Fraction(inputBalance.quotient)
  log.info(`calculateRatioAmountIn() inputQuotient: ${inputQuotient.toFixed(0)}`)

  // 39_476_363_836.45253787
  const optimalRatioByOutputBalanceQuotient = optimalRatio.multiply(outputBalance.quotient)
  log.info(`calculateRatioAmountIn() optimalRatio multiplied by output balance quotient: ${optimalRatioByOutputBalanceQuotient.toFixed(8)}`)

  const optimalRatioByInputTokenPrice = optimalRatio.multiply(inputTokenPrice)
  log.info(`calculateRatioAmountIn() optimalRatio multiplied by input token price: ${optimalRatioByInputTokenPrice.toFixed(8)}`)

  const denominator = optimalRatioByInputTokenPrice.add(1)
  log.info(`calculateRatioAmountIn() denominator: ${optimalRatioByInputTokenPrice.toFixed(8)}`)

  // 1_998_121_297 - 39_476_363_836
  const numerator = inputQuotient.subtract(optimalRatioByOutputBalanceQuotient)
  log.info(`calculateRatioAmountIn() numerator: ${numerator.toFixed(8)}`)

  const amountToSwapRaw2 = numerator.divide(denominator)
  log.info(`calculateRatioAmountIn() amountToSwapRaw2: ${amountToSwapRaw2.toFixed(8)}`)

  // formula: amountToSwap = (inputBalance - (optimalRatio * outputBalance)) / ((optimalRatio * inputTokenPrice) + 1))
  let amountToSwapRaw = new Fraction(inputBalance.quotient)
    .subtract(optimalRatio.multiply(outputBalance.quotient))
    .divide(optimalRatio.multiply(inputTokenPrice).add(1))

  if (amountToSwapRaw.lessThan(0)) {
    // Try inverting the optimal ratio
    const optimalRatioInverted = optimalRatio.invert()

    amountToSwapRaw = new Fraction(inputBalance.quotient)
        .subtract(optimalRatioInverted.multiply(outputBalance.quotient))
        .divide(optimalRatioInverted.multiply(inputTokenPrice).add(1))

    if (amountToSwapRaw.lessThan(0)) {
        throw new Error('calculateRatioAmountIn(): insufficient input token amount, even after inverting optimal ratio')
    }
  }

  return CurrencyAmount.fromRawAmount(
    inputBalance.currency,
    amountToSwapRaw.quotient
  )
}

export async function createPoolOnTestnet() {
    if (!CHAIN_CONFIG.isTestnet) {
        throw 'Not on a testnet'
    }

    // 0.30%
    const fee: number = 3000

    // Run `ts-node src/index.ts --monitor` to get some suitable starting values for these from the
    // existing pool on mainnet.
    // These were at a USDC price of 4,604.00.
    const sqrtRatioX96: string = '1167653694127320251748170330430894' // Expects BigintIsh
    const liquidity: string = '17794964695224007502' // Expects BigintIsh
    const tickCurrent: number = 191973

    const newPool = new Pool(
        TOKEN_USDC,
        TOKEN_WETH,
        fee,
        sqrtRatioX96,
        liquidity,
        tickCurrent
    )

    // Observed on a manually created position, therefore valid.
    const minTick: number = 191580
    const maxTick: number = 195840

    await wallet.logBalances()

//     const availableUsdc = (await wallet.usdc()).toString()
//     const availableWeth = (await wallet.weth()).toString()
//     const availableEth = (await wallet.getBalance()).toString()
//     log.info(`createPoolOnTestnet(): Amounts available: ${availableUsdc} USDC, ${availableWeth} WETH, \
// ${availableEth} ETH`)

    // Eyeball these and make sure they're within our available amounts logged above and that we
    // have enough for gas.

    // 500 USDC, 6 decimals
    const amountUsdc = '500000000'

    // ~0.1 WETH, 18 decimals. Works for the above price of 4,604.00 USDC.
    const amountWeth = '10860121633000000'

    const position = Position.fromAmounts({
        pool: newPool,
        tickLower: minTick,
        tickUpper: maxTick,
        amount0: amountUsdc,
        amount1: amountWeth,
        useFullPrecision: true
    })

    const mintOptions: MintOptions = {
        slippageTolerance: CHAIN_CONFIG.slippageTolerance,
        deadline: moment().unix() + DEADLINE_SECONDS,
        recipient: wallet.address,
        createPool: true
    }

    // addCallParameters() implementation:
    //   https://github.com/Uniswap/v3-sdk/blob/6c4242f51a51929b0cd4f4e786ba8a7c8fe68443/src/nonfungiblePositionManager.ts#L164
    // Don't bother logging the calldata. It'll be on the txResponse instance below.
    const { calldata, value } = NonfungiblePositionManager.addCallParameters(position, mintOptions)
  
    const nonce = await wallet.getTransactionCount("latest")

    // This is a testnet. Low ball the gas price.
    const gasPriceBid = ethers.utils.parseUnits("2", "gwei").toBigInt()
  
    // Sending WETH, not ETH, so value is zero here. WETH amount is in the call data.
    const txRequest = {
        from: wallet.address,
        to: CHAIN_CONFIG.addrPositionManager,
        value: VALUE_ZERO_ETHER,
        nonce: nonce,
        gasLimit: CHAIN_CONFIG.gasLimit,
        gasPrice: gasPriceBid,
        data: calldata
    }

    // Send the transaction to the provider.
    const txResponse: TransactionResponse = await wallet.sendTransaction(txRequest)

    log.info(`createPoolOnTestnet() TX response:`)
    console.dir(txResponse)

    // log.info(`createPoolOnTestnet() Max fee per gas: ${txResponse.maxFeePerGas?.toString()}`) // 100_000_000_000 wei or 100 gwei
    // log.info(`createPoolOnTestnet() Gas limit: ${txResponse.gasLimit?.toString()}`) // 450_000

    const txReceipt: TransactionReceipt = await txResponse.wait()

    log.info(`createPoolOnTestnet() TX receipt:`)
    console.dir(txReceipt)

    // If we get a revert with `Fail with error: 'STF'` here, STF is `safe transfer from` and this
    // is thrown by:
    //   https://github.com/Uniswap/v3-periphery/blob/9ca9575d09b0b8d985cc4d9a0f689f7a4470ecb7/contracts/libraries/TransferHelper.sol#L21
    // We need to approve the position manager contract to spend the tokens.

    // Otherwise, check etherscan for the logs from this tx. There should be a pool address in
    // there. Put that in the config for this testnet.
}

// Get the token ID of the last position, as long as it's still open (ie. has non zero liquidity).
// We only have one position open at a time, so the last one is the current, open one.
async function currentTokenId(address: string): Promise<number | undefined> {
    // This count includes all the closed positions.
    const positionCount = await positionManagerContract.balanceOf(address)

    if (positionCount == 0) {
        return undefined
    }

    const tokenId = await positionManagerContract.tokenOfOwnerByIndex(address, positionCount - 1)

    // Get the liquidity of this position
    const position: Position = await positionManagerContract.positions(tokenId)

    // Check for zero liquidity in the position
    // This has been tested with an account with only old, closed positions.
    if (JSBI.EQ(JSBI.BigInt(0), JSBI.BigInt(position.liquidity))) {
        // log.info(`currentTokenId(): Existing position with token ID ${tokenId} has no liquidity.\
 // Ignoring position.`)

        return undefined
    }

    return tokenId
}

async function usePool(poolContract: ethers.Contract): Promise<[Pool, boolean]> {
    // Do NOT call these once on startup. They need to be called every time we use the pool.
    const [liquidity, slot, fee, tickSpacing] = await Promise.all([
        poolContract.liquidity(),
        poolContract.slot0(),
        poolContract.fee(),
        poolContract.tickSpacing()
    ])

    // The fee in the pool determines the tick spacing and if it's zero, the tick spacing will be
    // undefined. This will throw an error when the position gets created.
    if (fee == 0) throw `No fee. WTF.`
    if (tickSpacing == 0) throw `No tick spacing. WTF.`

    // Do NOT pass a strings for these parameters below! JSBI does very little type checking.
    const sqrtRatioX96AsJsbi = JSBI.BigInt(slot[0].toString())
    const liquidityAsJsbi = JSBI.BigInt(liquidity.toString())

    // The order of the tokens in the pool varies from chain to chain, annoyingly.
    // Ethereum mainnet: USDC is first
    // Arbitrum mainnet: WETH is first
    const wethFirst: boolean = await tokenOrderIsWethFirst(poolContract)

    let token0: Token
    let token1: Token

    if (wethFirst) {
        token0 = TOKEN_WETH
        token1 = TOKEN_USDC
    }
    else {
        token0 = TOKEN_USDC
        token1 = TOKEN_WETH
    }

    const pool = new Pool(
        token0,
        token1,
        fee,
        sqrtRatioX96AsJsbi,
        liquidityAsJsbi,
        slot[1] // tickCurrent
    )

    return [pool, wethFirst]
}