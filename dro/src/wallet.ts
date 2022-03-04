import { config } from 'dotenv'
import { BigNumber, ethers } from 'ethers'
import { TransactionResponse, TransactionReceipt } from '@ethersproject/abstract-provider'
import { Provider } from "@ethersproject/abstract-provider";
import { ExternallyOwnedAccount } from "@ethersproject/abstract-signer";
import { SigningKey } from "@ethersproject/signing-key";
import { abi as ERC20ABI } from './abi/erc20.json'
import { abi as WETHABI } from './abi/weth.json'
import { useConfig, ChainConfig } from './config'
import { price } from './uniswap'

// Read our .env file
config()

// Static config that doesn't belong in the .env file.
const CHAIN_CONFIG: ChainConfig = useConfig()

export let gasPrice: bigint

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

    static createFromConfig(chainConfig: any): EthUsdcWallet {
        // Check .env file and create Ethers.js wallet from mnemonic in it.
        const mnemonic = process.env.DRO_ACCOUNT_MNEMONIC

        if (mnemonic == undefined) {
            console.error("No .env file or no mnemonic in it. If you need one for testing, try this one.")
            const randomWallet = ethers.Wallet.createRandom()
            console.error(randomWallet.mnemonic.phrase)
            process.exit()
        }

        // This will get the first account for this seed phrase. There's an optional second
        // argument here for the BIP-32 derivation path.
        //   m/44'/60'/0'/0/0 (default): account 0
        //   m/44'/60'/0'/0/1:           account 1 etc.
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

        console.log(`\nDRO account: ${w.address}`)

        return w
    }

    async eth(): Promise<bigint> {
        return (await this.getBalance("latest")).toBigInt()
    }

    async usdc(): Promise<bigint> {
        return (await this.usdcContract.balanceOf(this.address)).toBigInt()
    }

    async weth(): Promise<bigint> {
        return (await this.wethContract.balanceOf(this.address)).toBigInt()
    }

    // Testable, internal implementation.
    static _tokenRatioByValue(usdc: bigint, weth: bigint, price: bigint): number {
        let usdValueOfWeth = weth * price / 1_000_000_000_000_000_000n

        // Avoid a division by zero error below. Any very small integer will do here.
        if (usdValueOfWeth == 0n) usdValueOfWeth = 1n

        // Do BigInt operations in the middle and floating point operations on the outside.
        const r = Number(usdc * 100n / usdValueOfWeth) / 100

        return r
    }

    async tokenRatioByValue(): Promise<number> {
        const usdc = await this.usdc()
        const weth = await this.weth()

        // This is USDC * 10e6, eg. 3_000_000_000 when the price of ETH is USD 3,000.
        const p: bigint = price()
        // console.log(`price: ${p}`)

        // console.log(`usdc: ${usdc}`)
        // console.log(`weth: ${weth}`) // 86_387_721_003_586_366
        return EthUsdcWallet._tokenRatioByValue(usdc, weth, p)
    }

    async logBalances() {
        const [usdcBalance, wethBalance, ethBalance] =
            await Promise.all([
                this.usdc(),
                this.weth(),
                this.eth(),
            ])

        // USDC has 6 decimals. We should really get this from the contract but it's another call and
        // our ABI is incomplete.
        // WETH has 18 decimals, just like Ether.

        // Formatting to a given number of decimal places is fiddly. We are truncating here, not
        // rounding.
        const usdcBalanceReadable = ethers.utils.formatUnits(
            usdcBalance - (usdcBalance % 10000n), 6)

        const wethBalanceReadable = ethers.utils.formatEther(
            wethBalance - (wethBalance % 100000000000000n))

        const ethBalanceReadable = ethers.utils.formatEther(
            ethBalance - (ethBalance % 100000000000000n))

        const ratio = await this.tokenRatioByValue()

        console.log(`Balances: USDC ${usdcBalanceReadable}, WETH ${wethBalanceReadable}, \
ETH ${ethBalanceReadable} (token ratio by value: ${ratio})`)
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

    async wrapEth(amount: string) {
        console.log(`Wrapping ${amount} ETH to WETH`)

        const nonce = await this.getTransactionCount("latest")

        // No calldata required, just the value.
        const txRequest = {
            from: this.address,
            to: this.wethContract.address,
            value: ethers.utils.parseEther(amount),
            nonce: nonce,
            gasLimit: CHAIN_CONFIG.gasLimit,
            gasPrice: CHAIN_CONFIG.gasPrice,
        }

        const txResponse: TransactionResponse = await wallet.sendTransaction(txRequest)
        // console.log(`TX response`)
        // console.dir(txResponse)

        const txReceipt: TransactionReceipt = await txResponse.wait()
        // console.log(`TX receipt`)
        // console.dir(txReceipt)
    }

    async unwrapWeth(amount: bigint) {
        const wethAmountReadable = ethers.utils.formatEther(
            amount - (amount % 100000000000000n))

        console.log(`Unwrapping ${wethAmountReadable} WETH to ETH`)

        const nonce = await this.getTransactionCount("latest")

        // Native bigints do not work for passing to encodeFunctionData().
        const a = ethers.utils.parseUnits(amount.toString(), 'wei')
        // console.log(`amountAsString: ${a}`) // 10_000_000_000_000_000 for 0.01 WETH input.

        const wethInterface = new ethers.utils.Interface(WETHABI)
        const calldata = wethInterface.encodeFunctionData('withdraw', [a])
        // console.log(`calldata: ${calldata}`)

        // No value required, just the calldata.
        const txRequest = {
            from: this.address,
            to: this.wethContract.address,
            value: 0,
            nonce: nonce,
            gasLimit: CHAIN_CONFIG.gasLimit,
            gasPrice: CHAIN_CONFIG.gasPrice,
            data: calldata
        }

        const txResponse: TransactionResponse = await wallet.sendTransaction(txRequest)
        // console.log(`TX response`)
        // console.dir(txResponse)

        const txReceipt: TransactionReceipt = await txResponse.wait()
        // console.log(`TX receipt`)
        // console.dir(txReceipt)
    }
}

export const wallet = EthUsdcWallet.createFromConfig(CHAIN_CONFIG)

// We use the legacy gas price as a reference, just like everybody else seems to be doing. The new
// EIP-1559 maxFeePerGas seems to come in at about twice the value.
export async function updateGasPrice() {
    // These API calls are costly. Avoid them on L2 where we don't care so much about gas.
    // On Alchemy under the free tier, this causes:
    //   HTTP 429
    //   Your app has exceeded its compute units per second capacity. If you have retries enabled,
    //   you can safely ignore this message. If not, check out
    //   https://docs.alchemyapi.io/guides/rate-limits
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

    gasPrice = p.toBigInt()
}

export function gasPriceFormatted(): string {
    if (gasPrice === undefined) {
        return 'unknown'
    }

    // console.log(`Gas price as bigint: ${gasPrice} wei`) // 112_473_357_401

    // Do BigInt operations in the middle and floating point operations on the outside.
    // L2 networks can do with one decimal of precision here.
    const g = Number(gasPrice * 10n / 1_000_000_000n) / 10
    
    return `${g.toFixed(1)} gwei`
}
