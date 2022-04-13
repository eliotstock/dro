# Position analysis

This is a script that analyses closed positions in an ETH/USDC pool using a public dataset on Google BigQuery. It's intended to be used with a Google Colab doc for further analysis of the `positions*.csv` that it generates in `./out`.

## Google BigQuery

1. Go to https://console.cloud.google.com/, create a new project and select it.
1. Follow these steps to enable the API and set up auth: https://cloud.google.com/nodejs/docs/reference/bigquery/latest#before-you-begin
1. Put values for these env vars into an `.env` file:
    1. `GCP_PROJECT_ID="foo"`
    1. `GCP_KEY_PATH="./gcp-key.json"`
    1. `ADDR_POOL` eg. `0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640` for the 0.05% fee tier pool

## Build & run

1. `nvm use`
1. `npm install`
1. `npm run run`
