import express from 'express'
import client, {Gauge, Histogram, Summary} from 'prom-client'

// Use the global default registry
const register: client.Registry = client.register

class Metrics {
    unclaimedFeesInUsdc = new Gauge({
        name: 'unclaimed_fees_usdc',
        help: 'Unclaimed fees in USDC',
    });

    gasPrice = new Gauge({
        name: 'gas_price',
        help: 'Gas price in Gwei',
    });

    ethPrice = new Gauge({
        name: 'eth_price',
        help: 'ETH price in USDC',
    });

    reRangeTime = new Gauge({
        name: 'rerange_time',
        help: 'Time of last re-range in seconds since Unix epoch',
    });

    currentPositionNft = new Gauge({
        name: 'position_nft',
        help: 'Current position NFT',
    });

    balance = new Gauge({
        name: 'balance',
        help: 'Current wallet balance',
        labelNames: ['currency'],
    });

    rangeUpperBound = new Gauge({ 
        name: 'range_upper_bound', 
        help: 'Upper bound of current range' 
    });

    rangeLowerBound = new Gauge({ 
        name: 'range_lower_bound', 
        help: 'Lower bound of current range' 
    });

    removeLiquidityTxnTimeMs = new Summary({
        name: 'remove_liquidity_txn_time_ms',
        help: 'Time to remove liquidity in milliseconds',
    });

    removeLiquidityGasCost = new Gauge({
        name: 'remove_liquidity_gas_cost',
        help: 'Gas cost to remove liquidity',
    });

    swapTxnTimeMs = new Summary({
        name: 'swap_txn_time_ms',
        help: 'Time to swap in milliseconds',
    });

    swapGasCost = new Gauge({
        name: 'swap_gas_cost',
        help: 'Gas cost to swap',
    });

    addLiquidityTxnTimeMs = new Summary({
        name: 'add_liquidity_txn_time_ms',
        help: 'Time to add liquidity in milliseconds',
    });

    addLiquidityTxnGasCost = new Gauge({
        name: 'add_liquidity_txn_gas_cost',
        help: 'Gas cost to add liquidity',
    });

    totoalRerangeTimeMs = new Summary({
        name: 'total_rerange_time_ms',
        help: 'Total time to re-range in milliseconds',
    });
}

export const metrics = new Metrics()

export function initMetrics() {
    // Add a default label which is added to all metrics
    register.setDefaultLabels({
        app: 'dro',
    })

    // Enable the collection of default metrics
    //client.collectDefaultMetrics({ register })
}

export function metricsHandler() {
    const router = express.Router()
    
    router.get('/metrics', async (_request, response, _next) => {
        response.set('Content-Type', register.contentType)
        response.send(await register.metrics())
    });

    return router
};