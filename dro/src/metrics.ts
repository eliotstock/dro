import express from 'express'
import client, {Gauge} from 'prom-client'

// Use the global default registry
const register: client.Registry = client.register

class Metrics {
    unclaimedFeesInUsdc = new Gauge({
        name: 'unclaimed_fees_usdc',
        help: 'Unclaimed fees in USDC',
    });

    gasPriceInGwei = new Gauge({
        name: 'gas_price_gwei',
        help: 'Gas price in Gwei',
    });

    ethPriceInUsdc = new Gauge({
        name: 'eth_price_usdc',
        help: 'ETH price in USDC',
    });

    blockTime = new Gauge({
        name: 'block_time',
        help: 'Time of last block in seconds since Unix epoch',
    });

    reRange = new Gauge({
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
    });
}

export function initMetrics() {
    // Add a default label which is added to all metrics
    register.setDefaultLabels({
        app: 'dro',
    })

    // Enable the collection of default metrics
    client.collectDefaultMetrics({ register })

    const gauge = new client.Gauge({registers: [register], name: 'metric_name', help: 'metric_help' });
    gauge.set(10); // Set to 10
}

export function metricsHandler() {
    const router = express.Router();
    
    router.get('/metrics', async (_request, response, _next) => {
        response.set('Content-Type', register.contentType);
        response.send(await register.metrics());
    });

    return router;
};