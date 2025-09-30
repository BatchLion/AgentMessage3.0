export interface AgentData {
  agentId?: string;
  name?: string;
  description?: string;
  capabilities?: string[];
  privateKey: string;
  address: string;
  xmtpAddress: string;
  espacePrivateKey?: string;
  createdAt?: string;
  isOnline?: boolean;
}

export interface XMTPMessage {
  id: string;
  content: string;
  sender: string;
  sent_at: string;
  conversation_id: string;
}

export interface XMTPConversation {
  id: string;
  topic: string;
  peer_address: string;
  created_at?: string;
  last_message?: {
    content: string;
    sender: string;
    sent_at: string;
  };
}

export interface MessageEnvelope {
  type: string;
  from: string;
  to?: string;
  group?: string;
  ts: number;
  body: any;
  sig?: string;
  sig_alg?: string;
}

export interface WakuEnvelope {
  pubsubTopic: string;
  contentTopic: string;
  timestamp: number;
  payload: MessageEnvelope;
}

export interface ContractEntry {
  owner: string;
  agentId: string;
  metadata: string;
  updatedAt: number;
}

export interface GroupInfo {
  group: string;
  members: number;
}

export interface GroupMembers {
  group: string;
  members: string[];
}