import json
import os
import time
from web3 import Web3

ESPACE_RPC_URL = os.getenv("ESPACE_RPC_URL", "http://conflux:8545")
REGISTRY_ADDRESS = os.getenv("REGISTRY_ADDRESS")  # 0x... address on eSpace
OUT_PATH = os.getenv("OUT_PATH", "registered_events.jsonl")

ABI = [
  {
    "anonymous": False,
    "inputs": [
      {"indexed": True, "name": "owner", "type": "address"},
      {"indexed": False, "name": "agentId", "type": "string"},
      {"indexed": False, "name": "metadata", "type": "string"},
      {"indexed": False, "name": "updatedAt", "type": "uint256"}
    ],
    "name": "Registered",
    "type": "event"
  }
]

def main():
    if not REGISTRY_ADDRESS:
        raise SystemExit("Set REGISTRY_ADDRESS=0x... for IdentityRegistry on eSpace")

    w3 = Web3(Web3.HTTPProvider(ESPACE_RPC_URL))
    if not w3.is_connected():
        raise SystemExit(f"Cannot connect to {ESPACE_RPC_URL}")

    contract = w3.eth.contract(address=Web3.to_checksum_address(REGISTRY_ADDRESS), abi=ABI)
    event = contract.events.Registered

    # Start from latest to avoid historical catch-up; adjust if you want history
    latest = w3.eth.block_number
    from_block = latest

    print(f"Listening from block {from_block} on {ESPACE_RPC_URL} for {REGISTRY_ADDRESS}")
    while True:
        try:
            to_block = w3.eth.block_number
            if to_block >= from_block:
                logs = event().get_logs(from_block=from_block, to_block=to_block)
                if logs:
                    with open(OUT_PATH, "a") as f:
                        for log in logs:
                            rec = {
                                "blockNumber": log.blockNumber,
                                "txHash": log.transactionHash.hex(),
                                "owner": log.args.owner,
                                "agentId": log.args.agentId,
                                "metadata": log.args.metadata,
                                "updatedAt": int(log.args.updatedAt),
                            }
                            f.write(json.dumps(rec) + "\n")
                            print(f"Registered event: {rec}")
                from_block = to_block + 1
            time.sleep(2)
        except KeyboardInterrupt:
            print("Stopped by user")
            break
        except Exception as e:
            print(f"Error: {e}")
            time.sleep(5)

if __name__ == "__main__":
    main()