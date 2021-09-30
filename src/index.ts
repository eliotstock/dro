import { ethers } from "ethers";
import { nearestUsableTick, Pool, Position, priceToClosestTick, tickToPrice } from "@uniswap/v3-sdk";
import { Token, CurrencyAmount, Percent, Price, Fraction } from "@uniswap/sdk-core";
import { abi as IUniswapV3PoolABI } from "@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json";
import moment from 'moment';

// TODO
// ----
// (P2) Mint a new liquidity position (but fail because no local account) centred on the current price, providing half ETH and half USDC
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

// uSDC/ETH pool with 0.05% fee: https://info.uniswap.org/#/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640
// This is the pool in which we execute our swaps.
const POOL_ADDR_ETH_USDC_FOR_SWAPS = "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640";

const poolContract = new ethers.Contract(
  POOL_ADDR_ETH_USDC_FOR_RANGE_ORDER,
  IUniswapV3PoolABI,
  PROVIDER
);

// Single, global instance of the DRO class.
let dro: DRO;

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
  const priceInUsdc = poolEthUsdcForRangeOrder.token1Price.toFixed(2);
  
  // Only log the price when it changes.
  if (dro.priceUsdc != priceInUsdc) {
    logLine += " " + priceInUsdc + " USDC.";
    logThisBlock = true;
  }

  dro.priceUsdc = priceInUsdc;

  if (oor) {
    // Tick spacing for the ETH/USDC 0.30% pool is 60.
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

    const position = new Position({
      pool: poolEthUsdcForRangeOrder,
      liquidity: 0, //state.liquidity.mul(0.0002),
      tickLower: minTick,
      tickUpper: maxTick
    });

    // TODO: Continue with https://docs.uniswap.org/sdk/guides/liquidity/minting.
  }
  else {
    logLine += " In range.";
  }

  if (logThisBlock) console.log(logLine);
}

async function main() {
  // Get the pool's immutables once only.
  const i = await getPoolImmutables();

  // From the Uniswap v3 whitepaper:
  //   "Ticks are all 1.0001 to an integer power, which means each tick is .01% away from the next
  //    tick."
  // Note that .01% is one basis point ("bip"), so every tick is a single bip change in price.
  // But the tick spacing in our pool is 60, so we'd be wise to make our range width a multiple of
  // that.
  // Percent   bips (ticks)
  // -------   ------------
  //    0.6%             60
  //    1.2%            120
  //    1.8%            180
  //    2.4%            240
  //    3.0%            300
  const rangeWidthTicks = 0.006 / 0.0001;
  console.log("Range width in ticks: " + rangeWidthTicks);

  dro = new DRO(i,
    new Token(CHAIN_ID, i.token0, 6, "USDC", "USD Coin"),
    new Token(CHAIN_ID, i.token1, 18, "WETH", "Wrapped Ether"),
    rangeWidthTicks);

  // Get a callback to onBlock() on every new block.
  PROVIDER.on('block', onBlock);
}
  
main().catch(console.error);
