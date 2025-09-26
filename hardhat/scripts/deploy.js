const fs = require("fs");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with:", deployer.address);

  // Fetch fee data and bump by 20% to avoid 'transaction underpriced'
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

  const Registry = await ethers.getContractFactory("IdentityRegistry");
  const registry = await Registry.deploy(overrides);
  await registry.deployed();

  console.log("Contract deployed to:", registry.address);
  fs.writeFileSync("contract_address.txt", registry.address);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});