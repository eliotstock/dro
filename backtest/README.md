# DRO backtesting

This is a script that backtests DROs at various range widths using a piblic dataset on Google BigQuery.

## Google BigQuery

1. Go to https://console.cloud.google.com/, create a new project and select it.
1. Follow these steps to enable the API and set up auth: https://cloud.google.com/nodejs/docs/reference/bigquery/latest#before-you-begin
1. Put values for these two env vars into an `.env` file:
    1. `GCP_PROJECT_ID="foo"`
    1. `GCP_KEY_PATH="./gcp-key.json"`

## Build & run

1. `nvm use`
1. `npm install`
1. `npm run run`
