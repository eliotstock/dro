# Uniswap v3 dynamic range order

## Build & run

1. `nvm use`
1. `cd dro`
1. `npm install`
1. Fund the account you're going to use with:
    1. Some ETH for gas, at least 0.2 ETH on Mainnet or 0.015 ETH on Arbitrum
    1. Either USDC or WETH (or both is fine) to the value of at least 1K USD
1. Put a value for each of these variables in an `.env` file. Only one of the project IDs is required, strictly speaking.
    1. `DRO_ACCOUNT_MNEMONIC`: A seed phrase of 12 words, the first account from which is the one you're going to use
    1. `PROVIDER_URL`: Including the Infura project ID or Alchemy API key. Using a local node is fine.
    1. `CHAIN` eg. `CHAIN="ethereumMainnet"`: See `dro/src/config.ts` for valid values.
    1. `RANGE_WIDTHS` eg. `RANGE_WIDTHS="120 240 360 480 600 720 840 960 1800"`: Space separated list of wdiths, in basis points (bps). Start with `"360"`
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
