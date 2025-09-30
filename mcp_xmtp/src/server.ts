import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { XMTPClient } from './xmtp-client';
import { IdentityContract } from './contract';
import { Agent } from './agent';

const app = express();
const port = process.env.PORT || 58548;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize services
const xmtpClient = new XMTPClient();
const contract = new IdentityContract(
  process.env.CONFLUX_RPC_URL || 'https://evm.confluxrpc.com',
  process.env.IDENTITY_CONTRACT_ADDRESS_FILE || process.env.IDENTITY_CONTRACT_ADDRESS || '../hardhat/contract_address.txt',
  process.env.IDENTITY_CONTRACT_ABI_PATH || '../hardhat/artifacts/contracts/IdentityRegistry.sol/IdentityRegistry.json'
);
const agent = new Agent(xmtpClient, contract);

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    active_agents: agent.getActiveAgentsCount(),
    active_xmtp_clients: xmtpClient.getActiveClientsCount()
  });
});

// Register ID endpoint
app.post('/register_id', async (req: Request, res: Response) => {
  try {
    const { name, description = "", capabilities = [] } = req.body;

    if (!name) {
      return res.status(400).json({
        error: 'name is required'
      });
    }

    const result = await agent.registerId(name, description, capabilities);
    
    res.json({
      success: true,
      ...result
    });
  } catch (error: any) {
    console.error('Register ID error:', error);
    res.status(500).json({
      error: error.message || 'Failed to register ID'
    });
  }
});

// Recall ID endpoint
app.post('/recall_id', async (req: Request, res: Response) => {
  try {
    const { agent_id, password } = req.body;

    if (!agent_id) {
      return res.status(400).json({
        error: 'agent_id is required'
      });
    }
    if (!password) {
      return res.status(400).json({
        error: 'password is required'
      });
    }

    const result = await agent.recallId(agent_id, password);
    
    res.json({
      success: true,
      ...result
    });
  } catch (error: any) {
    console.error('Recall ID error:', error);
    res.status(500).json({
      error: error.message || 'Failed to recall ID'
    });
  }
});

// Go online endpoint
app.post('/go_online', async (req: Request, res: Response) => {
  try {
    const { agent_id, password } = req.body;

    if (!agent_id || !password) {
      return res.status(400).json({
        error: 'agent_id and password are required'
      });
    }

    const success = await agent.goOnline(agent_id, password);
    
    if (success) {
      res.json({
        success: true,
        message: 'Agent is now online'
      });
    } else {
      res.status(400).json({
        error: 'Failed to go online'
      });
    }
  } catch (error: any) {
    console.error('Go online error:', error);
    res.status(500).json({
      error: error.message || 'Failed to go online'
    });
  }
});

// Collect identities endpoint
app.get('/collect_identities', async (req: Request, res: Response) => {
  try {
    const identities = await agent.collectIdentities();
    
    res.json({
      success: true,
      agents: identities
    });
  } catch (error: any) {
    console.error('Collect identities error:', error);
    res.status(500).json({
      error: error.message || 'Failed to collect identities'
    });
  }
});

// Send message endpoint
app.post('/xmtp/send', async (req: Request, res: Response) => {
  try {
    const { agent_id, recipient_address, message, content_type, reply_to } = req.body;

    if (!agent_id || !recipient_address || !message) {
      return res.status(400).json({
        error: 'agent_id, recipient_address, and message are required'
      });
    }

    const result = await agent.sendMessage(agent_id, recipient_address, message, {
      contentType: content_type,
      replyTo: reply_to,
    } as any);
    
    res.json({
      success: true,
      ...result
    });
  } catch (error: any) {
    console.error('Send message error:', error);
    res.status(500).json({
      error: error.message || 'Failed to send message'
    });
  }
});

// Get messages endpoint
app.get('/xmtp/messages', async (req: Request, res: Response) => {
  try {
    const { agent_id, conversation_id, limit, cursor, start_time, end_time } = req.query as any;

    if (!agent_id) {
      return res.status(400).json({
        error: 'agent_id is required'
      });
    }

    const messages = await agent.checkNewMessages(
      agent_id as string,
      conversation_id as string,
      limit ? parseInt(limit as string) : 50,
      cursor as string | undefined,
      start_time as string | undefined,
      end_time as string | undefined,
    );
    
    res.json({
      success: true,
      messages
    });
  } catch (error: any) {
    console.error('Get messages error:', error);
    res.status(500).json({
      error: error.message || 'Failed to get messages'
    });
  }
});

// Get conversations endpoint
app.get('/xmtp/conversations', async (req: Request, res: Response) => {
  try {
    const { agent_id, limit, created_after, created_before } = req.query as any;

    if (!agent_id) {
      return res.status(400).json({
        error: 'agent_id is required'
      });
    }

    const conversations = await agent.getConversations(
      agent_id as string,
      typeof limit !== 'undefined' ? parseInt(limit) : undefined,
      created_after as string | undefined,
      created_before as string | undefined,
    );
    
    res.json({
      success: true,
      conversations
    });
  } catch (error: any) {
    console.error('Get conversations error:', error);
    res.status(500).json({
      error: error.message || 'Failed to get conversations'
    });
  }
});

// Create group endpoint
app.post('/xmtp/groups/create', async (req: Request, res: Response) => {
  try {
    const { agent_id, participant_addresses, group_name } = req.body;

    if (!agent_id || !participant_addresses || !Array.isArray(participant_addresses)) {
      return res.status(400).json({
        error: 'agent_id and participant_addresses (array) are required'
      });
    }

    const result = await agent.createGroup(agent_id, participant_addresses, group_name);
    
    res.json({
      success: true,
      ...result
    });
  } catch (error: any) {
    console.error('Create group error:', error);
    res.status(500).json({
      error: error.message || 'Failed to create group'
    });
  }
});

// Agent status endpoint
app.get('/agent/status/:agent_id', async (req: Request, res: Response) => {
  try {
    const { agent_id } = req.params;
    const isOnline = agent.isOnline(agent_id);
    
    res.json({
      success: true,
      agent_id,
      online: isOnline
    });
  } catch (error: any) {
    console.error('Agent status error:', error);
    res.status(500).json({
      error: error.message || 'Failed to get agent status'
    });
  }
});

// Convenience endpoint: send a reply
app.post('/xmtp/send_reply', async (req: Request, res: Response) => {
  try {
    const { agent_id, recipient_address, message, reply_to } = req.body;
    if (!agent_id || !recipient_address || !message || !reply_to) {
      return res.status(400).json({ error: 'agent_id, recipient_address, message, and reply_to are required' });
    }
    const result = await agent.sendMessage(agent_id, recipient_address, message, {
      contentType: 'reply',
      replyTo: reply_to,
    });
    res.json({ success: true, ...result });
  } catch (error: any) {
    console.error('Send reply error:', error);
    res.status(500).json({ error: error.message || 'Failed to send reply' });
  }
});

// Convenience endpoint: send an attachment (small inline)
app.post('/xmtp/send_attachment', async (req: Request, res: Response) => {
  try {
    const { agent_id, recipient_address, filename, mimeType, data } = req.body;
    if (!agent_id || !recipient_address || !filename || !mimeType || !data) {
      return res.status(400).json({ error: 'agent_id, recipient_address, filename, mimeType, and data are required' });
    }
    const message = { filename, mimeType, data };
    const result = await agent.sendMessage(agent_id, recipient_address, message as any, {
      contentType: 'attachment',
    });
    res.json({ success: true, ...result });
  } catch (error: any) {
    console.error('Send attachment error:', error);
    res.status(500).json({ error: error.message || 'Failed to send attachment' });
  }
});

app.post('/xmtp/send_group', async (req: Request, res: Response) => {
  try {
    const { agent_id, group_id, message, content_type, reply_to, reference_inbox_id } = req.body;

    if (!agent_id || !group_id || !message) {
      return res.status(400).json({
        error: 'agent_id, group_id, and message are required'
      });
    }

    const result = await agent.sendGroupMessage(agent_id, group_id, message as any, {
      contentType: content_type,
      replyTo: reply_to,
      referenceInboxId: reference_inbox_id,
    } as any);

    res.json({
      success: true,
      ...result
    });
  } catch (error: any) {
    console.error('Send group message error:', error);
    res.status(500).json({
      error: error.message || 'Failed to send group message'
    });
  }
});

app.post('/xmtp/groups/add_members', async (req: Request, res: Response) => {
  try {
    const { admin_agent_id, group_id, participant_addresses } = req.body;

    if (!admin_agent_id || !group_id || !participant_addresses || !Array.isArray(participant_addresses)) {
      return res.status(400).json({
        error: 'admin_agent_id, group_id, and participant_addresses (array) are required'
      });
    }

    const result = await agent.addMembersToGroupByAddresses(admin_agent_id, group_id, participant_addresses);

    res.json({ success: true, ...result });
  } catch (error: any) {
    console.error('Add group members error:', error);
    res.status(500).json({ error: error.message || 'Failed to add group members' });
  }
});

app.post('/xmtp/groups/add_admins', async (req: Request, res: Response) => {
  try {
    const { agent_id, group_id, addresses } = req.body;
    if (!agent_id || !group_id || !addresses || !Array.isArray(addresses)) {
      return res.status(400).json({ error: 'agent_id, group_id, and addresses (array) are required' });
    }
    const result = await agent.addAdminsByAddresses(agent_id, group_id, addresses);
    // Resolve agent names where possible
    const promotedWithNames = (result.promoted || []).map((addr: string) => ({ address: addr, agentName: agent.getAgentNameByAddress(addr) }));
    const alreadyAdminWithNames = (result.alreadyAdmin || []).map((addr: string) => ({ address: addr, agentName: agent.getAgentNameByAddress(addr) }));
    const notFoundWithNames = (result.notFound || []).map((addr: string) => ({ address: addr, agentName: agent.getAgentNameByAddress(addr) }));
    const failed = (result.failed || []).map((f: any) => ({ address: f.address, agentName: agent.getAgentNameByAddress(f.address), error: f.error }));
    res.json({ success: true, groupId: result.groupId, promoted: promotedWithNames, alreadyAdmin: alreadyAdminWithNames, notFound: notFoundWithNames, failed });
  } catch (error: any) {
    console.error('Add group admins error:', error);
    res.status(500).json({ error: error.message || 'Failed to add group admins' });
  }
});

app.post('/xmtp/groups/remove_admins', async (req: Request, res: Response) => {
  try {
    const { agent_id, group_id, addresses } = req.body;
    if (!agent_id || !group_id || !addresses || !Array.isArray(addresses)) {
      return res.status(400).json({ error: 'agent_id, group_id, and addresses (array) are required' });
    }
    const result = await agent.removeAdminsByAddresses(agent_id, group_id, addresses);
    const demotedWithNames = (result.demoted || []).map((addr: string) => ({ address: addr, agentName: agent.getAgentNameByAddress(addr) }));
    const notAdminWithNames = (result.notAdmin || []).map((addr: string) => ({ address: addr, agentName: agent.getAgentNameByAddress(addr) }));
    const notFoundWithNames = (result.notFound || []).map((addr: string) => ({ address: addr, agentName: agent.getAgentNameByAddress(addr) }));
    const failed = (result.failed || []).map((f: any) => ({ address: f.address, agentName: agent.getAgentNameByAddress(f.address), error: f.error }));
    res.json({ success: true, groupId: result.groupId, demoted: demotedWithNames, notAdmin: notAdminWithNames, notFound: notFoundWithNames, failed });
  } catch (error: any) {
    console.error('Remove group admins error:', error);
    res.status(500).json({ error: error.message || 'Failed to remove group admins' });
  }
});

app.get('/xmtp/groups/members', async (req: Request, res: Response) => {
  try {
    const { agent_id, group_id } = req.query as any;

    if (!agent_id || !group_id) {
      return res.status(400).json({ error: 'agent_id and group_id are required' });
    }

    const result = await agent.listGroupMembers(agent_id, group_id);

    // Resolve agent names from known registered agents by address if available
    const membersWithNames = (result.members || []).map((m: any) => ({
      address: m.address,
      agentName: m.address ? agent.getAgentNameByAddress(m.address) : null,
      permissionLevel: m.permissionLevel,
    }));

    const admins = (result.admins || []).map((a: any) => ({
      address: a.address,
      agentName: a.address ? agent.getAgentNameByAddress(a.address) : null,
    }));
    const superAdmins = (result.superAdmins || []).map((s: any) => ({
      address: s.address,
      agentName: s.address ? agent.getAgentNameByAddress(s.address) : null,
    }));

    res.json({ success: true, groupId: result.groupId, members: membersWithNames, admins, superAdmins });
  } catch (error: any) {
    console.error('List group members error:', error);
    res.status(500).json({ error: error.message || 'Failed to list group members' });
  }
});

// Error handling middleware
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error'
  });
});

// 404 handler (must be last middleware)
app.use((req: Request, res: Response) => {
  res.status(404).json({
    error: 'Endpoint not found'
  });
});

// Start server
app.listen(port, () => {
  console.log(`MCP XMTP Server running on port ${port}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`XMTP Environment: ${process.env.XMTP_ENV || 'dev'}`);
});

export default app;