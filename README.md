# Uniswap v3 dynamic range order

## Build & run

1. `nvm use`
1. `npm install`
1. Put a value for each of these variables in an `.env` file:
    1. `DRO_ACCOUNT_MNEMONIC`
    1. `INFURA_PROJECT_ID`
1. `npm run start`

## Build a Raspberry Pi Ubuntu Server machine to run this

Goals: low power, no fan, secure, simple.

1. Get a Raspberry Pi 400 (keyboard with Raspberry Pi 4 inside) and a monitor.
1. From the host, image the SD card with Ubuntu Server LTS.
1. Boot the target. Wait for cloud-init to run before logging in. Default u & p: ubuntu/ubuntu.
1. `sudo apt-get update`
1. `sudo apt-get upgrade`
1. `sudo apt-get install net-tools`
1. `ifconfig` and note down the IPv4 address
1. From the host, confirm you can SSH in: `ssh 192.168.1.117 -l ubuntu`
