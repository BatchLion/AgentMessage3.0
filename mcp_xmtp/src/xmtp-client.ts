import { Client, IdentifierKind } from '@xmtp/node-sdk';
import { ethers } from 'ethers';
import { XMTPMessage, XMTPConversation } from './types';

export class XMTPClient {
  // Relax type parameter to avoid invariance issues from SDK generics
  private clients: Map<string, any> = new Map();
  // Store each agent's wallet address to resolve caller inboxId in group membership
  private clientAddresses: Map<string, string> = new Map();

  async getOrCreateClient(agentId: string, privateKey: string): Promise<any> {
    if (this.clients.has(agentId)) {
      return this.clients.get(agentId)!;
    }

    try {
      const wallet = new ethers.Wallet(privateKey);
      
      // Create a signer adapter for the XMTP SDK v4
      const signer = {
        type: "EOA" as const,
        signMessage: async (message: string): Promise<Uint8Array> => {
          const signature = await wallet.signMessage(message);
          // Convert hex signature to Uint8Array
          return ethers.getBytes(signature);
        },
        getIdentifier: () => ({
          identifier: wallet.address.toLowerCase(),
          identifierKind: IdentifierKind.Ethereum,
        }),
      };

      // Best-effort register codecs for richer content types via Client options
      const codecs: any[] = [];
      try {
        const ra = await import('@xmtp/content-type-remote-attachment');
        if (ra?.AttachmentCodec) codecs.push(new ra.AttachmentCodec());
        if (ra?.RemoteAttachmentCodec) codecs.push(new ra.RemoteAttachmentCodec());
      } catch (e) {
        console.warn('Remote attachment codecs not available (optional):', (e as Error)?.message);
      }
      try {
        const r = await import('@xmtp/content-type-reply');
        if (r?.ReplyCodec) codecs.push(new r.ReplyCodec());
      } catch (e) {
        console.warn('Reply codec not available (optional):', (e as Error)?.message);
      }

      const envVar = (process.env.XMTP_ENV || 'dev').toLowerCase();
      const env: 'dev' | 'local' | 'production' = envVar === 'production' || envVar === 'prod'
        ? 'production'
        : envVar === 'local'
        ? 'local'
        : 'dev';
      const client = await Client.create(signer, { env, ...(codecs.length ? { codecs } : {}) });

      // Removed optional explicit codec registration: Node SDK v4 does not expose registerCodec

      this.clients.set(agentId, client);
      // Persist the agent's wallet address for later caller inbox resolution
      this.clientAddresses.set(agentId, wallet.address.toLowerCase());
      console.log(`XMTP client created for agent ${agentId} with address ${wallet.address}`);
      
      return client;
    } catch (error) {
      throw new Error(`Failed to create XMTP client: ${error}`);
    }
  }

  async sendMessage(
    agentId: string, 
    recipientAddress: string, 
    message: any,
    options?: { contentType?: 'text' | 'reply' | 'remote_attachment' | 'attachment'; replyTo?: string }
  ): Promise<{ messageId: string; conversationId: string; sentAt: string }> {
    const client = this.clients.get(agentId);
    if (!client) {
      throw new Error('XMTP client not found for agent');
    }

    try {
      // Build recipient identifier
      const recipientIdentifier = {
        identifier: recipientAddress.toLowerCase(),
        identifierKind: IdentifierKind.Ethereum,
      };

      // Ensure codecs are registered (idempotent)
      // Removed: client.registerCodec calls are not supported in Node SDK v4

      // Check if the recipient can receive messages
      const canMessageMap = await client.canMessage([recipientIdentifier]);
      if (!canMessageMap.get(recipientIdentifier.identifier)) {
        throw new Error(`Recipient ${recipientAddress} cannot receive XMTP messages`);
      }

      // Create or get a DM conversation with the identifier
      const conversation = await client.conversations.newDmWithIdentifier(recipientIdentifier);
      
      // Send based on content type
      let messageId: string;
      const ct = options?.contentType ?? 'text';
      if (ct === 'reply') {
        const { ContentTypeReply } = await import('@xmtp/content-type-reply');
        const { ContentTypeText } = await import('@xmtp/content-type-text');
        if (!options?.replyTo) {
          throw new Error('replyTo (reference message id) is required for reply content type');
        }
        const replyPayload = {
          reference: options.replyTo,
          contentType: ContentTypeText,
          content: typeof message === 'string' ? message : String(message)
        };
        // Pass ContentTypeId directly as the second argument per Node SDK v4 signature
        messageId = await (conversation as any).send(replyPayload as any, ContentTypeReply as any);
      } else if (ct === 'remote_attachment') {
        const { ContentTypeRemoteAttachment } = await import('@xmtp/content-type-remote-attachment');
        messageId = await (conversation as any).send(message, ContentTypeRemoteAttachment as any);
      } else if (ct === 'attachment') {
        const { ContentTypeAttachment } = await import('@xmtp/content-type-remote-attachment');
        const payload = { ...message };
        if (Array.isArray(payload?.data)) {
          payload.data = new Uint8Array(payload.data);
        }
        messageId = await (conversation as any).send(payload, ContentTypeAttachment as any);
      } else {
        // default text
        messageId = await (conversation as any).send(typeof message === 'string' ? message : JSON.stringify(message));
      }
      
      return {
        messageId,
        conversationId: (conversation as any).id,
        sentAt: new Date().toISOString(),
      };
    } catch (error) {
      throw new Error(`Failed to send message: ${error}`);
    }
  }

  async createGroup(
    agentId: string, 
    participantAddresses: string[], 
    groupName?: string
  ): Promise<{ groupId: string; topic: string; participants: string[] }> {
    const client = this.clients.get(agentId);
    if (!client) {
      throw new Error('XMTP client not found for agent');
    }

    try {
      // Build member identifiers
      const identifiers = Array.from(new Set(participantAddresses.map(a => a.toLowerCase()))).map(addr => ({
        identifier: addr,
        identifierKind: IdentifierKind.Ethereum,
      }));

      const options: any = {};
      if (groupName) options.groupName = groupName;

      // Prefer the identifiers-based group creation (SDK v4)
      const group = await (client.conversations as any).newGroupWithIdentifiers(identifiers, options);
      return {
        groupId: (group as any).id ?? (group as any).conversation?.id ?? 'unknown',
        topic: (group as any).id ?? (group as any).conversation?.id ?? 'unknown',
        participants: participantAddresses,
      };
    } catch (error) {
      throw new Error(`Failed to create group: ${error}`);
    }
  }

  async getMessages(
    agentId: string, 
    conversationId?: string, 
    limit: number = 50,
    cursor?: string,
    startTime?: string,
    endTime?: string
  ): Promise<XMTPMessage[]> {
    const client = this.clients.get(agentId);
    if (!client) {
      throw new Error('XMTP client not found for agent');
    }

    try {
      // Ensure conversations are synced with the network before listing/fetching messages
      await (client.conversations as any).sync?.();
      const conversations = await client.conversations.list();
      let messages: any[] = [];

      const opts: any = { limit };
      if (cursor) opts.cursor = cursor;
      if (startTime) opts.startTime = new Date(startTime);
      if (endTime) opts.endTime = new Date(endTime);

      if (conversationId) {
        // Find specific conversation by id
        const conversation = (conversations as any[]).find((conv: any) => conv.id === conversationId);
        if (conversation) {
          // Sync the specific conversation before fetching messages (if available)
          await (conversation as any).sync?.();
          const convMessages = await (conversation as any).messages(opts);
          messages = convMessages ?? [];
        }
      } else {
        // Get messages from all conversations
        for (const conversation of conversations as any[]) {
          await (conversation as any).sync?.();
          const perConvOpts = { ...opts, limit: Math.ceil(limit / Math.max((conversations as any[]).length, 1)) };
          const convMessages = await (conversation as any).messages(perConvOpts);
          if (Array.isArray(convMessages)) messages.push(...convMessages);
        }
      }

      return messages.map((msg: any) => ({
        id: msg.id,
        content: (typeof msg.content === 'string' 
          ? msg.content 
          : (msg.fallback ? String(msg.fallback) : (() => { try { return JSON.stringify(msg.content); } catch { return ''; } })())),
        sender: msg.senderInboxId,
        sent_at: (msg.sentAt instanceof Date ? msg.sentAt : new Date(msg.sentAt)).toISOString(),
        conversation_id: msg.conversationId,
      }));
    } catch (error) {
      throw new Error(`Failed to get messages: ${error}`);
    }
  }

  async getConversations(agentId: string, limit?: number, createdAfter?: string, createdBefore?: string): Promise<XMTPConversation[]> {
    const client = this.clients.get(agentId);
    if (!client) {
      throw new Error('XMTP client not found for agent');
    }

    try {
      // Sync conversations to populate latest DM/group threads
      await (client.conversations as any).sync?.();
      const listOpts: any = {};
      if (typeof limit === 'number') listOpts.limit = limit;
      if (createdAfter) listOpts.createdAfter = new Date(createdAfter);
      if (createdBefore) listOpts.createdBefore = new Date(createdBefore);
      const conversations = await client.conversations.list(listOpts);
      
      return (conversations as any[]).map((conv: any) => ({
        id: conv.id,
        topic: conv.id, // Backward-compatible field name
        peer_address: (typeof conv.peerInboxId === 'string' ? conv.peerInboxId : ''),
        created_at: (conv.createdAt instanceof Date ? conv.createdAt : new Date(conv.createdAt)).toISOString(),
      }));
    } catch (error) {
      throw new Error(`Failed to get conversations: ${error}`);
    }
  }

  getActiveClientsCount(): number {
    return this.clients.size;
  }

  hasClient(agentId: string): boolean {
    return this.clients.has(agentId);
  }

  async sendGroupMessage(
    agentId: string,
    groupId: string,
    message: any,
    options?: { contentType?: 'text' | 'reply' | 'remote_attachment' | 'attachment'; replyTo?: string; referenceInboxId?: string }
  ): Promise<{ messageId: string; conversationId: string; sentAt: string }> {
    const client = this.clients.get(agentId);
    if (!client) {
      throw new Error('XMTP client not found for agent');
    }

    try {
      // Ensure conversations are synced and locate the target group conversation by id
      try { await (client.conversations as any).syncAll?.(['allowed']); } catch {}
      await (client.conversations as any).sync?.();
      const conversations = await client.conversations.list();
      const conversation = (conversations as any[]).find((conv: any) => conv.id === groupId);
      if (!conversation) {
        throw new Error(`Group conversation not found for id: ${groupId}`);
      }
      await (conversation as any).sync?.();

      // Send based on content type
      let messageId: string;
      const ct = options?.contentType ?? 'text';

      if (ct === 'reply') {
        const { ContentTypeReply } = await import('@xmtp/content-type-reply');
        const { ContentTypeText } = await import('@xmtp/content-type-text');
        if (!options?.replyTo) {
          throw new Error('replyTo (reference message id) is required for reply content type');
        }
        const replyPayload: any = {
          reference: options.replyTo,
          contentType: ContentTypeText,
          content: typeof message === 'string' ? message : String(message)
        };
        if (options?.referenceInboxId) {
          replyPayload.referenceInboxId = options.referenceInboxId;
        }
        messageId = await (conversation as any).send(replyPayload, ContentTypeReply as any);
      } else if (ct === 'remote_attachment') {
        const { ContentTypeRemoteAttachment } = await import('@xmtp/content-type-remote-attachment');
        messageId = await (conversation as any).send(message, ContentTypeRemoteAttachment as any);
      } else if (ct === 'attachment') {
        const { ContentTypeAttachment } = await import('@xmtp/content-type-remote-attachment');
        const payload = { ...message };
        if (Array.isArray(payload?.data)) {
          payload.data = new Uint8Array(payload.data);
        }
        messageId = await (conversation as any).send(payload, ContentTypeAttachment as any);
      } else {
        // default text
        messageId = await (conversation as any).send(typeof message === 'string' ? message : JSON.stringify(message));
      }

      return {
        messageId,
        conversationId: (conversation as any).id,
        sentAt: new Date().toISOString(),
      };
    } catch (error) {
      throw new Error(`Failed to send group message: ${error}`);
    }
  }

  // Helper: resolve caller's inboxId by matching the agent's wallet address against group membership
  private async getCallerInboxId(agentId: string, groupId: string): Promise<string | null> {
    const callerAddr = this.clientAddresses.get(agentId);
    if (!callerAddr) return null;
    try {
      const membership = await this.listGroupMembers(agentId, groupId);
      const match = (membership.members || []).find(m => (m.address || '').toLowerCase() === callerAddr);
      return match?.inboxId || null;
    } catch {
      return null;
    }
  }

  async addMembersToGroupByAddresses(
    agentId: string,
    groupId: string,
    participantAddresses: string[],
  ): Promise<{ groupId: string; added: string[] }> {
    const client = this.clients.get(agentId);
    if (!client) {
      throw new Error('XMTP client not found for agent');
    }

    // Sync and locate the group conversation by id
    try { await (client.conversations as any).syncAll?.(['allowed']); } catch {}
    await (client.conversations as any).sync?.();
    const conversations = await client.conversations.list();
    const conversation = (conversations as any[]).find((conv: any) => conv.id === groupId);
    if (!conversation) {
      throw new Error(`Group conversation not found for id: ${groupId}`);
    }
    await (conversation as any).sync?.();

    // Enforce membership changes by admins OR superAdmins (resolve caller inboxId via membership)
    const callerInboxId = await this.getCallerInboxId(agentId, groupId);
    if (!callerInboxId) {
      throw new Error('Unable to resolve caller inbox; ensure the agent is a member of this group');
    }
    const isAdmin = typeof (conversation as any).isAdmin === 'function' && (conversation as any).isAdmin(callerInboxId);
    const isSuperAdmin = typeof (conversation as any).isSuperAdmin === 'function' && (conversation as any).isSuperAdmin(callerInboxId);
    if (!isAdmin && !isSuperAdmin) {
      throw new Error('Membership changes are restricted to admins or superAdmins; caller lacks permission');
    }

    // Normalize and dedupe addresses
    const uniqueAddrs = Array.from(new Set((participantAddresses || []).map(a => a.toLowerCase())));
    if (uniqueAddrs.length === 0) {
      return { groupId: (conversation as any).id, added: [] };
    }

    // Build identifiers for SDK call (Ethereum addresses)
    const identifiers = uniqueAddrs.map(addr => ({
      identifier: addr,
      identifierKind: IdentifierKind.Ethereum,
    }));

    // Add members by identifiers
    await (conversation as any).addMembersByIdentifiers(identifiers);

    return {
      groupId: (conversation as any).id,
      added: uniqueAddrs,
    };
  }

  async addAdminsByAddresses(
    agentId: string,
    groupId: string,
    addresses: string[],
  ): Promise<{ groupId: string; promoted: string[]; alreadyAdmin: string[]; notFound: string[]; failed?: Array<{ address: string; error: string }> }> {
    const client = this.clients.get(agentId);
    if (!client) {
      throw new Error('XMTP client not found for agent');
    }

    try { await (client.conversations as any).syncAll?.(['allowed']); } catch {}
    await (client.conversations as any).sync?.();
    const conversations = await client.conversations.list();
    const conversation = (conversations as any[]).find((conv: any) => conv.id === groupId);
    if (!conversation) {
      throw new Error(`Group conversation not found for id: ${groupId}`);
    }
    await (conversation as any).sync?.();

    // Only superAdmins can change admin roles (resolve caller inboxId)
    const callerInboxId = await this.getCallerInboxId(agentId, groupId);
    if (!callerInboxId) {
      throw new Error('Unable to resolve caller inbox; ensure the agent is a member of this group');
    }
    const isSuperAdmin = typeof (conversation as any).isSuperAdmin === 'function' && (conversation as any).isSuperAdmin(callerInboxId);
    if (!isSuperAdmin) {
      throw new Error('Admin role changes are restricted to superAdmins; caller lacks permission');
    }

    const targetAddrs = Array.from(new Set((addresses || []).map(a => a.toLowerCase())));
    if (targetAddrs.length === 0) {
      return { groupId: (conversation as any).id, promoted: [], alreadyAdmin: [], notFound: [] };
    }

    // Map addresses -> inboxIds using existing member list
    const membership = await this.listGroupMembers(agentId, groupId);
    const addrToInbox = new Map<string, string>();
    for (const m of membership.members) {
      if (m.address) addrToInbox.set(m.address.toLowerCase(), m.inboxId);
    }

    // Prepare sets of current admins/superAdmins
    const adminInboxIds = new Set<string>((membership.admins || []).map(a => a.inboxId));
    const superAdminInboxIds = new Set<string>((membership.superAdmins || []).map(s => s.inboxId));

    const promoted: string[] = [];
    const alreadyAdmin: string[] = [];
    const notFound: string[] = [];
    const failed: Array<{ address: string; error: string }> = [];

    for (const addr of targetAddrs) {
      const inbox = addrToInbox.get(addr);
      if (!inbox) {
        notFound.push(addr);
        continue;
      }
      if (adminInboxIds.has(inbox) || superAdminInboxIds.has(inbox)) {
        alreadyAdmin.push(addr);
        continue;
      }
      try {
        await (conversation as any).addAdmin(inbox);
        promoted.push(addr);
      } catch (e: any) {
        failed.push({ address: addr, error: String(e?.message || e) });
      }
    }

    const result: any = { groupId: (conversation as any).id, promoted, alreadyAdmin, notFound };
    if (failed.length > 0) result.failed = failed;
    return result;
  }

  async removeAdminsByAddresses(
    agentId: string,
    groupId: string,
    addresses: string[],
  ): Promise<{ groupId: string; demoted: string[]; notAdmin: string[]; notFound: string[]; failed?: Array<{ address: string; error: string }> }> {
    const client = this.clients.get(agentId);
    if (!client) {
      throw new Error('XMTP client not found for agent');
    }

    try { await (client.conversations as any).syncAll?.(['allowed']); } catch {}
    await (client.conversations as any).sync?.();
    const conversations = await client.conversations.list();
    const conversation = (conversations as any[]).find((conv: any) => conv.id === groupId);
    if (!conversation) {
      throw new Error(`Group conversation not found for id: ${groupId}`);
    }
    await (conversation as any).sync?.();

    // Only superAdmins can change admin roles (resolve caller inboxId)
    const callerInboxId = await this.getCallerInboxId(agentId, groupId);
    if (!callerInboxId) {
      throw new Error('Unable to resolve caller inbox; ensure the agent is a member of this group');
    }
    const isSuperAdmin = typeof (conversation as any).isSuperAdmin === 'function' && (conversation as any).isSuperAdmin(callerInboxId);
    if (!isSuperAdmin) {
      throw new Error('Admin role changes are restricted to superAdmins; caller lacks permission');
    }

    const targetAddrs = Array.from(new Set((addresses || []).map(a => a.toLowerCase())));
    if (targetAddrs.length === 0) {
      return { groupId: (conversation as any).id, demoted: [], notAdmin: [], notFound: [] };
    }

    const membership = await this.listGroupMembers(agentId, groupId);
    const addrToInbox = new Map<string, string>();
    for (const m of membership.members) {
      if (m.address) addrToInbox.set(m.address.toLowerCase(), m.inboxId);
    }

    const adminInboxIds = new Set<string>((membership.admins || []).map(a => a.inboxId));

    const demoted: string[] = [];
    const notAdmin: string[] = [];
    const notFound: string[] = [];
    const failed: Array<{ address: string; error: string }> = [];

    for (const addr of targetAddrs) {
      const inbox = addrToInbox.get(addr);
      if (!inbox) {
        notFound.push(addr);
        continue;
      }
      if (!adminInboxIds.has(inbox)) {
        notAdmin.push(addr);
        continue;
      }
      try {
        await (conversation as any).removeAdmin(inbox);
        demoted.push(addr);
      } catch (e: any) {
        failed.push({ address: addr, error: String(e?.message || e) });
      }
    }

    const result: any = { groupId: (conversation as any).id, demoted, notAdmin, notFound };
    if (failed.length > 0) result.failed = failed;
    return result;
  }

  async listGroupMembers(agentId: string, groupId: string): Promise<{ groupId: string; members: Array<{ address: string | null; inboxId: string; permissionLevel?: number }>; admins?: Array<{ address: string | null; inboxId: string }>; superAdmins?: Array<{ address: string | null; inboxId: string }> }> {
    const client = this.clients.get(agentId);
    if (!client) {
      throw new Error('XMTP client not found for agent');
    }

    try { await (client.conversations as any).syncAll?.(['allowed']); } catch {}
    await (client.conversations as any).sync?.();
    const conversations = await client.conversations.list();
    const conversation = (conversations as any[]).find((conv: any) => conv.id === groupId);
    if (!conversation) {
      throw new Error(`Group conversation not found for id: ${groupId}`);
    }
    await (conversation as any).sync?.();

    // members(): Promise<GroupMember[]>
    const members = await (conversation as any).members();
    const enriched: Array<{ address: string | null; inboxId: string; permissionLevel?: number }> = Array.isArray(members)
      ? members.map((m: any) => {
          const inboxId: string = m.inboxId || m.memberInboxId || m?.inbox_id || '';
          // Extract the first Ethereum address from accountIdentifiers if present
          let address: string | null = null;
          try {
            const ids: any[] = Array.isArray(m.accountIdentifiers) ? m.accountIdentifiers : [];
            const ethId = ids.find((id: any) => id?.identifierKind === IdentifierKind.Ethereum || id?.identifierKind === 0);
            address = ethId?.identifier ? String(ethId.identifier).toLowerCase() : null;
          } catch {}
          const permissionLevel: number | undefined = typeof m.permissionLevel === 'number' ? m.permissionLevel : undefined;
          return { address, inboxId, permissionLevel };
        })
        .filter((x: any) => !!x.inboxId)
      : [];

    // Try to surface admins/superAdmins, mapping inboxIds to addresses via members list
    let admins: Array<{ address: string | null; inboxId: string }> | undefined;
    let superAdmins: Array<{ address: string | null; inboxId: string }> | undefined;
    try {
      const adminIds: string[] | undefined = Array.isArray((conversation as any).admins) ? (conversation as any).admins : undefined;
      if (Array.isArray(adminIds)) {
        admins = adminIds.map((aid: string) => {
          const match = enriched.find(e => e.inboxId === aid);
          return { inboxId: aid, address: match?.address || null };
        });
      }
    } catch {}
    try {
      const superAdminIds: string[] | undefined = Array.isArray((conversation as any).superAdmins) ? (conversation as any).superAdmins : undefined;
      if (Array.isArray(superAdminIds)) {
        superAdmins = superAdminIds.map((sid: string) => {
          const match = enriched.find(e => e.inboxId === sid);
          return { inboxId: sid, address: match?.address || null };
        });
      }
    } catch {}

    return { groupId: (conversation as any).id, members: enriched, admins, superAdmins };
  }
}