import { config } from 'dotenv'
import { ethers } from 'ethers'
import { abi as IUniswapV3PoolABI } from '@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json'
import { abi as QuoterABI } from '@uniswap/v3-periphery/artifacts/contracts/lens/Quoter.sol/Quoter.json'
import { abi as NonfungiblePositionManagerABI } from '@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json'
import { tickToPrice, Pool, Position, MintOptions, NonfungiblePositionManager, FeeAmount, toHex, Multicall } from '@uniswap/v3-sdk'
import { TransactionResponse, TransactionReceipt } from '@ethersproject/abstract-provider'
import { useConfig, ChainConfig } from './config'
import { BigintIsh, CurrencyAmount, Token } from '@uniswap/sdk-core'
import { wallet } from './wallet'
import moment from 'moment'
import JSBI from 'jsbi'

// Read our .env file
config()

// Static config that doesn't belong in the .env file.
const CHAIN_CONFIG: ChainConfig = useConfig()

export let rangeOrderPoolTick: number
export let rangeOrderPoolPriceUsdc: string

// On all transactions, set the deadline to 3 minutes from now
export const DEADLINE_SECONDS = 180

export const VALUE_ZERO_ETHER = ethers.utils.parseEther("0")

// This is what `await rangeOrderPoolContract.tickSpacing()` would return, but we want to avoid
// the await.
export const rangeOrderPoolTickSpacing: number = 60 // ticks (bps)

export const rangeOrderPoolContract = new ethers.Contract(
    CHAIN_CONFIG.addrPoolRangeOrder,
    IUniswapV3PoolABI,
    CHAIN_CONFIG.provider()
)

export const swapPoolContract = new ethers.Contract(
    CHAIN_CONFIG.addrPoolSwaps,
    IUniswapV3PoolABI,
    CHAIN_CONFIG.provider()
)

export const quoterContract = new ethers.Contract(
    CHAIN_CONFIG.addrQuoter,
    QuoterABI,
    CHAIN_CONFIG.provider()
)

export const positionManagerContract = new ethers.Contract(
    CHAIN_CONFIG.addrPositionManager,
    NonfungiblePositionManagerABI,
    CHAIN_CONFIG.provider()
)

export const usdcToken = new Token(CHAIN_CONFIG.chainId,
    CHAIN_CONFIG.addrTokenUsdc,
    6, // Decimals
    'USDC',
    'USD Coin')

export const wethToken = new Token(CHAIN_CONFIG.chainId,
    CHAIN_CONFIG.addrTokenWeth,
    18, // Decimals
    'WETH',
    'Wrapped Ether')

export async function updateTick() {
    const slot = await rangeOrderPoolContract.slot0()

    rangeOrderPoolTick = slot[1]

    if (rangeOrderPoolTick) {
        // tickToPrice() returns a Price<Token, Token> which extends Fraction in which numerator
        // and denominator are both JSBIs.
        rangeOrderPoolPriceUsdc = tickToPrice(wethToken, usdcToken, rangeOrderPoolTick).toFixed(2)
    }
}

// Every range order pool we use has WETH as one token and USDC as the other, but the order varies
// from mainnet to Arbitrum, annoyingly.
export async function tokenOrderIsWethFirst(): Promise<boolean> {
    const token0 = await rangeOrderPoolContract.token0()
    const token1 = await rangeOrderPoolContract.token1()

    if (token0.toUpperCase() == CHAIN_CONFIG.addrTokenWeth.toUpperCase() &&
        token1.toUpperCase() == CHAIN_CONFIG.addrTokenUsdc.toUpperCase()) {
        // console.log(`Token order in the pool is 0: WETH, 1: USDC`)
        return true
    }
    else if (token0.toUpperCase() == CHAIN_CONFIG.addrTokenUsdc.toUpperCase() &&
        token1.toUpperCase() == CHAIN_CONFIG.addrTokenWeth.toUpperCase()) {
        // console.log(`Token order in the pool is 0: USDC, 1: WETH`)
        return false
    }
    else {
        throw 'Tokens in range order pool contract are not WETH and USDC. WTF.'
    }
}

// We store rangeOrderPoolPriceUsdc as a string, but it can be useful to have it as a BigNumber.
export function rangeOrderPoolPriceUsdcAsBigNumber(): ethers.BigNumber {
    if (!rangeOrderPoolPriceUsdc)
        throw 'Do not call rangeOrderPoolPriceUsdcAsBigNumber() before updateTick()'

    // We are not dealing with large integers for our USDC amounts, even once raised to 10^6.
    const usdcAsFloat: number = parseFloat(rangeOrderPoolPriceUsdc)
    const usdcTimesTenToTheSix: number = usdcAsFloat * 1_000_000

    // console.log(`usdcTimesTenToTheMinusSix: ${usdcTimesTenToTheMinusSix}`)
    // console.log(`usdcTimesTenToTheMinusSix rounded: ${Math.round(usdcTimesTenToTheMinusSix)}`)

    return ethers.BigNumber.from(Math.round(usdcTimesTenToTheSix))
}

export function rangeOrderPoolPriceUsdcAsJsbi(): JSBI {
    if (!rangeOrderPoolPriceUsdc)
        throw 'Do not call rangeOrderPoolPriceUsdcAsBigNumber() before updateTick()'

    // We are not dealing with large integers for our USDC amounts, even once raised to 10^6.
    const usdcAsFloat: number = parseFloat(rangeOrderPoolPriceUsdc)
    const usdcTimesTenToTheSix: number = usdcAsFloat * 1_000_000

    return JSBI.BigInt(usdcTimesTenToTheSix)
}

const TOPIC_0_INCREASE_LIQUIDITY = '0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f'

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

// The index passed in here increments up from 0. Older positions have lower tokens IDs and
// indices. Only the most recent token ID should have any liquidity.
/*
export async function firstTokenId(): Promise<number | undefined> {
    try {
        const tokenId = await positionManagerContract.tokenOfOwnerByIndex(wallet.address, 0)

        return tokenId
    }
    catch (error) {
        // This will be:
        //   reason: 'EnumerableSet: index out of bounds',
        //   code: 'CALL_EXCEPTION'
        return undefined
    }
}
*/

export async function positionByTokenId(tokenId: number, wethFirst: boolean): Promise<Position> {
    const position: Position = await positionManagerContract.positions(tokenId)

    // The Pool instance on the position at this point is sorely lacking. Replace it. Because all
    // the properties on the Position are readonly this means constructing a new one.

    const slot = await rangeOrderPoolContract.slot0()
    const liquidity = await rangeOrderPoolContract.liquidity()

    // The order of the tokens in the pool varies from chain to chain, annoyingly.
    //   Ethereum mainnet: USDC is first
    //   Arbitrum mainnet: WETH is first
    let token0
    let token1

    if (wethFirst) {
        token0 = wethToken
        token1 = usdcToken
    }
    else {
        token0 = usdcToken
        token1 = wethToken
    }

    // The fee in the pool determines the tick spacing and if it's zero, the tick spacing will be
    // undefined. This will throw an error when the position gets created.
    // invariant(slot[5] > 0, 'Pool has no fee')
    const fee = slot[5] > 0 ? slot[5] : FeeAmount.MEDIUM

    const usablePool = new Pool(
        token0,
        token1,
        fee,
        slot[0].toString(), // SqrtRatioX96
        liquidity.toString(), // Liquidity
        slot[1] // Tick
    )

    // console.log(`Tick lower, upper: ${position.tickLower}, ${position.tickUpper}`)

    // Note that in some previous versions of the Uniswap modules we used to have to replace the
    // position.liquidity property with a JSBI in order for removeCallParameters() to work. We no
    // longer need to, it seems.
    // const liquidityJsbi = JSBI.BigInt(position.liquidity)
    // console.log(`Position liquidity: ${liquidityJsbi.toString()}`)

    const usablePosition = new Position({
        pool: usablePool,
        liquidity: position.liquidity,
        tickLower: position.tickLower,
        tickUpper: position.tickUpper
    })

    return usablePosition
}

export function positionWebUrl(tokenId: number): string {
    return `https://app.uniswap.org/#/pool/${tokenId}`
}

// Simplified fork of Uniswap's NonfungiblePositionManager.removeCallParameters(), which has given
// us grief in the past (liquidity in call params higher than position liquidity). We always want
// remove 100% of our liquidity.
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
        usdcToken,
        wethToken,
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
//     console.log(`createPoolOnTestnet(): Amounts available: ${availableUsdc} USDC, ${availableWeth} WETH, \
// ${availableEth} ETH`)

    // Eyeball these and make sure they're within our available amounts logged above and that we
    // have enough for gas.
    // Ethers.js uses its own BigNumber but Uniswap expects a JSBI, or a string. A String is easier.

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

    console.log(`createPoolOnTestnet() TX response:`)
    console.dir(txResponse)

    // console.log(`createPoolOnTestnet() Max fee per gas: ${txResponse.maxFeePerGas?.toString()}`) // 100_000_000_000 wei or 100 gwei
    // console.log(`createPoolOnTestnet() Gas limit: ${txResponse.gasLimit?.toString()}`) // 450_000

    const txReceipt: TransactionReceipt = await txResponse.wait()

    console.log(`createPoolOnTestnet() TX receipt:`)
    console.dir(txReceipt)

    // If we get a revert with `Fail with error: 'STF'` here, STF is `safe transfer from` and this
    // is thrown by:
    //   https://github.com/Uniswap/v3-periphery/blob/9ca9575d09b0b8d985cc4d9a0f689f7a4470ecb7/contracts/libraries/TransferHelper.sol#L21
    // We need to approve the position manager contract to spend the tokens.

    // Otherwise, check etherscan for the logs from this tx. There should be a pool address in
    // there. Put that in the config for this testnet.
}
