import { config } from 'dotenv'
import { ethers } from 'ethers'
import JSBI from 'jsbi'
import { abi as IUniswapV3PoolABI } from '@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json'
import { abi as QuoterABI } from '@uniswap/v3-periphery/artifacts/contracts/lens/Quoter.sol/Quoter.json'
import { abi as NonfungiblePositionManagerABI } from '@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json'
import { tickToPrice, Pool, Position, MintOptions, NonfungiblePositionManager, FeeAmount } from '@uniswap/v3-sdk'
import { TransactionResponse, TransactionReceipt } from '@ethersproject/abstract-provider'
import { useConfig, ChainConfig } from './config'
import { Token } from '@uniswap/sdk-core'
import { wallet } from './wallet'
import moment from 'moment'

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
        rangeOrderPoolPriceUsdc = tickToPrice(wethToken, usdcToken, rangeOrderPoolTick).toFixed(2)
    }
}

export function rangeOrderPoolPriceUsdcAsBigNumber(): ethers.BigNumber {
    // TODO: Remove once tested:
    rangeOrderPoolPriceUsdc = '4000.00'

    // Ethers.js's BigNumber does not deal with decimals.
    const usdcAsFloat: number = parseFloat(rangeOrderPoolPriceUsdc)
    const usdcTimesTenToTheMinusSix: number = usdcAsFloat * 1_000_000

    return ethers.BigNumber.from(usdcTimesTenToTheMinusSix)
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

export async function positionByTokenId(tokenId: number): Promise<Position> {
    const position: Position = await positionManagerContract.positions(tokenId)

    // The Pool instance on the position at this point is sorely lacking. Replace it.
    // The liquidity property on the Position instance at this point is a BigNumber. We need a JSBI
    // in order for removeCallParameters() to work.
    const liquidityJsbi = JSBI.BigInt(position.liquidity)

    console.log(`Position liquidity: ${liquidityJsbi.toString()}`)

    const slot = await rangeOrderPoolContract.slot0()
    const liquidity = await rangeOrderPoolContract.liquidity()

    const usablePool = new Pool(
        usdcToken,
        wethToken,
        FeeAmount.MEDIUM, // Fee: 0.30%, TODO: Only force this on testnets.
        slot[0].toString(), // SqrtRatioX96
        liquidity.toString(), // Liquidity
        slot[1] // Tick
    )

    console.log(`Tick lower, upper: ${position.tickLower}, ${position.tickUpper}`)

    const usablePosition = new Position({
        pool: usablePool,
        liquidity: liquidityJsbi,
        tickLower: position.tickLower,
        tickUpper: position.tickUpper
    })

    return usablePosition
}

export function positionWebUrl(tokenId: number): string {
    return `https://app.uniswap.org/#/pool/${tokenId}`
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
