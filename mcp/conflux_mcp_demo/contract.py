from web3 import Web3
import json
import statistics

class IdentityContract:
    def __init__(self, rpc_url, contract_address, abi_path="IdentityRegistry.json"):
        self.w3 = Web3(Web3.HTTPProvider(rpc_url))
        with open(abi_path) as f:
            artifact = json.load(f)
        abi = artifact["abi"] if isinstance(artifact, dict) and "abi" in artifact else artifact
        self.contract = self.w3.eth.contract(address=contract_address, abi=abi)

    def _raw_tx_bytes(self, signed):
        # eth-account changed attribute name across versions
        raw = getattr(signed, "rawTransaction", None)
        if raw is None:
            raw = getattr(signed, "raw_transaction", None)
        if raw is None:
            # Some versions expose .rawTransaction as bytes-like mapping
            try:
                raw = signed["rawTransaction"]  # type: ignore[index]
            except Exception:
                pass
        if raw is None:
            raise AttributeError("SignedTransaction missing raw transaction bytes")
        return raw

    def register(self, agent_id, metadata, private_key):
        if not private_key:
            raise ValueError("private_key is required to sign the transaction")
        # Use the provided key as the signer so msg.sender == agent address
        local_account = self.w3.eth.account.from_key(private_key)
        chain_id = self.w3.eth.chain_id
        latest_block = self.w3.eth.get_block("latest")
        eip1559_supported = isinstance(latest_block, dict) and ("baseFeePerGas" in latest_block)
        # Build transaction with EIP-1559 if supported, otherwise legacy gasPrice
        common = {
            "from": local_account.address,
            "nonce": self.w3.eth.get_transaction_count(local_account.address),
            "gas": 1000000,
            "chainId": chain_id,
        }
        if eip1559_supported:
            try:
                # Use eth_feeHistory to estimate median tip and a robust fee cap
                fh = self.w3.eth.fee_history(10, "latest", [50])
                rewards = [r[0] for r in fh.get("reward", []) if isinstance(r, (list, tuple)) and len(r) > 0]
                if rewards:
                    tip = int(statistics.median(rewards))
                else:
                    tip = Web3.to_wei(2, "gwei")
                base_fees = fh.get("baseFeePerGas", [])
                if base_fees:
                    # Next block suggested base fee is the last element
                    next_base = int(base_fees[-1])
                else:
                    next_base = int(latest_block["baseFeePerGas"])
                # Enforce a sane minimum tip
                if tip < Web3.to_wei(1, "gwei"):
                    tip = Web3.to_wei(1, "gwei")
                # Robust cap: 2x next base fee + median tip
                max_fee = next_base * 2 + tip
            except Exception:
                # Fallback to simple heuristic if feeHistory is unavailable
                base_fee = int(latest_block["baseFeePerGas"])
                tip = Web3.to_wei(2, "gwei")
                max_fee = base_fee * 2 + tip
            fee_fields = {
                "maxPriorityFeePerGas": tip,
                "maxFeePerGas": max_fee,
                "type": 2,
            }
            tx = self.contract.functions.register(agent_id, metadata).build_transaction({**common, **fee_fields})
        else:
            legacy_fields = {
                "gasPrice": self.w3.eth.gas_price,
            }
            tx = self.contract.functions.register(agent_id, metadata).build_transaction({**common, **legacy_fields})
        signed = local_account.sign_transaction(tx)
        raw = self._raw_tx_bytes(signed)
        tx_hash = self.w3.eth.send_raw_transaction(raw)
        return tx_hash.hex()

    def get_entry(self, address):
        return self.contract.functions.getEntry(address).call()

    def get_all_entries(self, from_block: int = 0, to_block: str | int = "latest"):
        # Scan Registered events to discover all owners, then read current entries
        topic0 = self.w3.keccak(text="Registered(address,string,string,uint256)").hex()
        address = Web3.to_checksum_address(self.contract.address)
        logs = self.w3.eth.get_logs({
            "address": address,
            "fromBlock": from_block,
            "toBlock": to_block,
            "topics": [topic0],
        })
        owners_lower = []
        seen = set()
        for log in logs:
            # owner is the first indexed topic (topics[1])
            t1 = log["topics"][1].hex()
            owner = Web3.to_checksum_address("0x" + t1[-40:])
            low = owner.lower()
            if low not in seen:
                seen.add(low)
                owners_lower.append(owner)
        entries = []
        for owner in owners_lower:
            try:
                e = self.contract.functions.getEntry(owner).call()
                entries.append(e)
            except Exception:
                continue
        return entries