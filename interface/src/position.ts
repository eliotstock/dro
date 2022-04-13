import moment from 'moment'
import { Log, TransactionReceipt, TransactionResponse } from '@ethersproject/abstract-provider'

const N_10_TO_THE_18 = BigInt(1_000_000_000_000_000_000)

export enum Direction {
    Up = 'up',
    Down = 'down'
}

export class Position {
    tokenId: number
    removeTxLogs?: Log[]
    addTxLogs?: Log[]
    traded?: Direction
    openedTimestamp?: string
    closedTimestamp?: string
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

            // if (this.tokenId == 139631 || this.tokenId == 139633) {
            //     console.log(`${this.tokenId} feesWeth: ${this.feesWeth}`)

            //     // usdcValueOfWethFees: 35_632_575, feesUsdcCalculated: 33_825_603, feesTotalInUsdc: 69_458_178
            //     // usdcValueOfWethFees: 84_958_130, feesUsdcCalculated: 74_994_683, feesTotalInUsdc: 159_952_813
            //     console.log(`${this.tokenId} usdcValueOfWethFees: ${usdcValueOfWethFees}, feesUsdcCalculated: ${this.feesUsdcCalculated()}, feesTotalInUsdc: ${BigInt(this.feesUsdcCalculated()) + usdcValueOfWethFees}`)
            // }

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
    grossYieldInPercent(): number {
        // if (this.tokenId == 139631 || this.tokenId == 139633) {
        //     // Fees total USDC: 69.46, opening liquidity USDC: 2,540.94
        //     // Fees total USDC: 159.95, opening liquidity USDC: 4,320.65
        //     console.log(`Fees total USDC: ${this.feesTotalInUsdc()}, opening liquidity USDC: ${this.openingLiquidityTotalInUsdc()}`)
        // }

        // The old 'decimal value from dividing two bigints' trick.
        return Number(this.feesTotalInUsdc() * 10_000n / this.openingLiquidityTotalInUsdc()) / 100
    }

    timeOpenInDays(): number {
        if (this.openedTimestamp == undefined || this.closedTimestamp == undefined) {
            throw `Missing opened/closed timestamps: ${this.tokenId}`
        }

        const opened = moment(this.openedTimestamp)
        const closed = moment(this.closedTimestamp)
        const timeInRange = moment.duration(closed.diff(opened), 'milliseconds')

        return timeInRange.asDays()
    }
}
