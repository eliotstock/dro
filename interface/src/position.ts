import moment from 'moment'
import { Log, TransactionReceipt, TransactionResponse } from '@ethersproject/abstract-provider'

const N_10_TO_THE_18 = BigInt(1_000_000_000_000_000_000)

export enum Direction {
    Up = 'up',
    Down = 'down',
    Sideways = 'sideways'
}

export class Position {
    tokenId: number

    swapTxLogs: Array<Log>
    addTxLogs: Array<Log>
    removeTxLogs: Array<Log>
    
    swapTxReceipt?: TransactionReceipt
    addTxReceipt?: TransactionReceipt
    removeTxReceipt?: TransactionReceipt

    traded?: Direction

    openedTimestamp?: number
    closedTimestamp?: number

    rangeWidthInBps?: number

    feesWeth: bigint = 0n
    feesUsdc: bigint = 0n

    withdrawnWeth: bigint = 0n
    withdrawnUsdc: bigint = 0n

    openingLiquidityWeth: bigint = 0n
    openingLiquidityUsdc: bigint = 0n
    closingLiquidityWeth?: bigint
    closingLiquidityUsdc?: bigint

    priceAtOpening?: bigint // Quoted in USDC
    priceAtClosing?: bigint // Quoted in USDC

    swapTxGasPaid?: bigint
    addTxGasPaid?: bigint
    removeTxGasPaid?: bigint

    constructor(_tokenId: number) {
        this.tokenId = _tokenId
        this.removeTxLogs = new Array<Log>()
        this.addTxLogs = new Array<Log>()
        this.swapTxLogs = new Array<Log>()
    }

    feesWethCalculated(): bigint {
        if (this.traded == Direction.Down) {
            if (this.closingLiquidityWeth == undefined) throw `Missing closingLiquidityWeth: ${this.tokenId}`

            return (BigInt(this.withdrawnWeth) - BigInt(this.closingLiquidityWeth))
        }
            
        throw `Didn't trade down: ${this.tokenId}`
    }

    feesUsdcCalculated(): bigint {
        if (this.traded == Direction.Up) {
            if (this.closingLiquidityUsdc == undefined) throw `Missing closingLiquidityUsdc: ${this.tokenId}`

            return (BigInt(this.withdrawnUsdc) - BigInt(this.closingLiquidityUsdc))
        }

        throw `Didn't trade up: ${this.tokenId}`
    }

    feesLog(): string {
        if (this.traded == Direction.Down) {
            return `${this.feesWethCalculated()} WETH and ${this.feesUsdc} USDC`
        }
        else if (this.traded == Direction.Up) {
            return `${this.feesWeth} WETH and ${this.feesUsdcCalculated()} USDC`
        }

        return 'unknown'
    }

    feesTotalInUsdc(): bigint {
        if (this.priceAtClosing == undefined) throw `No price at closing: ${this.tokenId}`

        if (this.traded == Direction.Down) {
            const usdcValueOfWethFees = BigInt(this.feesWethCalculated()) * BigInt(this.priceAtClosing) / N_10_TO_THE_18

            return BigInt(this.feesUsdc) + usdcValueOfWethFees
        }
        else if (this.traded == Direction.Up) {
            const usdcValueOfWethFees = BigInt(this.feesWeth) * BigInt(this.priceAtClosing) / N_10_TO_THE_18

            return BigInt(this.feesUsdcCalculated()) + usdcValueOfWethFees
        }
        else if (this.traded == Direction.Sideways) {
            // We don't currently support any calculations on positions that we closed when still in range.
            return BigInt(0)
        }

        throw `No direction: ${this.tokenId}`
    }

    feesTotalInEth(): bigint {
        if (this.priceAtClosing == undefined) throw `No price at closing: ${this.tokenId}`

        if (this.traded == Direction.Down) {
            const wethValueOfUsdcFees = BigInt(this.feesUsdc) * N_10_TO_THE_18 / BigInt(this.priceAtClosing)

            return BigInt(this.feesUsdcCalculated()) + wethValueOfUsdcFees
        }
        else if (this.traded == Direction.Up) {
            const wethValueOfUsdcFees = BigInt(this.feesUsdcCalculated()) * N_10_TO_THE_18 / BigInt(this.priceAtClosing)

            return BigInt(this.feesUsdc) + wethValueOfUsdcFees
        }
        else if (this.traded == Direction.Sideways) {
            // We don't currently support any calculations on positions that we closed when still in range.
            return BigInt(0)
        }

        throw `No direction: ${this.tokenId}`
    }

    openingLiquidityTotalInUsdc(): bigint {
        if (this.priceAtOpening == undefined) throw `No price at opening: ${this.tokenId}`
    
        const usdcValueOfWethLiquidity = BigInt(BigInt(this.openingLiquidityWeth) * BigInt(this.priceAtOpening)) / N_10_TO_THE_18

        return BigInt(this.openingLiquidityUsdc) + usdcValueOfWethLiquidity
    }

    totalGasPaidInEth(): bigint | undefined {
        if (this.addTxGasPaid === undefined || this.removeTxGasPaid === undefined
            || this.swapTxGasPaid === undefined) return undefined

        // As of 2022-04-21:
        // Max: 0.075_621_200 ETH (232 USD)
        // Min: 0.028_806_315 ETH (86 USD)
        return this.addTxGasPaid + this.removeTxGasPaid + this.swapTxGasPaid
    }

    netYieldInEth(): bigint {
        const gasPaid = this.totalGasPaidInEth()

        if (gasPaid == undefined) {
            return 0n
        }

        return this.feesTotalInEth() + gasPaid
    }

    // Total fees claimed as a proportion of opening liquidity, in percent.
    // This completely ignores execution cost and time in range.
    grossYieldInPercent(): number {
        // The old 'decimal value from dividing two bigints' trick.
        return Number(this.feesTotalInUsdc() * 10_000n / this.openingLiquidityTotalInUsdc()) / 100
    }

    timeOpen(): moment.Duration {
        if (this.openedTimestamp == undefined || this.closedTimestamp == undefined) {
            throw `Missing opened/closed timestamps: ${this.tokenId}`
        }

        // Seconds since the Unix epoch.
        const opened = moment.unix(this.openedTimestamp)
        const closed = moment.unix(this.closedTimestamp)
        const timeInRange = moment.duration(closed.diff(opened, 'seconds', true))

        // console.log(`Opened: ${opened.toString()}, closed: ${closed.toString()}, time in rage: ${closed.diff(opened, 'hours', true)} hours`)

        return timeInRange
    }

    closingBlockNumber(): number {
        if (this.removeTxReceipt === undefined) return 0

        return this.removeTxReceipt.blockNumber
    }
}
