import { ethers } from "ethers";
import { MintOptions, nearestUsableTick, NonfungiblePositionManager, Pool, Position, priceToClosestTick, tickToPrice } from "@uniswap/v3-sdk";
import { Token, CurrencyAmount, Percent, Price, Fraction } from "@uniswap/sdk-core";
import { abi as IUniswapV3PoolABI } from "@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json";
// import { abi as NonfungiblePositionManagerABI } from "@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json";
import moment from 'moment';

// TODO
// ----
// (P2) Mint a new liquidity position (but fail because no local account) centred on the current price, providing half ETH and half USDC
// (P2) While we're waiting for any transaction, don't begin re-ranging again
// (P2) Remove an existing liquidity position (but fail because no local account)
// (P1) Know when we're out of range directly from the existing liquidity position and stop tracking min and max ticks locally
// (P2) Execute a swap for a known amount of ETH (half our account balance, less some savings for execution)
// (P2) Execute a swap for a known amount of USDC (half our account balance)
// (P2) Keep track of how much ETH to keep on hand for gas and swap costs

// (P3) Know how to create a new account locally in geth and secure the private key (or destroy it if the seed phrase is secure), eg. enter seed phrase or password on process start every time
// (P3) Have this script execute using the local geth-created account, using an Ethers.js Signer
// (P3) Build the URL of the position, based on the serial number, and log it
// (P3) Know the current price of gas
// (P3) Don't re-range when the current price of gas is over a constant threshold

// (P4) Get things like the Infura endpoint URL from a .env file using dotenv()

// Done
// ----

// (P1) Fix the range width arithmetic
// (P1) Show the new range min and max in terms of USDC rather than ticks
// (P1) Get the current price in the pool synchronously and in terms of the quote currency
// (P1) Know when we're out of range, indirectly, based on the current price in the pool and the current min/max, which we'll store for now
// (P1) Timestamps in logging
// (P2) Execute everything on every new block by subscribing to "block""
// (P3) Understand whether executing on every block is going to spend the free quota at Infura
// (P3) Switch to a local geth node if we're going to run out of Infura quota

// Account that will hold the Uniswap v3 position NFT
// const DRO_ADDR = "0x0EEc9b15a6E978E89B2d0007fb00351Bdcf1527D";

// My personal Infura project (dro). Free quota is 100K requests per day, which is more than one a second.
// WSS doesn't work ("Error: could not detect network") and HTTPS works for event subscriptions anyway.
const ENDPOINT_HTTPS = "https://mainnet.infura.io/v3/84a44395cd9a413b9c903d8bd0f9b39a";
const ENDPOINT_WSS = "wss://mainnet.infura.io/ws/v3/84a44395cd9a413b9c903d8bd0f9b39a";
const ENDPOINT = ENDPOINT_HTTPS;

// Ethereum mainnet
const CHAIN_ID = 1;

const PROVIDER = new ethers.providers.JsonRpcProvider(ENDPOINT);

// USDC/ETH pool with 0.3% fee: https://info.uniswap.org/#/pools/0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8
// This is the pool into which we enter a range order. It is NOT the pool in which we execute swaps.
const POOL_ADDR_ETH_USDC_FOR_RANGE_ORDER = "0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8";

// USDC/ETH pool with 0.05% fee: https://info.uniswap.org/#/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640
// This is the pool in which we execute our swaps.
const POOL_ADDR_ETH_USDC_FOR_SWAPS = "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640";

// Position manager contract. Address taken from https://github.com/Uniswap/v3-periphery/blob/main/deploys.md
// and checked against transactions executed on the Uniswap dApp.
const POSITION_MANAGER_ADDR = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";

const poolContract = new ethers.Contract(
  POOL_ADDR_ETH_USDC_FOR_RANGE_ORDER,
  IUniswapV3PoolABI,
  PROVIDER
);

// let nonfungiblePositionManagerContract = new ethers.Contract(
//   POSITION_MANAGER_ADDR,
//   NonfungiblePositionManagerABI,
//   PROVIDER
// );

// Single, global instance of the DRO class.
let dro: DRO;

// Etheres wallet
let w: ethers.Wallet;

interface Immutables {
  factory: string;
  token0: string;
  token1: string;
  fee: number;
  tickSpacing: number;
  maxLiquidityPerTick: ethers.BigNumber;
}

interface State {
  liquidity: ethers.BigNumber;
  sqrtPriceX96: ethers.BigNumber;
  tick: number;
  observationIndex: number;
  observationCardinality: number;
  observationCardinalityNext: number;
  feeProtocol: number;
  unlocked: boolean;
}

class DRO {
  readonly poolImmutables: Immutables;
  readonly usdc: Token;
  readonly weth: Token;
  priceUsdc: string = "unknown";
  minTick: number = 0;
  maxTick: number = 0;
  rangeWidthTicks = 0;

  constructor(_poolImmutables: Immutables, _usdc: Token, _weth: Token, _rangeWidthTicks: number) {
    this.poolImmutables = _poolImmutables;
    this.usdc = _usdc;
    this.weth = _weth;
    this.rangeWidthTicks = _rangeWidthTicks;
  }

  outOfRange(currentTick: number) {
    return currentTick < this.minTick || currentTick > this.maxTick;
  }

  // Note that if rangeWidthTicks is not a multiple of the tick spacing for the pool, the range
  // returned here can be quite different to rangeWidthTicks.
  newRange(currentTick: number) {
    const minTick = nearestUsableTick(Math.round(currentTick - (this.rangeWidthTicks / 2)),
      this.poolImmutables.tickSpacing);

    const maxTick = nearestUsableTick(Math.round(currentTick + (this.rangeWidthTicks / 2)),
      this.poolImmutables.tickSpacing);

    return [minTick, maxTick];
  }
}

async function getPoolImmutables() {
  const [factory, token0, token1, fee, tickSpacing, maxLiquidityPerTick] =
    await Promise.all([
      poolContract.factory(),
      poolContract.token0(),
      poolContract.token1(),
      poolContract.fee(),
      poolContract.tickSpacing(),
      poolContract.maxLiquidityPerTick(),
    ]);

  const immutables: Immutables = {
    factory,
    token0,
    token1,
    fee,
    tickSpacing,
    maxLiquidityPerTick,
  };
  return immutables;
}

async function getPoolState() {
  const [liquidity, slot] = await Promise.all([
    poolContract.liquidity(),
    poolContract.slot0(),
  ]);

  // slot[0] at this point is not that useful:
  // console.log("Pool state slot 0: ", slot[0]);
  // BigNumber {
  //   _hex: '0x461e1227bff1bfd4f8cfbee9ef21',
  //   _isBigNumber: true
  // }

  const PoolState: State = {
    liquidity,
    sqrtPriceX96: slot[0],
    tick: slot[1],
    observationIndex: slot[2],
    observationCardinality: slot[3],
    observationCardinalityNext: slot[4],
    feeProtocol: slot[5],
    unlocked: slot[6],
  };

  return PoolState;
}

// Ethers.js listener:
// export type Listener = (...args: Array<any>) => void;
async function onBlock(...args: Array<any>) {
  const state = await getPoolState();

  // Are we now out of range?
  const oor = dro.outOfRange(state.tick);

  const poolEthUsdcForRangeOrder = new Pool(
    dro.usdc,
    dro.weth,
    dro.poolImmutables.fee,
    state.sqrtPriceX96.toString(),
    state.liquidity.toString(),
    state.tick
  );

  // Log the timestamp and block number first
  let logThisBlock = false;
  let logLine = moment().format("MM-DD-HH:mm:ss");
  logLine += " #" + args;

  // toFixed() implementation: https://github.com/Uniswap/sdk-core/blob/main/src/entities/fractions/price.ts
  const priceInUsdc: string = poolEthUsdcForRangeOrder.token1Price.toFixed(2);
  
  // Only log the price when it changes.
  if (dro.priceUsdc != priceInUsdc) {
    logLine += " " + priceInUsdc + " USDC.";
    logThisBlock = true;
  }

  dro.priceUsdc = priceInUsdc;

  if (oor) {
    // Find our new range around the current price.
    const [minTick, maxTick] = dro.newRange(state.tick);

    dro.minTick = minTick;
    dro.maxTick = maxTick;

    // tickToPrice() implementation:
    //   https://github.com/Uniswap/v3-sdk/blob/6c4242f51a51929b0cd4f4e786ba8a7c8fe68443/src/utils/priceTickConversions.ts#L14
    // Note that minimum USDC value per ETH corresponds to the maximum tick value and vice versa.
    const minUsdc = tickToPrice(dro.weth, dro.usdc, maxTick).toFixed(2);
    const maxUsdc = tickToPrice(dro.weth, dro.usdc, minTick).toFixed(2);

    logLine += " Out of range. New range: " + minUsdc + " USDC - " + maxUsdc + " USDC.";

    // Liquidity can be a JSBI, a string or a number.
    // TODO: For all but the very first minting of a position, the liquidity will be based on the
    // balance in our account after we just removed liquidity from the out of range position.

    const position = new Position({
      pool: poolEthUsdcForRangeOrder,
      liquidity: 1, // Integer
      tickLower: minTick,
      tickUpper: maxTick
    });

    const { amount0: amount0Desired, amount1: amount1Desired } = position.mintAmounts
    console.log("Amounts desired: ", amount0Desired.toString(), amount1Desired.toString())

    const mintOptions: MintOptions = {
      slippageTolerance: new Percent(50, 10_000), // 0.005%
      deadline: moment().unix() + 180, // 3 minutes from now
      recipient: w.address,
      createPool: false
    };

    // addCallParameters() implementation:
    //   https://github.com/Uniswap/v3-sdk/blob/6c4242f51a51929b0cd4f4e786ba8a7c8fe68443/src/nonfungiblePositionManager.ts#L164
    const { calldata, value } = NonfungiblePositionManager.addCallParameters(position, mintOptions);

    // console.log("calldata: ", calldata);
    // console.log("value: ", value);

    // console.log("nonfungiblePositionManagerContract: ", nonfungiblePositionManagerContract);
    // Solidity source for mint(): https://github.com/Uniswap/v3-periphery/blob/v1.0.0/contracts/NonfungiblePositionManager.sol#L128
    // TODO: Fix:
    // Error: invalid ENS name (argument="name", value=undefined, code=INVALID_ARGUMENT, version=providers/5.4.5)
    // const out = await nonfungiblePositionManagerContract.mint(calldata);
    // console.log("out: ", out);
    const nonce = await w.getTransactionCount("latest");
    console.log("nonce: ", nonce);

    const tx = {
      from: w.address,
      to: POSITION_MANAGER_ADDR,
      value: ethers.utils.parseEther("0"),
      nonce: nonce,
      gasLimit: ethers.utils.hexlify(100_000),
      gasPrice: ethers.utils.hexlify(100_000), // TODO: This is probably quite wrong.
      data: calldata
    };

    // Currently failing with insufficient funds, which is as expected.
    // w.sendTransaction(tx).then((transaction) => {
    //   console.dir(transaction)
    //   console.log("Send finished!")
    // }).catch(console.error);
  }
  else {
    logLine += " In range.";
  }

  if (logThisBlock) console.log(logLine);
}

async function main() {
  // From the Uniswap v3 whitepaper:
  //   "Ticks are all 1.0001 to an integer power, which means each tick is .01% away from the next
  //    tick."
  // Note that .01% is one basis point ("bip"), so every tick is a single bip change in price.
  // But the tick spacing in our pool is 60, so we'd be wise to make our range width a multiple of
  // that.
  // Percent   bips (ticks)   Observations
  // -------   ------------   ------------
  //    0.6%             60   NFW. Re-ranging 8 times during a 4% hourly bar.
  //    1.2%            120   NFW. Re-ranging 7 times in 8 hours.
  //    1.8%            180   Re-ranged 3 times in 11 hours in a non-volatile market.
  //    2.4%            240   Re-ranged 5 times in 8 hours on a 5% daily bar. 
  //    3.0%            300   Testing
  //    3.6%            360
  const rangeWidthTicks = 0.030 / 0.0001;
  console.log("Range width in ticks: " + rangeWidthTicks);

  // Create a new random wallet and connect to our provider.
  w = ethers.Wallet.createRandom();
  w = w.connect(PROVIDER);

  console.log("Wallet: ", w.address);
  console.log("Mnemonic: ", w.mnemonic.phrase);

  // console.log("Gas: ", (await w.getGasPrice()).div(10^9).toString());
  // nonfungiblePositionManagerContract = nonfungiblePositionManagerContract.connect(w);

  try {
    // Get the pool's immutables once only.
    const i = await getPoolImmutables();

    dro = new DRO(i,
      new Token(CHAIN_ID, i.token0, 6, "USDC", "USD Coin"),
      new Token(CHAIN_ID, i.token1, 18, "WETH", "Wrapped Ether"),
      rangeWidthTicks);
  }
  catch(e) {
    // Probably network error thrown by getPoolImmutables().
    console.error(e);
  }

  // Get a callback to onBlock() on every new block.
  PROVIDER.on('block', onBlock);
}
  
main().catch(console.error);
