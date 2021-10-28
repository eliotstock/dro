import { ethers } from 'ethers'
import { abi as IUniswapV3PoolABI } from '@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json'
import { tickToPrice } from '@uniswap/v3-sdk'
import { Token } from '@uniswap/sdk-core'

// Event emitted here:
//   https://github.com/Uniswap/v3-core/blob/main/contracts/UniswapV3Pool.sol#L786
// and defined here:
//   https://github.com/Uniswap/v3-core/blob/main/contracts/interfaces/pool/IUniswapV3PoolEvents.sol#L72
export async function monitor(chainConfig: any) {
    const poolContract = new ethers.Contract(
        chainConfig.addrPoolRangeOrder,
        IUniswapV3PoolABI,
        chainConfig.provider()
    )

    const usdc = new Token(chainConfig.chainId, (await poolContract.token0()), 6, "USDC", "USD Coin")

    const weth = new Token(chainConfig.chainId, (await poolContract.token0()), 18, "WETH", "Wrapped Ether")

    poolContract.on('Swap', (sender, recipient, amount0, amount1, sqrtPriceX96, liquidity, tick) => {
        const price: string = tickToPrice(weth, usdc, tick).toFixed(2)
        console.log(price)
    })
}
