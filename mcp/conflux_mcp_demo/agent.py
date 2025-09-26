from .contract import IdentityContract

class Agent:
    def __init__(self, agent_id, contract, storage=None):
        self.agent_id = agent_id
        self.contract = contract

    def register_recall_id(self, metadata="{}"):
        tx_hash = self.contract.register(self.agent_id, metadata)
        return {"agent_id": self.agent_id, "tx_hash": tx_hash}

    def go_online(self):
        self.storage["online_agents"].add(self.agent_id)
        return {"status": "online", "agent_id": self.agent_id}

    @staticmethod
    def collect_identities(storage):
        return list(storage["online_agents"])

    def send_message(self, to_agents, content):
        msg = {"from": self.agent_id, "to": to_agents, "content": content}
        self.storage["messages"].append(msg)
        return {"sent": len(to_agents)}

    def check_new_messages(self):
        return [m for m in self.storage["messages"] if self.agent_id in m["to"]]
