import { config } from 'dotenv'
import { ethers } from 'ethers'
import { Percent } from '@uniswap/sdk-core'

// Read our .env file
config()

// Note that the Uniswap interface codebase does something similar here:
//   https://github.com/Uniswap/interface/blob/main/src/constants/chainInfo.ts
// Does't seem worth extending this.

export interface ChainConfig {
    name: string
    chainId: number
    isTestnet: boolean
    isL2: boolean
    addrTokenUsdc: string
    addrTokenWeth: string
    addrPoolRangeOrder: string
    addrPoolSwaps: string
    slippageTolerance: Percent
    gasPriceMax: bigint
    gasPriceMaxFormatted(): string
    addrPositionManager: string
    addrQuoter: string
    addrSwapRouter: string
    addrSwapRouter2: string
    gasLimit: string
    ethBalanceMin: bigint
}

// Infura: Free quota is 100K requests per day, which is more than one a second.
// Alchemy: Free quota is 100M "compute units" per day. We seem to need only about 1M of these.
const ETHEREUM_MAINNET: ChainConfig = {
    name: 'Ethereum Mainnet',

    chainId: 1,

    isTestnet: false,

    isL2: false,

    addrTokenUsdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",

    addrTokenWeth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",

    // USDC/ETH pool with 0.05% fee.
    // This is the pool into which we enter our range order.
    addrPoolRangeOrder: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",

    // USDC/ETH pool with 0.05% fee.
    // This is the pool in which we execute our swaps.
    addrPoolSwaps: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",

    slippageTolerance: new Percent(5, 1_000), // 0.5%

    // Units: wei. Ignored for EIP-1559 txs and will be set to null regardless of what we
    // specify here. Typical range: 30 - 200 gwei.
    // gasPrice: ethers.utils.parseUnits("100", "gwei").toBigInt(),

    // The highest gas I've ever spent on a Uniswap v3 tx was an add liquidity tx at 405,000.
    gasLimit: ethers.utils.hexlify(450_000), // Sensible: 450_000

    // Above what gas price, in gwei, are we unwilling to re-range?
    // At 100, we could be waiting a day or two
    gasPriceMax: ethers.utils.parseUnits("200", "gwei").toBigInt(),

    gasPriceMaxFormatted() {
        return `${Number(this.gasPriceMax / 1_000_000_000n)} gwei`
    },

    addrPositionManager: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",

    addrQuoter: "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6",

    addrSwapRouter: "0xE592427A0AEce92De3Edee1F18E0157C05861564",

    addrSwapRouter2: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",

    // The most I've ever paid in gas for a set of three re-ranging transactions on L1 is
    // 0.168 ETH. 0.18 is a safe margin over that. Don't go too high here, because we
    // often unwrap a multiple of this amount to save on unwrapping tx costs.
    ethBalanceMin: ethers.utils.parseUnits("0.18", "ether").toBigInt()
}

// Block explorer: https://arbiscan.io/.
const ARBITRUM_MAINNET: ChainConfig = {
    name: 'Arbitrum Mainnet',

    chainId: 42161,

    isTestnet: false,

    isL2: true,

    addrTokenUsdc: '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8',

    addrTokenWeth: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',

    // USDC/ETH pool with 0.05% fee
    addrPoolRangeOrder: '0xc31e54c7a869b9fcbecc14363cf510d1c41fa443',

    // USDC/ETH pool with 0.05% fee
    addrPoolSwaps: '0xc31e54c7a869b9fcbecc14363cf510d1c41fa443',

    slippageTolerance: new Percent(10, 1_000), // 1.0%

    // Units: wei. Ignored for EIP-1559 txs and will be set to null regardless of what we
    // specify here. Typical range: 0.5 - 20 gwei.
    // gasPrice: ethers.utils.parseUnits("2", "gwei").toBigInt(),

    // The highest gas I've ever spent on a Uniswap v3 tx was an add liquidity tx at 405,000.
    // For the combined "swap and add liquidity" transaction, this could be twice that.
    gasLimit: ethers.utils.hexlify(2_000_000), // TX created, but fails: 2_000_000.

    // Above what gas price, in gwei, are we unwilling to re-range?
    // Gas on Arbitrum is very rarely so high that we'd want to wait to re-range, in practice.
    gasPriceMax: ethers.utils.parseUnits("20", "gwei").toBigInt(),

    gasPriceMaxFormatted() {
        return `${Number(this.gasPriceMax / 1_000_000_000n)} gwei`
    },

    // These are all at the same address as on Ethereum Mainnet.
    addrPositionManager: ETHEREUM_MAINNET.addrPositionManager,

    addrQuoter: ETHEREUM_MAINNET.addrQuoter,

    addrSwapRouter: ETHEREUM_MAINNET.addrSwapRouter,

    addrSwapRouter2: ETHEREUM_MAINNET.addrSwapRouter2,

    // The most I've ever paid in gas for a set of three re-ranging transactions on Arbitrum is
    // 0.010 ETH. 0.015 is a safe margin over that.
    ethBalanceMin: ethers.utils.parseUnits("0.015", "ether").toBigInt()
}

const ETHEREUM_KOVAN: ChainConfig = {
    name: "Ethereum Kovan",

    chainId: 42,

    isTestnet: true,

    isL2: false,

    // This is our own USDC test contract. The deployer is the DRO account and has all the supply.
    addrTokenUsdc: "0x6aD91931622d2b60B95561BfE17646469bB6E670",

    addrTokenWeth: "0xd0A1E359811322d97991E03f863a0C30C2cF029C",

    // We created this pool ourselves, using uniswap.ts:createPoolOnTestnet().
    addrPoolRangeOrder: "0x36f114d17fdcf3df2a96b4ad317345ac62a6a6f7",

    // Same pool as above.
    addrPoolSwaps: "0x36f114d17fdcf3df2a96b4ad317345ac62a6a6f7",

    // Go crazy high here. We will probably be the only liquidity in the pool anyway.
    slippageTolerance: new Percent(1000, 100), // 1000%

    // Units: wei. Ignored for EIP-1559 txs and will be set to null regardless of what we
    // specify here. Typical range: 30 - 200 gwei.
    // gasPrice: ethers.utils.parseUnits("100", "gwei").toBigInt(), // Sensible: 100

    // Go crazy high on testnets, where we need to create the pool and also we don't care about cost.
    gasLimit: ethers.utils.hexlify(10_000_000),

    // Above what gas price, in gwei, are we unwilling to re-range?
    gasPriceMax: ethers.utils.parseUnits("6", "gwei").toBigInt(), // 2 gwei is a typical gas price for Kovan.

    gasPriceMaxFormatted() {
        return `${Number(this.gasPriceMax / 1_000_000_000n)} gwei`
    },

    addrPositionManager: ETHEREUM_MAINNET.addrPositionManager,

    addrQuoter: ETHEREUM_MAINNET.addrQuoter,

    addrSwapRouter: ETHEREUM_MAINNET.addrSwapRouter,

    addrSwapRouter2: ETHEREUM_MAINNET.addrSwapRouter2,

    ethBalanceMin: ETHEREUM_MAINNET.ethBalanceMin
}

// Set the CHAIN env var to one of these keys.
const CHAIN_CONFIGS = {
    'ethereumMainnet': ETHEREUM_MAINNET,
    'ethereumKovan': ETHEREUM_KOVAN,
    'arbitrumMainnet': ARBITRUM_MAINNET
}

export function useConfig(): ChainConfig {
    if (process.env.CHAIN == undefined) throw 'No CHAIN in .env file, or no .env file.'

    const chain: string = process.env.CHAIN

    return (CHAIN_CONFIGS as any)[chain]
}

if (process.env.PROVIDER_URL == undefined) throw 'No PROVIDER_URL in .env file, or no .env file.'

const PROVIDER = new ethers.providers.JsonRpcProvider(process.env.PROVIDER_URL)

export function useProvider(): ethers.providers.JsonRpcProvider {
    return PROVIDER
}
