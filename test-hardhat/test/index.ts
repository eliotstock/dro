import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { TestUsdc } from "../typechain";

describe("Test USDC", function () {
  let testUsdc: TestUsdc;
  let deployer: SignerWithAddress;
  let recipient: SignerWithAddress;

  before(async () => {
    const testUsdcFactory = await ethers.getContractFactory("TestUsdc");
    testUsdc = await testUsdcFactory.deploy();
    await testUsdc.deployed();
  });

  it("Should have the symbol USDC", async function () {
    expect(await testUsdc.symbol()).to.equal("USDC");
  });

  it("Should have 6 decimals", async function () {
    expect(await testUsdc.decimals()).to.equal(6);
  });

  it("Should have 1B total supply", async function () {
    expect(await testUsdc.totalSupply()).to.equal(1_000_000_000);
  });

  it("Should have its total supply owned by the deployer initially", async function () {
    [deployer] = await ethers.getSigners();

    expect(await testUsdc.balanceOf(deployer.address)).to.equal(1_000_000_000);
  });

  it("Should be transferable by the deployer", async function () {
    [deployer, recipient] = await ethers.getSigners();

    await network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [deployer.address],
    });

    let tx = await testUsdc.transfer(recipient.address, 100_000_000);
    // console.dir(tx);

    let result = await tx.wait();
    // console.dir(result);

    expect(await testUsdc.balanceOf(recipient.address)).to.equal(100_000_000);
    expect(await testUsdc.balanceOf(deployer.address)).to.equal(900_000_000);
  })
});
