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
    feesWeth?: bigint
    feesUsdc?: bigint
    withdrawnWeth?: bigint
    withdrawnUsdc?: bigint
    openingLiquidityWeth?: bigint
    openingLiquidityUsdc?: bigint
    closingLiquidityWeth?: bigint
    closingLiquidityUsdc?: bigint
    priceAtOpening?: bigint // Quoted in USDC as a big integer.
    priceAtClosing?: bigint // Quoted in USDC as a big integer.
    // TODO: openingLiquidityTotalInUsdc(): bigint // Quoted in USDC as a big integer, depends on priceAtOpening.

    constructor(_tokenId: number) {
        this.tokenId = _tokenId
    }

    feesWethCalculated(): bigint {
        if (this.traded == Direction.Down) {
            if (this.withdrawnWeth == undefined) throw 'Missing withdrawnWeth'
            if (this.closingLiquidityWeth == undefined) throw 'Missing closingLiquidityWeth'

            return (this.withdrawnWeth - this.closingLiquidityWeth)
        }
        else {
            throw 'Traded up, so use feesWeth property instead'
        }
    }

    feesUsdcCalculated(): bigint {
        if (this.traded == Direction.Up) {
            if (this.withdrawnUsdc == undefined) throw 'Missing withdrawnUsdc'
            if (this.closingLiquidityUsdc == undefined) throw 'Missing closingLiquidityUsdc'

            return (this.withdrawnUsdc - this.closingLiquidityUsdc)
        }
        else {
            throw 'Traded down, so use feesUsdc property instead'
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
        if (this.priceAtClosing == undefined) throw `No price at closing`

        const n10ToThe18 = BigInt(1_000_000_000_000_000_000)

        if (this.traded == Direction.Down) {    
            if (this.feesUsdc == undefined) throw `No USDC fees component`
      
            const usdcValueOfWethFees = BigInt(this.feesWethCalculated()) * BigInt(this.priceAtClosing) / n10ToThe18

            return BigInt(this.feesUsdc) + usdcValueOfWethFees
        }
        else if (this.traded == Direction.Up) {
            if (this.feesWeth == undefined) throw `No WETH fees component`

            const usdcValueOfWethFees = BigInt(this.feesWeth) * BigInt(this.priceAtClosing) / n10ToThe18

            return BigInt(this.feesUsdcCalculated()) + usdcValueOfWethFees
        }

        throw `No direction`
    }
}
