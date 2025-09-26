const fs = require("fs");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying Marketplace with:", deployer.address);

  const fee = await ethers.provider.getFeeData();
  let overrides = {};
  if (fee.maxFeePerGas && fee.maxPriorityFeePerGas) {
    const bump = (x) => x.mul(12).div(10);
    overrides = {
      maxFeePerGas: bump(fee.maxFeePerGas),
      maxPriorityFeePerGas: bump(fee.maxPriorityFeePerGas || fee.maxFeePerGas.div(2)),
    };
  } else if (fee.gasPrice) {
    const bump = (x) => x.mul(12).div(10);
    overrides = { gasPrice: bump(fee.gasPrice) };
  }

  const Factory = await ethers.getContractFactory("Marketplace");
  const market = await Factory.deploy(overrides);
  await market.deployed();

  console.log("Marketplace deployed to:", market.address);
  fs.writeFileSync("marketplace_address.txt", market.address);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});