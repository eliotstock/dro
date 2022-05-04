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

    // Excludes fees claimed at the time of the 'remove' tx.
    closingLiquidityWeth: bigint = 0n
    closingLiquidityUsdc: bigint = 0n

    // Quoted in USDC atoms.
    priceAtOpening?: bigint
    priceAtClosing?: bigint

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
            return (BigInt(this.withdrawnWeth) - BigInt(this.closingLiquidityWeth))
        }
            
        throw `Didn't trade down: ${this.tokenId}`
    }

    feesUsdcCalculated(): bigint {
        if (this.traded == Direction.Up) {
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

            return BigInt(this.feesUsdc) + usdcValueOfWethFees
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

            return BigInt(this.feesWeth) + wethValueOfUsdcFees
        }
        else if (this.traded == Direction.Up) {
            const wethValueOfUsdcFees = BigInt(this.feesUsdcCalculated()) * N_10_TO_THE_18 / BigInt(this.priceAtClosing)

            return BigInt(this.feesWeth) + wethValueOfUsdcFees
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

    closingLiquidityTotalInUsdc(): bigint {
        if (this.priceAtClosing == undefined) throw `No price at closing: ${this.tokenId}`
    
        const usdcValueOfWethLiquidity = BigInt(BigInt(this.closingLiquidityWeth) * BigInt(this.priceAtClosing)) / N_10_TO_THE_18

        return BigInt(this.closingLiquidityUsdc) + usdcValueOfWethLiquidity
    }

    openingLiquidityTotalInEth(): bigint {
        if (this.priceAtOpening == undefined) throw `No price at opening: ${this.tokenId}`
    
        const ethValueOfUsdcLiquidity = BigInt(BigInt(this.openingLiquidityUsdc) * N_10_TO_THE_18 / BigInt(this.priceAtOpening))

        return BigInt(this.openingLiquidityWeth) + ethValueOfUsdcLiquidity
    }

    closingLiquidityTotalInEth(): bigint {
        if (this.priceAtClosing == undefined) throw `No price at closing: ${this.tokenId}`
    
        const ethValueOfUsdcLiquidity = BigInt(BigInt(this.closingLiquidityUsdc) * N_10_TO_THE_18 / BigInt(this.priceAtClosing))

        return BigInt(this.closingLiquidityWeth) + ethValueOfUsdcLiquidity
    }

    // Note that if we have any failed transactions, this does not account for them. We're only
    // looking at the transactions that succeeded.
    totalGasPaidInEth(): bigint {
        if (this.addTxGasPaid === undefined || this.removeTxGasPaid === undefined
            || this.swapTxGasPaid === undefined) return 0n

        // As of 2022-04-21:
        // Max: 0.075_621_200 ETH (232 USD)
        // Min: 0.028_806_315 ETH (86 USD)
        return this.addTxGasPaid + this.removeTxGasPaid + this.swapTxGasPaid
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
        const diffInSeconds: number = closed.diff(opened, 'seconds', true)
        const timeInRange = moment.duration(diffInSeconds, 'seconds')

        // console.log(`Opened: ${opened.toString()}, closed: ${closed.toString()}, diffInSeconds: ${diffInSeconds} seconds`)

        return timeInRange
    }

    openingBlockNumber(): number {
        if (this.addTxReceipt === undefined) return 0

        return this.addTxReceipt.blockNumber
    }

    closingBlockNumber(): number {
        if (this.removeTxReceipt === undefined) return 0

        return this.removeTxReceipt.blockNumber
    }

    // This is a gain when we trade up, so it's probably not what the literature considers to be
    // impermanent loss.
    impermanentLossInUsdc(): bigint {
        const opening = this.openingLiquidityTotalInUsdc()
        const closing = this.closingLiquidityTotalInUsdc()

        if (opening == undefined || closing == undefined) return 0n

        return BigInt(closing) - BigInt(opening)
    }

    // This is a gain when we trade down, so it's probably not what the literature considers to be
    // impermanent loss.
    impermanentLossInEth(): bigint {
        const opening = this.openingLiquidityTotalInEth()
        const closing = this.closingLiquidityTotalInEth()

        if (opening == undefined || closing == undefined) return 0n

        return BigInt(closing) - BigInt(opening)
    }

    netReturnInEth(): bigint {
        const gas = this.totalGasPaidInEth()
        const fees = this.feesTotalInEth()
        const il = this.impermanentLossInEth()

        if (gas == undefined || fees == undefined || il == undefined) {
            return 0n
        }

        // IL is negative when it's a loss.
        return fees - gas + il
    }

}
