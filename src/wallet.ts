import { ethers } from 'ethers'
import { Provider } from "@ethersproject/abstract-provider";
import { ExternallyOwnedAccount } from "@ethersproject/abstract-signer";
import { SigningKey } from "@ethersproject/signing-key";
import { BigNumber } from '@ethersproject/bignumber'
import { abi as ERC20ABI } from './abi/erc20.json'

export class EthUsdcWallet extends ethers.Wallet {

    usdcContract: ethers.Contract
    wethContract: ethers.Contract

    constructor(
        _usdcContract: ethers.Contract,
        _wethContract: ethers.Contract,
        _privateKey: ethers.BytesLike | ExternallyOwnedAccount | SigningKey,
        _provider?: Provider) {
        super(_privateKey, _provider)

        this.usdcContract = _usdcContract
        this.wethContract = _wethContract
    }

    static createFromEnv(chainConfig: any): EthUsdcWallet {
        // Check .env file and create Ethers.js wallet from mnemonic in it.
        const mnemonic = process.env.DRO_ACCOUNT_MNEMONIC

        if (mnemonic == undefined) {
            console.error("No .env file or no mnemonic in it. If you need one for testing, try this one.")
            const randomWallet = ethers.Wallet.createRandom()
            console.error(randomWallet.mnemonic.phrase)
            process.exit()
        }

        const s: ethers.Wallet = super.fromMnemonic(mnemonic)

        const usdcContract = new ethers.Contract(
            chainConfig.addrTokenUsdc,
            ERC20ABI,
            chainConfig.provider()
        )

        const wethContract = new ethers.Contract(
            chainConfig.addrTokenWeth,
            ERC20ABI,
            chainConfig.provider()
        )

        let w = new EthUsdcWallet(usdcContract, wethContract, s.privateKey, chainConfig.provider())

        // Contracts need to be connected to a signer, not just a provider, in order to call
        // approve() on them. connect() returns a connected wallet but has no effect on the
        // wallet on which it is called.
        w.usdcContract = w.usdcContract.connect(w)
        w.wethContract = w.wethContract.connect(w)

        console.log("DRO account: ", w.address)

        return w
    }

    async usdc(): Promise<BigNumber> {
        return await this.usdcContract.balanceOf(this.address)
    }

    async weth(): Promise<BigNumber> {
        return await this.wethContract.balanceOf(this.address)
    }

    async logBalances() {
        let [usdcBalance, wethBalance, ethBalance] =
            await Promise.all([
                this.usdc(),
                this.weth(),
                await this.getBalance("latest"),
            ])

        console.log("Balances:")

        // USDC has 6 decimals. We should really get this from the contract but it's another call and
        // our ABI is incomplete.
        console.log("  USDC ", usdcBalance.div(BigNumber.from(10).pow(6)).toString())

        // WETH has 18 decimals.
        console.log("  WETH ", wethBalance.div(BigNumber.from(10).pow(18)).toString())

        console.log("  ETH ", ethers.utils.formatEther(ethBalance))
    }

    async approveAll() {
        // TODO: Add allowance() method to ABI and call it first. That should cost no gas. Only call
        // approve() when we need to.
        console.log("Approving spending of max USDC")
        await this.usdcContract.approve(this.address, ethers.constants.MaxUint256)

        console.log("Approving spending of max WETH")
        await this.wethContract.approve(this.address, ethers.constants.MaxUint256)
    }
}
