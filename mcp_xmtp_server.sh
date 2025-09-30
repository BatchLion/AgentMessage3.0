#!/bin/bash
# Start Conflux Core Space Node
docker compose up conflux -d
export CORE_PK=$(awk -F'"' '/mining_key/ {print $2}' < <(docker exec -i conflux-node /bin/sh -lc 'pwd; ls -la; [ -f conflux.toml ] && { echo "-- conflux.toml (top) --"; sed -n "1,160p" conflux.toml; } || { echo "-- searching for conflux.toml --"; find / -maxdepth 3 -name conflux.toml 2>/dev/null | head -n 5; }'))
cd hardhat 
npm i -s js-conflux-sdk@^2
eval "$(node -e 'const {Wallet}=require("ethers");const w=Wallet.createRandom();console.log("export DEPLOYER_PRIVATE_KEY="+w.privateKey);console.log("export ESPACE_TO="+w.address)')"
cd ..

docker compose run --rm -e CORE_PK="$CORE_PK" -e ESPACE_TO="$ESPACE_TO" hardhat /bin/bash -lc '
   npm ci --no-audit --no-fund >/dev/null 2>&1
     node <<'"'"'JS'"'"'
     const { Conflux, Drip } = require("js-conflux-sdk");
     (async () => {
       const probe = new Conflux({ url: "http://conflux:12537" });
        const status = await probe.cfx.getStatus();
        const networkId = status.networkId;
        const conflux = new Conflux({ url: "http://conflux:12537", networkId });
        const account = conflux.wallet.addPrivateKey(process.env.CORE_PK);
        const cross = conflux.InternalContract("CrossSpaceCall");
        const to = process.env.ESPACE_TO;
        const receipt = await cross.transferEVM(to)
        .sendTransaction({ from: account, value: Drip.fromCFX(1) })
        .executed();
        console.log(JSON.stringify({ networkId, to, tx: receipt.transactionHash, outcomeStatus: receipt.outcomeStatus }, null, 2));
        })().catch((e) => { console.error(e); process.exit(1); });


'"'"'JS'"'"'
'

docker compose run --rm -e DEPLOYER_PRIVATE_KEY="$DEPLOYER_PRIVATE_KEY" hardhat /bin/bash -lc 'npm ci --no-audit --no-fund && npx hardhat compile && npx hardhat run scripts/deploy.js --network local'
export CONTRACT_ADDR=$(sed -n '1p' hardhat/contract_address.txt)
export CORE_NETWORK_ID=$(curl -s -X POST http://localhost:12537 -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","method":"cfx_getStatus","params":[],"id":11}' | jq -r '.result.networkId')
cd mcp_xmtp

set -euo pipefail
if [ -z "${CORE_PK:-}" ] || [ -z "${CORE_NETWORK_ID:-}" ]; then echo "ERROR: CORE_PK or CORE_NETWORK_ID not set in current shell."; exit 1; fi
cp .env ".env.bak.$(date +%Y%m%d%H%M%S)"
awk -v pk="$CORE_PK" -v net="$CORE_NETWORK_ID" '
BEGIN{foundPK=0; foundNET=0}
{
  if ($0 ~ /^CORE_PK=/) { print "CORE_PK=" pk; foundPK=1; next }
  else if ($0 ~ /^CORE_NETWORK_ID=/) { print "CORE_NETWORK_ID=" net; foundNET=1; next }
  else { print }
}
END{
  if (!foundPK) print "CORE_PK=" pk
  if (!foundNET) print "CORE_NETWORK_ID=" net
}' .env > .env.tmp && mv .env.tmp .env
echo "Updated .env with CORE_PK and CORE_NETWORK_ID. Backup created."

npm run dev