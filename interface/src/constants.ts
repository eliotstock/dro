import { config } from 'dotenv'
import { ethers } from 'ethers'
import { abi as NonfungiblePositionManagerABI }
    from '@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json'
import { abi as WethABI } from './abi/weth.json'
import { abi as Erc20ABI } from './abi/erc20.json'
import { Token } from '@uniswap/sdk-core'

const CHAIN_ID = 1

// Uniswap v3 positions NFT.
// Address field for filter requires this in all lowercase.
export const ADDR_POSITIONS_NFT_FOR_FILTER = '0xc36442b4a4522e871399cd717abdd847ab11fe88'
// Logs from provider have the case mostly, but not all, in caps (checksum case?)
export const ADDR_POSITIONS_NFT_FOR_LOGS = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88'

// WETH (checksum case)
export const ADDR_TOKEN_WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'

// USDC (checksum case)
export const ADDR_TOKEN_USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'

// Topics. Logs from provider have these all in lower case.
export const TOPIC_MINT = '0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde'
export const TOPIC_BURN = '0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c'
export const TOPIC_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
export const TOPIC_DECREASE_LIQUIDITY = '0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4'
export const TOPIC_INCREASE_LIQUIDITY = '0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f'
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
