import { ethers } from 'ethers'
import { abi as IUniswapV3PoolABI } from '@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json'
import { tickToPrice } from '@uniswap/v3-sdk'
import { Token } from '@uniswap/sdk-core'
import moment from 'moment'

const TIMESTAMP_FORMAT = 'YYYY-MM-DD HH:mm:ss'

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

    const usdcAddress = await poolContract.token0()

    const wethAddress = await poolContract.token1()

    // console.log(`USDC: ${usdcAddress}, WETH: ${wethAddress}`)

    const usdc = new Token(chainConfig.chainId, usdcAddress, 6, "USDC", "USD Coin")

    const weth = new Token(chainConfig.chainId, wethAddress, 18, "WETH", "Wrapped Ether")

    poolContract.on('Swap', (sender, recipient, amount0, amount1, sqrtPriceX96, liquidity, tick) => {
        // ticktoPrice() implementation:
        //   https://github.com/Uniswap/v3-sdk/blob/main/src/utils/priceTickConversions.ts#L14
        const price: string = tickToPrice(weth, usdc, tick).toFixed(2)

        const timestamp = moment()
        console.log(`${timestamp.format(TIMESTAMP_FORMAT)} ${price}`)
    })
}
