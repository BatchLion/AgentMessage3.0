import { XMTPClient } from './xmtp-client';
import { IdentityContract } from './contract';
import { ESpaceFunding } from './funding';
import { AgentData, XMTPMessage, XMTPConversation, ContractEntry } from './types';
import * as crypto from 'crypto';
import * as fs from 'fs-extra';
import { ethers } from 'ethers';

export class Agent {
  private xmtpClient: XMTPClient;
  private contract: IdentityContract;
  private agentData: Map<string, AgentData> = new Map();

  constructor(xmtpClient: XMTPClient, contract: IdentityContract) {
    this.xmtpClient = xmtpClient;
    this.contract = contract;
  }

  async registerId(
    name: string,
    description: string = "",
    capabilities: string[] = []
  ): Promise<{ 
    agent_id: string; 
    name: string;
    description: string;
    capabilities: string[];
    address: string; 
    xmtp_address: string; 
    tx_hash?: string; 
    status: string;
  }> {
    // Generate new identity first to get the wallet address
    const privateKey = crypto.randomBytes(32).toString('hex');
    const privateKeyWithPrefix = '0x' + privateKey;
    const wallet = new ethers.Wallet(privateKeyWithPrefix);
    const address = wallet.address;
    const xmtpAddress = address; // XMTP uses same address
    
    // Use wallet address as agent_id (matching Python version behavior)
    const agentId = address;

    // Create agent data
    const agentData: AgentData = {
      name,
      description,
      capabilities,
      address,
      xmtpAddress,
      privateKey: privateKeyWithPrefix,
      isOnline: false
    };

    // Store agent data
    this.agentData.set(agentId, agentData);

    // Save encrypted data to file
    const password = process.env.AGENTMESSAGE_ENCRYPTION_PASSWORD || 'default_password';
    const encryptedData = this.encryptAgentData(agentData, password);
    await this.saveEncryptedData(agentId, encryptedData);

    // Register agent to blockchain contract (like Python version)
    let txHash: string | undefined;
    try {
      // Check if account has sufficient balance for gas
      const balance = await this.contract.getBalance(address);
      const minBalance = BigInt('1000000000000000000'); // 1 ETH in wei
      
      if (balance < minBalance) {
        console.log(`Agent ${agentId} has insufficient balance (${balance} wei). Attempting to fund...`);
        
        // Try to fund the account
        const funding = new ESpaceFunding();
        try {
          await funding.fundESpaceAccount(address);
          console.log(`Successfully funded agent ${address}`);
          
          // Verify balance after funding
          const newBalance = await this.contract.getBalance(address);
          const newBalanceEth = parseFloat(ethers.formatEther(newBalance));
          console.log(`New balance: ${newBalanceEth} ETH`);
          
          if (newBalance >= BigInt('10000000000000000')) { // 0.01 ETH minimum for contract registration
            const metadata = JSON.stringify({
              name,
              description,
              capabilities,
              xmtp: {
                address: xmtpAddress
              }
            });
            
            txHash = await this.contract.register(address, metadata, privateKeyWithPrefix);
            console.log(`Agent ${agentId} registered to contract with tx: ${txHash}`);
          } else {
            console.log(`Balance still insufficient after funding. Skipping contract registration.`);
          }
        } catch (fundingError) {
          console.error('Failed to fund agent account:', fundingError);
          console.log('Skipping contract registration due to funding failure.');
        }
      } else {
        const metadata = JSON.stringify({
          name,
          description,
          capabilities,
          xmtp: {
            address: xmtpAddress
          }
        });
        
        txHash = await this.contract.register(address, metadata, privateKeyWithPrefix);
        console.log(`Agent ${agentId} registered to contract with tx: ${txHash}`);
      }
    } catch (error) {
      console.error(`Failed to register agent ${agentId} to contract:`, error);
      // Continue without failing - agent is still registered locally
    }

    return {
      agent_id: agentId,
      name,
      description,
      capabilities,
      address,
      xmtp_address: xmtpAddress,
      tx_hash: txHash,
      status: "new_agent_registered"
    };
  }

  async recallId(
    agent_id: string,
    password: string,
  ): Promise<{ 
    agent_id: string; 
    name: string;
    description: string;
    capabilities: string[];
    address: string; 
    xmtp_address: string; 
    tx_hash?: string; 
    status: string;
  }> {
    // Check if agent already exists
    const encryptedData = await this.loadEncryptedData(agent_id);
    const existing = this.decryptAgentData(encryptedData, password);

    return {
      agent_id: agent_id,
      name: existing.name || "",
      description: existing.description || "",
      capabilities: existing.capabilities || [],
      address: existing.address,
      xmtp_address: existing.xmtpAddress,
      status: "existing_identity_returned"
    };
  }

  async goOnline(agentId: string, password: string): Promise<boolean> {
    try {
      // Load encrypted data
      const encryptedData = await this.loadEncryptedData(agentId);
      const agentData = this.decryptAgentData(encryptedData, password);
      
      // Create XMTP client
      await this.xmtpClient.getOrCreateClient(agentId, agentData.privateKey);
      
      // Store in memory
      this.agentData.set(agentId, agentData);
      
      return true;
    } catch (error) {
      console.error(`Failed to go online: ${error}`);
      return false;
    }
  }

  async collectIdentities(): Promise<ContractEntry[]> {
    try {
      return await this.contract.getAllEntries();
    } catch (error) {
      console.error(`Failed to collect identities: ${error}`);
      return [];
    }
  }

  async sendMessage(
    agentId: string,
    recipientAddress: string,
    message: string,
    options?: { contentType?: 'text' | 'reply' | 'remote_attachment' | 'attachment'; replyTo?: string }
  ): Promise<{ messageId: string; conversationId: string; sentAt: string }> {
    if (!this.agentData.has(agentId)) {
      throw new Error('Agent not registered or not online');
    }

    return await this.xmtpClient.sendMessage(agentId, recipientAddress, message as any, options);
  }

  async checkNewMessages(
    agentId: string,
    conversationId?: string,
    limit: number = 50,
    cursor?: string,
    startTime?: string,
    endTime?: string
  ): Promise<XMTPMessage[]> {
    if (!this.agentData.has(agentId)) {
      throw new Error('Agent not registered or not online');
    }

    return await this.xmtpClient.getMessages(agentId, conversationId, limit, cursor, startTime, endTime);
  }

  async getConversations(agentId: string, limit?: number, createdAfter?: string, createdBefore?: string): Promise<XMTPConversation[]> {
    if (!this.agentData.has(agentId)) {
      throw new Error('Agent not registered or not online');
    }

    return await this.xmtpClient.getConversations(agentId, limit, createdAfter, createdBefore);
  }

  async createGroup(
    agentId: string,
    participantAddresses: string[],
    groupName?: string
  ): Promise<{ groupId: string; topic: string; participants: string[] }> {
    if (!this.agentData.has(agentId)) {
      throw new Error('Agent not registered or not online');
    }

    return await this.xmtpClient.createGroup(agentId, participantAddresses, groupName);
  }

  async sendGroupMessage(
    agentId: string,
    groupId: string,
    message: any,
    options?: { contentType?: 'text' | 'reply' | 'remote_attachment' | 'attachment'; replyTo?: string; referenceInboxId?: string }
  ): Promise<{ messageId: string; conversationId: string; sentAt: string }> {
    if (!this.agentData.has(agentId)) {
      throw new Error('Agent not registered or not online');
    }
    return await this.xmtpClient.sendGroupMessage(agentId, groupId, message, options);
  }

  async addMembersToGroupByAddresses(
    agentId: string,
    groupId: string,
    participantAddresses: string[],
  ): Promise<{ groupId: string; added: string[] }> {
    if (!this.agentData.has(agentId)) {
      throw new Error('Agent not registered or not online');
    }
    return await this.xmtpClient.addMembersToGroupByAddresses(agentId, groupId, participantAddresses);
  }

  async addAdminsByAddresses(
    agentId: string,
    groupId: string,
    addresses: string[],
  ): Promise<{ groupId: string; promoted: string[]; alreadyAdmin: string[]; notFound: string[]; failed?: Array<{ address: string; error: string }> }> {
    if (!this.agentData.has(agentId)) {
      throw new Error('Agent not registered or not online');
    }
    return await this.xmtpClient.addAdminsByAddresses(agentId, groupId, addresses);
  }

  async removeAdminsByAddresses(
    agentId: string,
    groupId: string,
    addresses: string[],
  ): Promise<{ groupId: string; demoted: string[]; notAdmin: string[]; notFound: string[]; failed?: Array<{ address: string; error: string }> }> {
    if (!this.agentData.has(agentId)) {
      throw new Error('Agent not registered or not online');
    }
    return await this.xmtpClient.removeAdminsByAddresses(agentId, groupId, addresses);
  }

  async listGroupMembers(agentId: string, groupId: string): Promise<{ groupId: string; members: Array<{ address: string | null; inboxId: string; permissionLevel?: number }>; admins?: Array<{ address: string | null; inboxId: string }>; superAdmins?: Array<{ address: string | null; inboxId: string }> }> {
    if (!this.agentData.has(agentId)) {
      throw new Error('Agent not registered or not online');
    }
    return await this.xmtpClient.listGroupMembers(agentId, groupId);
  }

  private encryptAgentData(data: AgentData, password: string): string {
    const key = crypto.scryptSync(password, 'salt', 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    
    let encrypted = cipher.update(JSON.stringify(data), 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    return JSON.stringify({
      iv: iv.toString('hex'),
      encrypted,
    });
  }

  private decryptAgentData(encryptedData: string, password: string): AgentData {
    const { iv, encrypted } = JSON.parse(encryptedData);
    const key = crypto.scryptSync(password, 'salt', 32);
    const ivBuffer = Buffer.from(iv, 'hex');
    
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, ivBuffer);
    
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return JSON.parse(decrypted);
  }

  private async saveEncryptedData(agentId: string, encryptedData: string): Promise<void> {
    const dataDir = './agent_data';
    await fs.ensureDir(dataDir);
    await fs.writeFile(`${dataDir}/${agentId}.json`, encryptedData);
  }

  private async loadEncryptedData(agentId: string): Promise<string> {
    const filePath = `./agent_data/${agentId}.json`;
    return await fs.readFile(filePath, 'utf8');
  }

  isOnline(agentId: string): boolean {
    return this.agentData.has(agentId) && this.xmtpClient.hasClient(agentId);
  }

  getActiveAgentsCount(): number {
    return this.agentData.size;
  }

  getAgentNameByAddress(address: string): string | null {
    const normalized = (address || '').toLowerCase();
    for (const [, data] of this.agentData.entries()) {
      if ((data.address || '').toLowerCase() === normalized) {
        return data.name || null;
      }
    }
    return null;
  }
}