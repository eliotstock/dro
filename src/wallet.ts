import { ethers } from 'ethers'
import { BigNumber } from '@ethersproject/bignumber'
import { abi as ERC20ABI } from './abi/erc20.json'

export function useWallet(provider: ethers.providers.Provider): ethers.Wallet {
    // Check .env file and create Ethers.js wallet from mnemonic in it.
    const mnemonic = process.env.DRO_ACCOUNT_MNEMONIC

    if (mnemonic == undefined) {
      console.error("No .env file or no mnemonic in it. If you need one for testing, try this one.")
      const randomWallet = ethers.Wallet.createRandom()
      console.error(randomWallet.mnemonic.phrase)
      process.exit()
    }
  
    // Account that will hold the Uniswap v3 position NFT
    let wallet: ethers.Wallet = ethers.Wallet.fromMnemonic(mnemonic)
    wallet = wallet.connect(provider)
    console.log("DRO account: ", wallet.address)

    return wallet
}

export async function getUsdcBalance(chainConfig: any, wallet: ethers.Wallet): Promise<number> {
    const usdcContract = new ethers.Contract(
        chainConfig.addrTokenUsdc,
        ERC20ABI,
        chainConfig.provider()
    )

    const balance = await usdcContract.balanceOf(wallet.address)

    // USDC has 6 decimals. We should really get this from the contract but it's another call and
    // our ABI is incomplete.
    return balance.div(BigNumber.from(10).pow(6)).toNumber()
}

export async function getWethBalance(chainConfig: any, wallet: ethers.Wallet): Promise<number> {
    const wethContract = new ethers.Contract(
        chainConfig.addrTokenWeth,
        ERC20ABI,
        chainConfig.provider()
    )

    const balance = await wethContract.balanceOf(wallet.address)

    // WETH has 18 decimals. Ditto the above.
    return balance.div(BigNumber.from(10).pow(18)).toNumber()
}
