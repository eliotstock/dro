# Uniswap v3 dynamic range order

## Build & run

1. `nvm use`
2. `npm install`
3. Put a value for each of these variables in an `.env` file:
    1. `DRO_ACCOUNT_MNEMONIC`
    2. `INFURA_PROJECT_ID`
4. `npm run dev:start`

## Build a Raspberry Pi Ubuntu Server machine to run this

Goals: low power, no fan, secure, simple.

1. Get a Raspberry Pi 400 (keyboard with Raspberry Pi 4 inside) and a monitor.
2. Image the SD card with Ubuntu Server LTS.
3. Boot. Wait for cloud-init to run before logging in. Default u & p: ubuntu/ubuntu.
4. `sudo apt-get update`
5. `sudo apt-get upgrade`
