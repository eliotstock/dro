import { config } from 'dotenv'
import { ethers } from 'ethers'
import { abi as NonfungiblePositionManagerABI }
    from '@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json'
import { abi as WethABI } from './abi/weth.json'
import { abi as Erc20ABI } from './abi/erc20.json'
import { Token } from '@uniswap/sdk-core'

const CHAIN_ID = 1

// Uniswap v3 positions NFT
export const ADDR_POSITIONS_NFT = '0xc36442b4a4522e871399cd717abdd847ab11fe88'

// WETH
export const ADDR_TOKEN_WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'

// USDC
export const ADDR_TOKEN_USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'

export const TOPIC_MINT = '0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde'
export const TOPIC_BURN = '0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c'
export const TOPIC_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
export const TOPIC_DECREASE_LIQUIDITY = '0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4'
export const TOPIC_SWAP = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'

export const INTERFACE_NFT = new ethers.utils.Interface(NonfungiblePositionManagerABI)
export const INTERFACE_WETH = new ethers.utils.Interface(WethABI)
export const INTERFACE_USDC = new ethers.utils.Interface(Erc20ABI)

export const TOKEN_USDC = new Token(CHAIN_ID, ADDR_TOKEN_USDC, 6, "USDC", "USD Coin")

export const TOKEN_WETH = new Token(CHAIN_ID, ADDR_TOKEN_WETH, 18, "WETH", "Wrapped Ether")

export const OUT_DIR = './out'

// Read our .env file
config()

export const ADDR_POOL: string = process.env.ADDR_POOL || 'no-pool'

if (ADDR_POOL == 'no-pool') throw 'No ADDR_POOL value in .env file.'
