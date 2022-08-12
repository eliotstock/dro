# Uniswap v3 dynamic range order

## About

An expert knowledge of Uniswap v3 is assumed here. Dynamic range orders are Uniswap v3 liquidity provision positions that are always in range. This code will watch the price in the pool for when it moves out of range. It will then remove liquidity, rebalance to a 50:50 asset ratio and add liquidity in a new range centred on the current price.

Your PnL as an algorithmic LP using this approach is:

```
+ trading fees
- impermanent loss
- swap costs
- gas costs
------------------
= profit
```

Which is to say, it is your goal that trading fees paid to you by the protocol outweigh these costs. Of these costs, the IL incurred as the price moves to the edge of your range is by far the most significant.

## Build & run

1. `nvm use`
1. `cd dro`
1. `npm install`
1. Fund the account you're going to use with:
    1. Some ETH for gas, at least 0.2 ETH on Mainnet or 0.015 ETH on Arbitrum
    1. Either USDC or WETH (or both is fine) to the value of at least 1K USD
1. You need a local `.env` file. Start by copying the example: `cp .env.example .env`. Then edit the values:
    1. `DRO_ACCOUNT_MNEMONIC`: A seed phrase of 12 words, the first account from which is the one you're going to use
    1. `PROVIDER_URL`: Including the Infura project ID or Alchemy API key. Using a local node is fine.
    1. `CHAIN` eg. `"ethereumMainnet"`: See `dro/src/config.ts` for valid values.
    1. `RANGE_WIDTH` eg. `"600"`: Single value in basis points (bps). Start with `"1800"` if you're not sure.
1. Approve Uniswap's smart contracts to spend your WETH and USDC.
    1. `npm run approve`
1. Run with error handling.
    1. `cd ../proc`
    1. `npm install`
    1. `npm run proc`

The `proc` module will run the `dro` module with some retries and back-off. This is what you want in production.

## Run without error handling

When developing locally, forget `proc` and just run `dro` directly:

1. `cd dro`
1. `npm install`
1. `npm run prod`

The process will crash on the first 4xx or 5xx error repsonse from the provider's RPC URL.

## Warning

You will probably not make a tonne of money running this code, for these reasons:

1. The IL is significant. It cannot be ignored simply because you value both assets in the pool (eg. ETH/USDC) and don't mind if the price falls in the medium term. Every time you re-range, you're compounding your loses.
1. Uniswap v3 now has many JIT bots providing liquidity. These bots will provide liquidity immediately before and remove it immediately after a large swap. They are highly concentrated on the price at the swap and suffer much less IL. Because the big swaps generate the most trading fees, these guys will take the lion's share of the trading fees in the pool. They are very difficult to compete with.
