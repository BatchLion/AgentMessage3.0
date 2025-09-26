import os
import time
from typing import Any, Dict, List, Optional

import requests
import base64


class WakuClient:
    """
    Minimal Waku v2 HTTP client for nwaku.
    Uses HTTP REST endpoints for relay publish and store query.
    Filter endpoints are currently not exposed via REST; methods are implemented as no-ops.
    """

    def __init__(self, rpc_url: Optional[str] = None, timeout: int = 10):
        self.rpc_url = rpc_url or os.getenv("WAKU_NODE_URL", "http://localhost:8645")
        self._id = 0
        self.timeout = timeout
        # Attempt to discover local peerId to use for Store queries
        self.peer_id: Optional[str] = None
        try:
            info_url = f"{self.rpc_url.rstrip('/')}/debug/v1/info"
            r = requests.get(info_url, timeout=self.timeout)
            if r.ok:
                data = r.json()
                addrs = data.get("listenAddresses") or []
                if addrs:
                    first = str(addrs[0])
                    if "/p2p/" in first:
                        self.peer_id = first.split("/p2p/")[-1]
        except Exception:
            self.peer_id = None

    def _rpc(self, method: str, params: Any) -> Any:
        self._id += 1
        payload = {"jsonrpc": "2.0", "id": self._id, "method": method, "params": params}
        resp = requests.post(self.rpc_url, json=payload, timeout=self.timeout)
        resp.raise_for_status()
        body = resp.json()
        if "error" in body:
            raise RuntimeError(body["error"])
        return body.get("result")

    # Relay publish: publish a message to a pubsub topic and content topic
    def relay_publish(self, pubsub_topic: str, content_topic: str, payload: bytes) -> str:
        # Publish via REST: /relay/v1/auto/messages expects base64 payload and contentTopic
        url = f"{self.rpc_url.rstrip('/')}/relay/v1/auto/messages"
        body = {
            "payload": base64.b64encode(payload).decode("ascii"),
            "contentTopic": content_topic,
        }
        resp = requests.post(url, json=body, timeout=self.timeout)
        resp.raise_for_status()
        try:
            return resp.json()
        except Exception:
            return resp.text

    # Filter subscribe returns a subscription ID
    def filter_subscribe(self, content_topics: List[str], pubsub_topic: Optional[str] = None) -> str:
        # REST API does not yet expose filter subscriptions; return a deterministic placeholder
        return f"rest:{','.join(content_topics)}"

    def filter_unsubscribe(self, subscription_id: str) -> bool:
        # No-op for REST; always return True
        return True

    def filter_get_messages(self, subscription_id: str) -> List[Dict[str, Any]]:
        # No-op for REST; rely on store backfill in server background loop
        return []

    # Store query for historical messages
    def store_query(
        self,
        content_topics: List[str],
        pubsub_topic: Optional[str] = None,
        start_time_ns: Optional[int] = None,
        end_time_ns: Optional[int] = None,
        page_size: int = 50,
        cursor: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        # Query via REST: /store/v1/messages with query parameters
        url = f"{self.rpc_url.rstrip('/')}/store/v1/messages"
        params: List[tuple] = [("contentTopics", t) for t in content_topics]
        params.append(("pageSize", str(page_size)))
        params.append(("ascending", "true"))
        if pubsub_topic:
            params.append(("pubsubTopic", pubsub_topic))
        if self.peer_id:
            params.append(("peerId", self.peer_id))
        if start_time_ns is not None:
            params.append(("startTime", str(start_time_ns)))
        if end_time_ns is not None:
            params.append(("endTime", str(end_time_ns)))
        # cursor support may vary; omit if not provided
        headers = {"Accept": "application/json"}
        resp = requests.get(url, params=params, headers=headers, timeout=self.timeout)
        resp.raise_for_status()
        return resp.json()