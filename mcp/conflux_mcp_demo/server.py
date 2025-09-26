import os
import json
from fastapi import FastAPI, Body
# from .agent import Agent  # removed
from .contract import IdentityContract
# from .storage import storage  # removed
from eth_keys import keys as _ethkeys
from .waku_client import WakuClient
from typing import Dict, List, Optional, Any

# Added imports for background worker and data structures
import threading
import time
from collections import deque
from decimal import Decimal
import hmac
import hashlib
import base64

# Configuration via environment variables with sensible defaults
RPC_URL = os.getenv("RPC_URL", "http://conflux:8545")
CONTRACT_ADDRESS_OR_PATH = os.getenv("CONTRACT_ADDRESS", "0x...")
ABI_PATH = os.getenv(
    "ABI_PATH",
    "/hardhat/artifacts/contracts/IdentityRegistry.sol/IdentityRegistry.json",
)

# If CONTRACT_ADDRESS is a path to a file, read the address from it
if os.path.isfile(CONTRACT_ADDRESS_OR_PATH):
    try:
        with open(CONTRACT_ADDRESS_OR_PATH, "r") as f:
            CONTRACT_ADDRESS = f.read().strip()
    except Exception:
        CONTRACT_ADDRESS = CONTRACT_ADDRESS_OR_PATH
else:
    CONTRACT_ADDRESS = CONTRACT_ADDRESS_OR_PATH

contract = IdentityContract(RPC_URL, CONTRACT_ADDRESS, abi_path=ABI_PATH)
# agent = Agent("agent-001", contract, storage)  # removed

app = FastAPI()

# --- Waku setup (Phase 1: relay + filter + store) ---
WAKU_NODE_URL = os.getenv("WAKU_NODE_URL", "http://localhost:8645")
WAKU_PUBSUB_TOPIC = os.getenv("WAKU_PUBSUB_TOPIC", "/app/agents/1")
waku_client = WakuClient(WAKU_NODE_URL)

# Simple in-memory subscription registry: agent_id -> subscription_id
_subs_by_agent: Dict[str, str] = {}
# Per-agent in-memory inbox queue (lightweight background subscriber will fill this)
_inbox_by_agent: Dict[str, deque] = {}
# In-memory group membership: group_id -> set(agent_id)
_group_members: Dict[str, set] = {}
# Lock to protect subscriptions and group memberships
_subs_lock = threading.Lock()


def _direct_content_topic(agent_id: str) -> str:
    return f"/agents/1/direct/{agent_id.lower()}"


def _group_content_topic(group_id: str) -> str:
    return f"/agents/1/group/{group_id}"


def _current_topics_for_agent(agent_id: str) -> List[str]:
    topics = [_direct_content_topic(agent_id)]
    for gid, members in _group_members.items():
        if agent_id.lower() in members:
            topics.append(_group_content_topic(gid))
    return topics


def _ensure_inbox(agent_id: str) -> deque:
    aid = agent_id.lower()
    if aid not in _inbox_by_agent:
        _inbox_by_agent[aid] = deque(maxlen=200)
    return _inbox_by_agent[aid]


def _refresh_subscription(agent_id: str) -> str:
    """Recreate filter subscription for the agent with current topics."""
    aid = agent_id.lower()
    with _subs_lock:
        old = _subs_by_agent.get(aid)
        topics = _current_topics_for_agent(aid)
        if old:
            try:
                waku_client.filter_unsubscribe(old)
            except Exception:
                pass
        sub_id = waku_client.filter_subscribe(topics)
        _subs_by_agent[aid] = sub_id
        return sub_id


# Dedup cache and store backfill config
_DEDUP_MAX = int(os.getenv("WAKU_DEDUP_MAX", "500"))
_STORE_BACKFILL_INTERVAL = int(os.getenv("WAKU_STORE_BACKFILL_INTERVAL", "10"))
_dedup_cache: Dict[str, Dict[str, Any]] = {}  # agent_id -> {"deque": deque, "set": set}
_last_store_query_ts: Dict[str, float] = {}


def _ensure_dedup(aid: str):
    if aid not in _dedup_cache:
        _dedup_cache[aid] = {"deque": deque(maxlen=_DEDUP_MAX), "set": set()}
    return _dedup_cache[aid]


def _fingerprint_envelope(env: Dict[str, Any]) -> str:
    try:
        return hashlib.sha256(json.dumps(env, separators=(",", ":"), sort_keys=True).encode("utf-8")).hexdigest()
    except Exception:
        return hashlib.sha256(str(env).encode("utf-8")).hexdigest()


def _is_new_and_mark(aid: str, fp: str) -> bool:
    cache = _ensure_dedup(aid)
    s = cache["set"]
    dq = cache["deque"]
    if fp in s:
        return False
    # Mark new
    if len(dq) == dq.maxlen and dq.maxlen:
        # Evict oldest
        oldest = dq[0]
        dq.popleft()
        s.discard(oldest)
    dq.append(fp)
    s.add(fp)
    return True


def _verify_hmac_envelope(envelope: Dict[str, Any]) -> bool:
    secret = os.getenv("MESSAGE_HMAC_SECRET")
    if not secret:
        return False
    sig = envelope.get("sig")
    if not sig:
        return False
    base = {
        k: envelope.get(k)
        for k in ["type", "from", "to", "group", "ts", "body"]
        if k in envelope
    }
    try:
        canonical = json.dumps(base, separators=(",", ":"), sort_keys=True).encode("utf-8")
    except Exception:
        return False
    expected = hmac.new(secret.encode("utf-8"), canonical, hashlib.sha256).hexdigest()
    return hmac.compare_digest(sig, expected)


# --- Core->eSpace funding helper ---

def _fund_espace_or_raise(espace_address: str) -> str:
    """Transfer CFX from Core Space to given eSpace address using CrossSpaceCall.transferEVM.
    This is mandatory: raise an exception on any failure, and wait for on-chain confirmation.
    Returns tx hash on success.
    """
    from fastapi import HTTPException

    core_pk = os.getenv("CORE_PK")
    core_rpc = os.getenv("CORE_RPC_URL", "http://conflux:12537")
    amount_cfx = os.getenv("ESPACE_FUND_AMOUNT_CFX")

    # Validate amount and compute required funding value (in Drip)
    if not amount_cfx:
        raise HTTPException(status_code=500, detail="ESPACE_FUND_AMOUNT_CFX is not set; cannot fund eSpace account")
    try:
        amt = Decimal(str(amount_cfx))
    except Exception:
        raise HTTPException(status_code=500, detail="ESPACE_FUND_AMOUNT_CFX is invalid; must be numeric")
    if amt <= 0:
        raise HTTPException(status_code=500, detail="ESPACE_FUND_AMOUNT_CFX must be > 0")

    value = int(amt * Decimal(10**18))

    # Pre-check current eSpace balance and skip funding if already sufficient
    try:
        bal = contract.w3.eth.get_balance(espace_address)
        if bal is not None and bal >= value:
            try:
                print(f"[fund] skip: existing eSpace balance {bal} >= required {value}, no funding needed", flush=True)
            except Exception:
                pass
            return "SKIPPED"
    except Exception:
        # If balance check fails, proceed to attempt funding
        pass

    # Only require CORE_PK when we actually need to fund
    if not core_pk:
        raise HTTPException(status_code=500, detail="CORE_PK is not set; cannot fund eSpace account")

    try:
        from conflux_web3 import Web3 as CWeb3
        from cfx_account import Account as CfxAccount
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Conflux SDK import failed: {e}")

    def _dbg(msg: str):
        try:
            print(f"[fund] {msg}", flush=True)
        except Exception:
            pass

    try:
        c = CWeb3(CWeb3.HTTPProvider(core_rpc))
        acct = CfxAccount.from_key(core_pk)
        # Resolve Core network id to produce proper CIP-37 base32 addresses
        try:
            network_id = int(c.cfx.chain_id)
        except Exception:
            network_id = None

        # Convert sender and internal contract address to CIP-37 base32 explicitly
        def to_base32(addr: str) -> str:
            return c.address(addr, network_id=network_id) if network_id is not None else c.address(addr)

        sender_hex_maybe = getattr(acct, "address", None)
        try:
            sender_b32 = to_base32(sender_hex_maybe)
        except Exception:
            # Fallback: derive address again via w3.account to ensure base32
            sender_b32 = to_base32(CWeb3.to_checksum_address(sender_hex_maybe)) if isinstance(sender_hex_maybe, str) else to_base32(str(sender_hex_maybe))

        internal_addr_hex = "0x0888000000000000000000000000000000000006"
        try:
            internal_addr_b32 = to_base32(internal_addr_hex)
        except Exception:
            internal_addr_b32 = internal_addr_hex

        # Manual ABI encode: transferEVM(bytes20)
        selector = CWeb3.keccak(text="transferEVM(bytes20)")[:4]
        # Normalize eSpace address to 20 bytes (lowercase hex without 0x)
        to_bytes20 = bytes.fromhex(espace_address[2:].lower())
        param = to_bytes20 + (b"\x00" * 12)  # right-pad to 32 bytes
        data = (selector + param).hex()
        # value already computed above from amt
        try:
            nonce = c.cfx.get_next_nonce(sender_b32)
        except Exception:
            nonce = c.cfx.get_transaction_count(sender_b32)
        try:
            epoch_height = c.cfx.epoch_number
            epoch_height = epoch_height if isinstance(epoch_height, int) else int(epoch_height)
        except Exception:
            epoch_height = 0
        try:
            gas_price = c.cfx.gas_price
        except Exception:
            gas_price = 1
        # Minimal gas/storage defaults
        gas = 300000
        storage_limit = 2048

        _dbg(f"sender_b32={sender_b32} internal_b32={internal_addr_b32} sender_hex_or_obj={sender_hex_maybe} espace_hex={espace_address} nonce={nonce} epoch={epoch_height} chainId={c.cfx.chain_id} gas={gas} storageLimit={storage_limit}")

        tx = {
            "from": sender_b32,  # explicitly use CIP-37 base32
            "to": internal_addr_b32,  # also use CIP-37 base32 for internal contract
            "value": value,
            "data": "0x" + data,
            "nonce": nonce,
            "gas": gas,
            "gasPrice": gas_price,
            "storageLimit": storage_limit,
            "epochHeight": epoch_height,
            "chainId": c.cfx.chain_id,
        }
        signed = acct.sign_transaction(tx)
        tx_hash = c.cfx.send_raw_transaction(signed.raw_transaction)

        _dbg(f"sent tx={tx_hash} waiting receipt...")

        # Wait for on-chain confirmation
        receipt = c.cfx.wait_for_transaction_receipt(tx_hash)
        _dbg(f"receipt outcomeStatus={receipt.get('outcomeStatus') if isinstance(receipt, dict) else receipt}")
        if not receipt or int(receipt.get("outcomeStatus", 1)) != 0:
            raise HTTPException(status_code=500, detail=f"Funding failed, receipt: {receipt}")
        # Wait eSpace balance
        deadline = time.time() + 60
        while time.time() < deadline:
            try:
                bal = contract.w3.eth.get_balance(espace_address)
                if bal and bal >= value:
                    break
            except Exception:
                pass
            time.sleep(1.0)
        else:
            raise HTTPException(status_code=500, detail="Timed out waiting for eSpace balance to reflect funding")

        return tx_hash.hex() if hasattr(tx_hash, "hex") else str(tx_hash)
    except HTTPException:
        raise
    except Exception as e:
        _dbg(f"exception: {e}")
        raise HTTPException(status_code=500, detail=f"Funding error: {e}")


# Background poller to fetch messages for each active subscription and fill inboxes
_bg_thread_started = False

def _bg_poll_loop():
    while True:
        try:
            with _subs_lock:
                items = list(_subs_by_agent.items())
            now = time.time()
            for aid, sub_id in items:
                # 1) Filter poll
                try:
                    msgs = waku_client.filter_get_messages(sub_id) or []
                except Exception:
                    msgs = []
                for m in msgs:
                    payload_hex = m.get("payload") or m.get("message", {}).get("payload")
                    try:
                        raw = _decode_waku_payload(payload_hex)
                        body = json.loads(raw.decode("utf-8"))
                    except Exception:
                        body = None
                    if isinstance(body, dict) and _verify_hmac_envelope(body):
                        env = {
                            "pubsubTopic": m.get("pubsubTopic"),
                            "contentTopic": m.get("contentTopic") or m.get("message", {}).get("contentTopic"),
                            "timestamp": m.get("timestamp") or m.get("message", {}).get("timestamp"),
                            "payload": body,
                        }
                        fp = _fingerprint_envelope(env)
                        if _is_new_and_mark(aid, fp):
                            _ensure_inbox(aid).append(env)
                # 2) Store backfill (periodic)
                last = _last_store_query_ts.get(aid, 0)
                if now - last >= _STORE_BACKFILL_INTERVAL:
                    _last_store_query_ts[aid] = now
                    topics = _current_topics_for_agent(aid)
                    for t in topics:
                        store_msgs = []
                        try:
                            res = waku_client.store_query([t], pubsub_topic=WAKU_PUBSUB_TOPIC)
                            store_msgs = res.get("messages", []) if isinstance(res, dict) else (res or [])
                        except Exception:
                            store_msgs = []
                        for sm in store_msgs:
                            payload_hex = sm.get("payload") or sm.get("message", {}).get("payload")
                            try:
                                raw = _decode_waku_payload(payload_hex)
                                body = json.loads(raw.decode("utf-8"))
                            except Exception:
                                body = None
                            if isinstance(body, dict) and _verify_hmac_envelope(body):
                                env = {
                                    "pubsubTopic": sm.get("pubsubTopic"),
                                    "contentTopic": sm.get("contentTopic") or sm.get("message", {}).get("contentTopic"),
                                    "timestamp": sm.get("timestamp") or sm.get("message", {}).get("timestamp"),
                                    "payload": body,
                                }
                                fp = _fingerprint_envelope(env)
                                if _is_new_and_mark(aid, fp):
                                    _ensure_inbox(aid).append(env)
        except Exception:
            pass
        time.sleep(1.0)


@app.on_event("startup")
def _start_bg_thread():
    global _bg_thread_started
    if not _bg_thread_started:
        t = threading.Thread(target=_bg_poll_loop, daemon=True)
        t.start()
        _bg_thread_started = True


@app.post("/register_recall_id")
def register_recall_id(
    name: str = Body(...),
    description: str = Body(default=""),
    capabilities: List[str] = Body(default=[]),
):
    # Check if any agent identity already exists in memory path, return existing identity if found, otherwise register new
    from fastapi import HTTPException
    from eth_account import Account
    from pathlib import Path
    from datetime import datetime
    import json as _json
    import os as _os
    import glob
    try:
        from nacl.public import PrivateKey as _X25519Priv
    except Exception:
        _X25519Priv = None  # pynacl optional at runtime; only pubkey publish used

    # 1) Read required environment variables
    mem_path = _os.getenv("AGENTMESSAGE_MEMORY_PATH")
    if not mem_path:
        raise HTTPException(status_code=500, detail="AGENTMESSAGE_MEMORY_PATH is not set")
    password = _os.getenv("AGENTMESSAGE_ENCRYPTION_PASSWORD")
    if not password:
        raise HTTPException(status_code=500, detail="AGENTMESSAGE_ENCRYPTION_PASSWORD is not set")

    # 2) Check if identity.json file exists in memory path directory
    mem_dir = Path(mem_path)
    identity_file = mem_dir / "identity.json"
    if identity_file.exists():
        try:
            with open(identity_file, "r") as f:
                agent_data = _json.load(f)
            if isinstance(agent_data, dict) and agent_data.get("agent_id"):
                # Found existing agent identity, return it (ignore input arguments)
                caps = agent_data.get("capabilities", [])
                waku_info = {
                    "pubKey": agent_data.get("waku_pubkey"),
                    "directTopic": agent_data.get("waku_direct_topic"),
                    "pubsub": agent_data.get("waku_pubsub_topic"),
                }
                return {
                    "agent_id": agent_data.get("agent_id"),
                    "name": agent_data.get("name"),
                    "description": agent_data.get("description", ""),
                    "capabilities": caps,
                    "waku": waku_info,
                    "memory_file": str(identity_file),
                    "tx_hash": "existing_agent_no_new_transaction",
                    "status": "existing_identity_returned"
                }
        except Exception:
            pass  # Continue with new registration if file read fails

    # 3) Create new agent identity since no existing one found
    acct = Account.create()
    priv_bytes = acct.key
    agent_address = acct.address  # this will act as agent_id
    public_key_hex = _ethkeys.PrivateKey(priv_bytes).public_key.to_hex()

    # 3b) Generate x25519 pubkey for future Waku encryption (store pub only, Phase 2 will use priv)
    waku_pub_hex: Optional[str] = None
    if _X25519Priv is not None:
        try:
            _x = _X25519Priv.generate()
            waku_pub_hex = "0x" + _x.public_key.encode().hex()
        except Exception:
            waku_pub_hex = None

    # 4) Encrypt private key to keystore JSON (never store raw private key)
    keystore = Account.encrypt(priv_bytes, password)

    # 5) Persist encrypted material and agent metadata into individual JSON file
    mem_dir.mkdir(parents=True, exist_ok=True)

    # Ensure capability includes waku-v2
    caps = list(dict.fromkeys(list(capabilities) + ["waku-v2"]))

    payload = {
        "agent_id": agent_address,
        "name": name,
        "description": description,
        "capabilities": caps,
        "public_key": public_key_hex,
        "keystore": keystore,
        "created_at": datetime.utcnow().isoformat() + "Z",
        # Waku discovery hints
        "waku_pubkey": waku_pub_hex,
        "waku_direct_topic": _direct_content_topic(agent_address),
        "waku_pubsub_topic": WAKU_PUBSUB_TOPIC,
    }

    # Save agent data to individual JSON file named identity.json
    agent_file = mem_dir / "identity.json"
    with open(agent_file, "w") as f:
        _json.dump(payload, f, indent=2)

    # 6) Fund eSpace account from Core Space and wait for confirmation
    _fund_espace_or_raise(agent_address)

    # 7) On-chain registration: use agent_address as agent_id and JSON metadata; sign with agent wallet
    metadata_obj = {
        "name": name,
        "description": description,
        "capabilities": caps,
        "waku": {
            "pubKey": waku_pub_hex,
            "directTopic": _direct_content_topic(agent_address),
            "pubsub": WAKU_PUBSUB_TOPIC,
        },
    }
    try:
        tx_hash = contract.register(agent_address, _json.dumps(metadata_obj), private_key=priv_bytes)
    except Exception as e:
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail=f"On-chain registration failed: {e}")

    # 8) Return useful, non-sensitive information
    return {
        "agent_id": agent_address,
        "name": name,
        "description": description,
        "capabilities": caps,
        "waku": metadata_obj["waku"],
        "memory_file": str(agent_file),
        "tx_hash": tx_hash,
        "status": "new_agent_registered"
    }

# Removed go_online, send_message, and check_new_messages endpoints

@app.get("/collect_identities")
def collect_identities():
    # Fetch all entries from on-chain storage by scanning events
    entries = contract.get_all_entries()
    # entries are tuples (owner, agentId, metadata, updatedAt)
    result = [
        {
            "owner": e[0],
            "agentId": e[1],
            "metadata": e[2],
            "updatedAt": e[3],
        }
        for e in entries
    ]
    return {"agents": result}


# --- Waku messaging endpoints (Phase 1) ---
@app.post("/waku/subscribe")
def waku_subscribe(agent_id: str = Body(...), groups: Optional[List[str]] = Body(default=None)):
    # Update group memberships first if provided
    if groups:
        with _subs_lock:
            for g in groups:
                _group_members.setdefault(g, set()).add(agent_id.lower())
    sub_id = _refresh_subscription(agent_id)
    return {"subscription_id": sub_id, "content_topics": _current_topics_for_agent(agent_id)}


@app.post("/waku/unsubscribe")
def waku_unsubscribe(agent_id: str = Body(...)):
    with _subs_lock:
        sub_id = _subs_by_agent.get(agent_id.lower())
        if not sub_id:
            return {"ok": True, "message": "No active subscription"}
        ok = waku_client.filter_unsubscribe(sub_id)
        _subs_by_agent.pop(agent_id.lower(), None)
    return {"ok": ok}


@app.get("/waku/messages")
def waku_messages(agent_id: str, max_items: int = 50):
    # Ensure subscription exists and reflects current groups
    _refresh_subscription(agent_id)
    inbox = _ensure_inbox(agent_id)
    out = []
    for _ in range(min(max_items, len(inbox))):
        try:
            out.append(inbox.popleft())
        except Exception:
            break
    return {"messages": out}


@app.post("/waku/send")
def waku_send(
    from_agent: str = Body(...),
    message: Any = Body(...),
    to_agent: Optional[str] = Body(default=None),
    group: Optional[str] = Body(default=None),
):
    from fastapi import HTTPException
    if (to_agent is None) == (group is None):
        raise HTTPException(status_code=400, detail="Provide exactly one of to_agent or group")

    # Choose topic
    content_topic = _direct_content_topic(to_agent) if to_agent else _group_content_topic(group)  # type: ignore[arg-type]

    # Build envelope body
    base_envelope = {
        "type": "chat",
        "from": from_agent,
        "to": to_agent,
        "group": group,
        "ts": int(time.time()),
        "body": message,
    }
    # HMAC signature (required)
    secret = os.getenv("MESSAGE_HMAC_SECRET")
    if not secret:
        raise HTTPException(status_code=500, detail="MESSAGE_HMAC_SECRET is not set; cannot sign messages")
    canonical = json.dumps(base_envelope, separators=(",", ":"), sort_keys=True).encode("utf-8")
    signature = hmac.new(secret.encode("utf-8"), canonical, hashlib.sha256).hexdigest()
    envelope = {**base_envelope, "sig": signature, "sig_alg": "HMAC-SHA256"}

    payload = json.dumps(envelope, separators=(",", ":")).encode("utf-8")

    # Publish
    try:
        result = waku_client.relay_publish(WAKU_PUBSUB_TOPIC, content_topic, payload)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Waku publish failed: {e}")

    # Local loopback delivery so recipients can read immediately even if REST Filter/Store is unavailable
    try:
        env = {
            "pubsubTopic": WAKU_PUBSUB_TOPIC,
            "contentTopic": content_topic,
            "timestamp": int(time.time() * 1_000_000_000),  # ns
            "payload": envelope,
        }
        if to_agent:
            targets = [to_agent.lower()]
        else:
            with _subs_lock:
                targets = sorted(list(_group_members.get(group, set())))  # type: ignore[arg-type]
        for aid in targets:
            fp = _fingerprint_envelope(env)
            if _is_new_and_mark(aid, fp):
                _ensure_inbox(aid).append(env)
    except Exception:
        # Non-fatal: best-effort local delivery
        pass

    return {
        "ok": True,
        "pubsub_topic": WAKU_PUBSUB_TOPIC,
        "content_topic": content_topic,
        "result": result,
    }

# --- Group listing endpoints ---
@app.get("/groups/list")
def groups_list():
    with _subs_lock:
        items = [{"group": gid, "members": len(members)} for gid, members in _group_members.items()]
    items.sort(key=lambda x: x["group"])  # stable order
    return {"groups": items}


@app.get("/groups/members")
def groups_members(group_id: str):
    with _subs_lock:
        members = sorted(list(_group_members.get(group_id, set())))
    return {"group": group_id, "members": members}


@app.post("/groups/create")
def groups_create(group_id: str = Body(...), creator: Optional[str] = Body(default=None)):
    gid = group_id
    with _subs_lock:
        if gid not in _group_members:
            _group_members[gid] = set()
        if creator:
            _group_members[gid].add(creator.lower())
    if creator:
        _refresh_subscription(creator)
    return {"ok": True, "group": gid, "members": sorted(list(_group_members[gid]))}


@app.post("/groups/join")
def groups_join(group_id: str = Body(...), agent_id: str = Body(...)):
    gid = group_id
    aid = agent_id.lower()
    with _subs_lock:
        _group_members.setdefault(gid, set()).add(aid)
    sub_id = _refresh_subscription(aid)
    return {"ok": True, "group": gid, "agent": aid, "subscription_id": sub_id}


@app.post("/groups/leave")
def groups_leave(group_id: str = Body(...), agent_id: str = Body(...)):
    gid = group_id
    aid = agent_id.lower()
    with _subs_lock:
        if gid in _group_members and aid in _group_members[gid]:
            _group_members[gid].remove(aid)
    sub_id = _refresh_subscription(aid)
    return {"ok": True, "group": gid, "agent": aid, "subscription_id": sub_id}


def _decode_waku_payload(payload_value: Any) -> bytes:
    """Decode Waku payload from hex (with or without 0x) or base64 to raw bytes."""
    if isinstance(payload_value, (bytes, bytearray)):
        return bytes(payload_value)
    if not isinstance(payload_value, str):
        return b""
    s = payload_value.strip()
    # Try hex with 0x prefix
    if s.startswith("0x"):
        try:
            return bytes.fromhex(s[2:])
        except Exception:
            pass
    # Try hex without prefix
    try:
        return bytes.fromhex(s)
    except Exception:
        pass
    # Try base64
    try:
        return base64.b64decode(s, validate=True)
    except Exception:
        return b""