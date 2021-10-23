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

    // Not chain-specific. All chains use the same value as Ethereum Mainnet.
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

    addrPositionManager: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",

    addrQuoter: "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6",

    addrSwapRouter: "0xE592427A0AEce92De3Edee1F18E0157C05861564",

    // The highest gas I've ever spent on a Uniswap v3 tx was an add liquidity tx at 405,000.
    gasLimit: ethers.utils.hexlify(450_000), // Sensible: 450_000
}

const ETHEREUM_KOVAN: ChainConfig = {
    name: "Ethereum Kovan",

    chainId: 42,

    isTestnet: true,

    endpoint: "https://kovan.infura.io/v3/" + process.env.INFURA_PROJECT_ID,

    provider() {
        return new ethers.providers.JsonRpcProvider(this.endpoint)
    },

    // I have 1K of this USDC on Kovan in a work account.
    addrTokenUsdc: "0xe22da380ee6b445bb8273c81944adeb6e8450422",

    addrTokenWeth: "0xd0A1E359811322d97991E03f863a0C30C2cF029C",

    // This can be found by querying the factory contract on Kovan in Etherscan:
    //   https://kovan.etherscan.io/address/0x1F98431c8aD98523631AE4a59f267346ea31F984#readContract
    // Use the two token addresses above. The pool with a fee of 3000 (for 0.30%),
    // 0x877BD57CAF5A8620f06E80688070f23f091dF3b1 has no liquidity, adding some is near
    // impossible from Etherscan and there's no dapp on Kovan.
    // The 0.05% fee pool has liquidity. Use that instead.
    // If that fails consider creating a new pool with a different USDC contract:
    //   https://github.com/Uniswap/v3-core/blob/v1.0.0/contracts/UniswapV3Factory.sol#L35
    addrPoolRangeOrder: "0xD31910c6aeAEF00F51C9e0f4F5Dca102f94F7cF5",

    // Would normally be different to the range order pool, but is the same on Kovan.
    addrPoolSwaps: "0xD31910c6aeAEF00F51C9e0f4F5Dca102f94F7cF5",

    slippageTolerance: new Percent(50, 10_000), // 0.005%

    // Units: wei. Ignored for EIP-1559 txs and will be set to null regardless of what we
    // specify here. Typical range: 30 - 200 gwei.
    gasPrice: ethers.utils.parseUnits("100", "gwei"), // Sensible: 100

    addrPositionManager: ETHEREUM_MAINNET.addrPositionManager,

    addrQuoter: ETHEREUM_MAINNET.addrQuoter,

    addrSwapRouter: ETHEREUM_MAINNET.addrSwapRouter,

    gasLimit: ETHEREUM_MAINNET.gasLimit
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
