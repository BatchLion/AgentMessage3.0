import json
import os
import time
from web3 import Web3

ESPACE_RPC_URL = os.getenv("ESPACE_RPC_URL", "http://conflux:8545")
MARKETPLACE_ADDRESS = os.getenv("MARKETPLACE_ADDRESS")
MARKETPLACE_ADDRESS_FILE = os.getenv("MARKETPLACE_ADDRESS_FILE", "hardhat/marketplace_address.txt")
ARTIFACT_PATH = os.getenv("ARTIFACT_PATH", "hardhat/artifacts/contracts/Marketplace.sol/Marketplace.json")
OUT_PATH = os.getenv("OUT_PATH", "marketplace_events.jsonl")


def wait_for_address(max_tries: int = 60, sleep_sec: float = 2.0):
    # Try env var first
    if MARKETPLACE_ADDRESS:
        try:
            return Web3.to_checksum_address(MARKETPLACE_ADDRESS.strip())
        except Exception:
            pass
    # Then try file with retries
    tries = 0
    while tries < max_tries:
        if os.path.exists(MARKETPLACE_ADDRESS_FILE):
            try:
                with open(MARKETPLACE_ADDRESS_FILE, "r") as f:
                    addr = f.read().strip()
                    if addr:
                        return Web3.to_checksum_address(addr)
            except Exception:
                pass
        print(f"Waiting for marketplace address at {MARKETPLACE_ADDRESS_FILE} (attempt {tries+1}/{max_tries})")
        time.sleep(sleep_sec)
        tries += 1
    raise SystemExit("Set MARKETPLACE_ADDRESS or ensure MARKETPLACE_ADDRESS_FILE exists with a valid address")


def load_abi():
    if not os.path.exists(ARTIFACT_PATH):
        raise SystemExit(f"Artifact not found: {ARTIFACT_PATH}. Compile and deploy first.")
    with open(ARTIFACT_PATH, "r") as f:
        artifact = json.load(f)
    return artifact["abi"]


def append_jsonl(record):
    with open(OUT_PATH, "a") as f:
        f.write(json.dumps(record) + "\n")


def main():
    addr = wait_for_address()
    abi = load_abi()

    w3 = Web3(Web3.HTTPProvider(ESPACE_RPC_URL))
    if not w3.is_connected():
        raise SystemExit(f"Cannot connect to {ESPACE_RPC_URL}")

    contract = w3.eth.contract(address=addr, abi=abi)
    ev_listed = contract.events.Listed
    ev_purchased = contract.events.Purchased

    # Start from current tip; change to a lower block to backfill history
    from_block = w3.eth.block_number
    print(f"Listening Marketplace at {addr} from block {from_block} on {ESPACE_RPC_URL}")

    while True:
        try:
            to_block = w3.eth.block_number
            if to_block >= from_block:
                # Fetch both events in the block range (snake_case for web3.py v7)
                listed_logs = ev_listed().get_logs(from_block=from_block, to_block=to_block)
                purchased_logs = ev_purchased().get_logs(from_block=from_block, to_block=to_block)

                for log in listed_logs:
                    rec = {
                        "type": "Listed",
                        "blockNumber": log.blockNumber,
                        "txHash": log.transactionHash.hex(),
                        "id": log.args.id.hex() if hasattr(log.args.id, "hex") else str(log.args.id),
                        "seller": log.args.seller,
                        "price": int(log.args.price),
                        "uri": log.args.uri,
                        "contentHash": log.args.contentHash.hex() if hasattr(log.args.contentHash, "hex") else str(log.args.contentHash),
                    }
                    append_jsonl(rec)
                    print(f"Listed: {rec}")

                for log in purchased_logs:
                    rec = {
                        "type": "Purchased",
                        "blockNumber": log.blockNumber,
                        "txHash": log.transactionHash.hex(),
                        "id": log.args.id.hex() if hasattr(log.args.id, "hex") else str(log.args.id),
                        "buyer": log.args.buyer,
                        "price": int(log.args.price),
                    }
                    append_jsonl(rec)
                    print(f"Purchased: {rec}")

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