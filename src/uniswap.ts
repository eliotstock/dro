import { config } from 'dotenv'
import { ethers } from 'ethers'
import { abi as IUniswapV3PoolABI } from "@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json"
import { abi as QuoterABI } from "@uniswap/v3-periphery/artifacts/contracts/lens/Quoter.sol/Quoter.json"
import { abi as NonfungiblePositionManagerABI } from "@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json"
import { tickToPrice } from "@uniswap/v3-sdk"
import { useConfig, ChainConfig } from './config'
import { Token } from '@uniswap/sdk-core'

// Read our .env file
config()

// Static config that doesn't belong in the .env file.
const CHAIN_CONFIG: ChainConfig = useConfig()

export let rangeOrderPoolTick: number
export let rangeOrderPoolPriceUsdc: string

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
