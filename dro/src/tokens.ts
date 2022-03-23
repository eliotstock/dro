import { config } from 'dotenv'
import { useConfig, ChainConfig } from './config'
import { Token } from '@uniswap/sdk-core'

// Read our .env file
config()

// Static config that doesn't belong in the .env file.
const CHAIN_CONFIG: ChainConfig = useConfig()

export const TOKEN_USDC = new Token(CHAIN_CONFIG.chainId,
    CHAIN_CONFIG.addrTokenUsdc,
    6, // Decimals
    'USDC',
    'USD Coin')

export const TOKEN_WETH = new Token(CHAIN_CONFIG.chainId,
    CHAIN_CONFIG.addrTokenWeth,
    18, // Decimals
    'WETH',
    'Wrapped Ether')
