import { config } from 'dotenv'
import { ethers } from 'ethers'
import { Percent } from '@uniswap/sdk-core'
import { BigNumber } from '@ethersproject/bignumber'
import { JsonRpcProvider } from '@ethersproject/providers'

// Read our .env file
config()

export interface ChainConfig {
    name: string
    chainId: number
    isTestnet: boolean
    endpoint: string
    provider(): JsonRpcProvider
    addrTokenUsdc: string
    addrTokenWeth: string
    addrPoolRangeOrder: string
    addrPoolSwaps: string
    slippageTolerance: Percent
    gasPrice: BigNumber
    gasPriceMax: number
    addrPositionManager: string
    addrQuoter: string
    addrSwapRouter: string
    gasLimit: string
}

const ETHEREUM_MAINNET: ChainConfig = {
    name: "Ethereum Mainnet",

    chainId: 1,

    isTestnet: false,

    // My personal Infura project (dro). Free quota is 100K requests per day, which is more than one a second.
    // WSS doesn't work ("Error: could not detect network") and HTTPS works for event subscriptions anyway.
    endpoint: "https://mainnet.infura.io/v3/" + process.env.INFURA_PROJECT_ID,

    provider() {
        return new ethers.providers.JsonRpcProvider(this.endpoint)
    },

    addrTokenUsdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",

    addrTokenWeth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",

    // USDC/ETH pool with 0.3% fee: https://info.uniswap.org/#/pools/0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8
    // This is the pool into which we enter a range order. It is NOT the pool in which we execute swaps.
    // UI for adding liquidity to this pool: https://app.uniswap.org/#/add/ETH/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48/3000
    addrPoolRangeOrder: "0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8",

    // USDC/ETH pool with 0.05% fee: https://info.uniswap.org/#/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640
    // This is the pool in which we execute our swaps.
    addrPoolSwaps: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",

    slippageTolerance: new Percent(50, 10_000), // 0.005%

    // Units: wei. Ignored for EIP-1559 txs and will be set to null regardless of what we
    // specify here. Typical range: 30 - 200 gwei.
    gasPrice: ethers.utils.parseUnits("100", "gwei"),

    // The highest gas I've ever spent on a Uniswap v3 tx was an add liquidity tx at 405,000.
    gasLimit: ethers.utils.hexlify(450_000), // Sensible: 450_000

    // Above what gas price, in gwei, are we unwilling to re-range?
    gasPriceMax: 100, // We could be waiting a day or two for gas prices to drop at 100 here.

    addrPositionManager: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",

    addrQuoter: "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6",

    addrSwapRouter: "0xE592427A0AEce92De3Edee1F18E0157C05861564"
}

const ETHEREUM_KOVAN: ChainConfig = {
    name: "Ethereum Kovan",

    chainId: 42,

    isTestnet: true,

    endpoint: "https://kovan.infura.io/v3/" + process.env.INFURA_PROJECT_ID,

    provider() {
        return new ethers.providers.JsonRpcProvider(this.endpoint)
    },

    // This is our own USDC test contract. The deployer is the DRO account and has all the supply.
    addrTokenUsdc: "0x6aD91931622d2b60B95561BfE17646469bB6E670",

    addrTokenWeth: "0xd0A1E359811322d97991E03f863a0C30C2cF029C",

    // We created this pool ourselves, using uniswap.ts:createPoolOnTestnet().
    addrPoolRangeOrder: "0x36f114d17fdcf3df2a96b4ad317345ac62a6a6f7",

    // Would normally be different to the range order pool, but is the same on Kovan.
    addrPoolSwaps: "0x36f114d17fdcf3df2a96b4ad317345ac62a6a6f7",

    // Go crazy high here. We will probably be the only liquidity in the pool anyway.
    slippageTolerance: new Percent(1000, 100), // 1000%

    // Units: wei. Ignored for EIP-1559 txs and will be set to null regardless of what we
    // specify here. Typical range: 30 - 200 gwei.
    gasPrice: ethers.utils.parseUnits("100", "gwei"), // Sensible: 100

    // Go crazy high on testnets, where we need to create the pool and also we don't care about cost.
    gasLimit: ethers.utils.hexlify(10_000_000),

    // Above what gas price, in gwei, are we unwilling to re-range?
    gasPriceMax: 2, // 2 gwei is a typical gas price for Kovan.

    addrPositionManager: ETHEREUM_MAINNET.addrPositionManager,

    addrQuoter: ETHEREUM_MAINNET.addrQuoter,

    addrSwapRouter: ETHEREUM_MAINNET.addrSwapRouter
}

const CHAIN_CONFIGS = {
    'ethereumMainnet': ETHEREUM_MAINNET,
    'ethereumKovan': ETHEREUM_KOVAN
}

export function useConfig(): ChainConfig {
    if (process.env.INFURA_PROJECT_ID == undefined) throw "No INFURA_PROJECT_ID in .env file."

    if (process.env.CHAIN == undefined) throw "No CHAIN in .env file."

    const chain: string = process.env.CHAIN

    return (CHAIN_CONFIGS as any)[chain]
}
