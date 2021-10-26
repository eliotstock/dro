# Hardhat Project for deloying a test USDC token

We need to execute tests on testnets that are as similar in behaviour as possible to mainnet. This requires creating pools, which requires plenty of token supply. The easiest way to have a stack of testnet USDC is to deploy a new contract for it.

Create an `.env` file with the following values:

1. `PRIVATE_KEY` from the DRO account used in the parent project
1. `KOVAN_URL` for Infura

Then deploy our test USDC contract with

```shell
npx hardhat compile
npx hardhat test
npx hardhat run scripts/deploy.ts --network kovan
```

Then put the address of this contract into the config in the parent project.
