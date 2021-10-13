import { config } from 'dotenv'
import { ethers } from 'ethers'
import { Percent } from '@uniswap/sdk-core'

// Read our .env file
config()

export function useConfig() {
    if (process.env.INFURA_PROJECT_ID == undefined) throw "No INFURA_PROJECT_ID in .env file."

    const c = {
        ethereumMainnet: {
            chainId: 1,

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

            gasLimit: ethers.utils.hexlify(100_000),

            // TODO: This is probably quite wrong.
            gasPrice: ethers.utils.hexlify(100_000),

            slippageTolerance: new Percent(50, 10_000) // 0.005%
        },

        ethereumKovan: {
            chainId: 42,

            endpoint: "https://kovan.infura.io/v3/" + process.env.INFURA_PROJECT_ID,

            provider() {
                return new ethers.providers.JsonRpcProvider(this.endpoint)
            },

            addrTokenUsdc: "0xe22da380ee6b445bb8273c81944adeb6e8450422",

            addrTokenWeth: "0xd0A1E359811322d97991E03f863a0C30C2cF029C",

            // This can be found by querying the factory contract on Kovan in Etherscan:
            //   https://kovan.etherscan.io/address/0x1F98431c8aD98523631AE4a59f267346ea31F984#readContract
            // Use the two token addresses above and a fee of 3000 (for 0.30%)
            // TODO: This pool has no liquidity and a price of 0.00 USDC. Consider creating our own
            // pool just for testing by calling factory.createPool():
            //   https://github.com/Uniswap/v3-core/blob/v1.0.0/contracts/UniswapV3Factory.sol#L35
            addrPoolRangeOrder: "0x877BD57CAF5A8620f06E80688070f23f091dF3b1",

            // On Kovan there is no 0.05% pool for these tokens. Just use the 0.30% fee pool instead.
            addrPoolSwaps: "0x877BD57CAF5A8620f06E80688070f23f091dF3b1",

            gasLimit: ethers.utils.hexlify(100_000),

            // TODO: This is probably quite wrong.
            gasPrice: ethers.utils.hexlify(100_000),

            slippageTolerance: new Percent(50, 10_000) // 0.005%
        },

        // The rest of these contracts are deployed at the same address on all chains.
        // Reference: https://github.com/Uniswap/v3-periphery/blob/main/deploys.md

        addrPositionManager: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",

        addrQuoter: "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6",
    }
    
    return c
}
