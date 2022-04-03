import moment from "moment"

const N_10_TO_THE_18 = BigInt(1_000_000_000_000_000_000)

export interface EventLog {
    block_timestamp: {value: string}
    transaction_hash: string
    address: string
    data: string
    topics: string[]
}

export enum Direction {
    Up = 'up',
    Down = 'down'
}

export class Position {
    tokenId: number
    removeTxLogs?: EventLog[]
    addTxLogs?: EventLog[]
    traded?: Direction
    openedTimestamp?: string
    closedTimestamp?: string
    rangeWidthBps?: number
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

    constructor(_tokenId: number) {
        this.tokenId = _tokenId
    }

    feesWethCalculated(): bigint {
        if (this.traded == Direction.Down) {
            if (this.closingLiquidityWeth == undefined) throw `Missing closingLiquidityWeth: ${this.tokenId}`

            return (BigInt(this.withdrawnWeth) - BigInt(this.closingLiquidityWeth))
        }
        else {
            throw `Traded up, so use feesWeth property instead: ${this.tokenId}`
        }
    }

    feesUsdcCalculated(): bigint {
        if (this.traded == Direction.Up) {
            if (this.closingLiquidityUsdc == undefined) throw `Missing closingLiquidityUsdc: ${this.tokenId}`

            return (BigInt(this.withdrawnUsdc) - BigInt(this.closingLiquidityUsdc))
        }
        else {
            throw `Traded down, so use feesUsdc property instead: ${this.tokenId}`
        }
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

        throw `No direction: ${this.tokenId}`
    }

    openingLiquidityTotalInUsdc(): bigint {
        if (this.priceAtOpening == undefined) throw `No price at opening: ${this.tokenId}`
    
        const usdcValueOfWethLiquidity = BigInt(BigInt(this.openingLiquidityWeth) * BigInt(this.priceAtOpening)) / N_10_TO_THE_18

        return BigInt(this.openingLiquidityUsdc) + usdcValueOfWethLiquidity
    }

    // Total fees claimed as a proportion of opening liquidity, in percent.
    // This completely ignores execution cost and time in range.
    grossYield(): number {
        // The old 'decimal value from dividing two bigints' trick, except we want
        // this in percent, so we don't divide again by our constant.
        return Number(this.feesTotalInUsdc() * 10_000n / this.openingLiquidityTotalInUsdc())
    }

    timeOpenDays(): number {
        if (this.openedTimestamp == undefined || this.closedTimestamp == undefined) {
            throw `Missing opened/closed timestamps: ${this.tokenId}`
        }

        const opened = moment(this.openedTimestamp)
        const closed = moment(this.closedTimestamp)
        const timeInRange = moment.duration(closed.diff(opened), 'milliseconds')

        return timeInRange.asDays()
    }
}
