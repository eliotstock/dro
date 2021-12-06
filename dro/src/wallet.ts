import { config } from 'dotenv'
import { ethers } from 'ethers'
import { TransactionResponse, TransactionReceipt } from '@ethersproject/abstract-provider'
import { Provider } from "@ethersproject/abstract-provider";
import { ExternallyOwnedAccount } from "@ethersproject/abstract-signer";
import { SigningKey } from "@ethersproject/signing-key";
import { BigNumber } from '@ethersproject/bignumber'
import { abi as ERC20ABI } from './abi/erc20.json'
import { abi as WETHABI } from './abi/weth.json'
import { useConfig, ChainConfig } from './config'

// Read our .env file
config()

// Static config that doesn't belong in the .env file.
const CHAIN_CONFIG: ChainConfig = useConfig()

export let gasPrice: ethers.BigNumber

class EthUsdcWallet extends ethers.Wallet {

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
            WETHABI,
            chainConfig.provider()
        )

        let w = new EthUsdcWallet(usdcContract, wethContract, s.privateKey, chainConfig.provider())

        // Contracts need to be connected to a signer, not just a provider, in order to call
        // approve() on them. connect() returns a connected wallet but has no effect on the
        // wallet on which it is called.
        w.usdcContract = w.usdcContract.connect(w)
        w.wethContract = w.wethContract.connect(w)

        console.log(`DRO account: ${w.address}`)

        return w
    }

    async usdc(): Promise<BigNumber> {
        return await this.usdcContract.balanceOf(this.address)
    }

    async weth(): Promise<BigNumber> {
        return await this.wethContract.balanceOf(this.address)
    }

    async logBalances() {
        const [usdcBalance, wethBalance, ethBalance] =
            await Promise.all([
                this.usdc(),
                this.weth(),
                await this.getBalance("latest"),
            ])

        // USDC has 6 decimals. We should really get this from the contract but it's another call and
        // our ABI is incomplete.
        // WETH has 18 decimals, just like Ether.

        // Formatting to a goiven number of decimal places is fiddly. We are truncating here, not
        // rounding.
        const usdcBalanceReadable = ethers.utils.formatUnits(
            usdcBalance.sub(usdcBalance.mod(1e4)), 6)

        const wethBalanceReadable = ethers.utils.formatEther(
            wethBalance.sub(wethBalance.mod(1e14)))

        const ethBalanceReadable = ethers.utils.formatEther(
            ethBalance.sub(ethBalance.mod(1e14)))

        console.log(`Balances: USDC ${usdcBalanceReadable}, WETH ${wethBalanceReadable}, \
ETH ${ethBalanceReadable}`)
    }

    async approveAll(address: string) {
        // TODO: Add allowance() method to ABI and call it first. That should cost no gas. Only call
        // approve() when we need to.
        // console.log("Approving spending of max USDC")
        const txResponseUsdc: TransactionResponse = await this.usdcContract.approve(address, ethers.constants.MaxUint256)
        // console.dir(txResponseUsdc)
        const txReceiptUsdc: TransactionReceipt = await txResponseUsdc.wait()
        // console.dir(txReceiptUsdc)

        // console.log("Approving spending of max WETH")
        const txResponseWeth: TransactionResponse = await this.wethContract.approve(address, ethers.constants.MaxUint256)
        // console.dir(txResponseWeth)
        const txReceiptWeth: TransactionReceipt = await txResponseWeth.wait()
        // console.dir(txReceiptWeth)
    }

    async wrapEth(ethAmount: string) {
        console.log(`Wrapping ${ethAmount} ETH to WETH`)

        const nonce = await this.getTransactionCount("latest")

        const txRequest = {
            from: this.address,
            to: this.wethContract.address,
            value: ethers.utils.parseEther(ethAmount),
            nonce: nonce,
            gasLimit: CHAIN_CONFIG.gasLimit,
            gasPrice: CHAIN_CONFIG.gasPrice,
        }

        const txResponse: TransactionResponse = await wallet.sendTransaction(txRequest)
        console.log(`TX response`)
        console.dir(txResponse)

        const txReceipt: TransactionReceipt = await txResponse.wait()
        console.log(`TX receipt`)
        console.dir(txReceipt)
    }
}

export const wallet = EthUsdcWallet.createFromEnv(CHAIN_CONFIG)

// We use the legacy gas price as a reference, just like everybody else seems to be doing. The new
// EIP-1559 maxFeePerGas seems to come in at about twice the value.
export async function updateGasPrice() {
    // These API calls are costly. Avoid them on L2 where we don't care so much about gas.
    // TODO: At least, they were too costly on Infura. Try them again on Alchemy?
    if (CHAIN_CONFIG.isL2) {
        return
    }

    // Legacy gas price.
    const p = (await CHAIN_CONFIG.provider().getFeeData()).gasPrice

    // Max fee per gas is the newer EIP-1559 measure of gas price (or more correctly one of them)
    // const maxFeePerGas = (await CHAIN_CONFIG.provider().getFeeData()).maxFeePerGas

    if (!p) return

    // console.log(`Gas prices: legacy: ${gasPrice}, EIP-1559: ${maxFeePerGas}`)

    // gasPriceInGwei = gasPrice.div(1e9).toNumber()

    // console.log(`  Gas price in gwei: ${gasPriceInGwei}`)

    gasPrice = p
}
