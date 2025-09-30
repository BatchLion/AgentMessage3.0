import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs';
import * as path from 'path';

// Log to stderr only; never use stdout in stdio MCP servers
const log = (...args) => console.error("[mcp-xmtp]", ...args);

const SERVER_URL = process.env.SERVER_URL || "http://localhost:58548";

// Check for required environment variable
const MEMORY_PATH = process.env.AGENTMESSAGE_MEMORY_PATH;
if (!MEMORY_PATH) {
  console.error('AGENTMESSAGE_MEMORY_PATH environment variable is required but not set');
  process.exit(1);
}

// Helper function to get agent_id from ethereum_address.json
function getAgentId() {
  try {
    const addressFilePath = path.join(MEMORY_PATH, 'ethereum_address.json');
    if (fs.existsSync(addressFilePath)) {
      const addressData = JSON.parse(fs.readFileSync(addressFilePath, 'utf8'));
      return addressData.address;
    }
    return null;
  } catch (error) {
    console.error('Error reading agent_id from ethereum_address.json:', error);
    return null;
  }
}

async function httpPost(path, body) {
  const res = await fetch(`${SERVER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}: ${text}`);
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

async function httpGet(path, params) {
  const url = new URL(`${SERVER_URL}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (typeof v !== "undefined" && v !== null && String(v).length > 0) {
        url.searchParams.set(k, String(v));
      }
    }
  }
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}: ${text}`);
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

const server = new Server(
  { name: "mcp-xmtp", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

// Register tools list handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "health",
        description: "Check MCP XMTP server health and basic stats",
        inputSchema: {
          type: "object",
          properties: {},
          required: []
        }
      },
      {
        name: "register_recall_id",
        description: "Register a new agent with a unique recall ID. This creates a new XMTP identity for messaging. The 'name' parameter is required and will be used to generate a unique agent ID.",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Required. The name for the agent"
            },
            description: {
              type: "string", 
              description: "Optional. A description of what this agent does or its purpose"
            },
            capabilities: {
              type: "array",
              items: { type: "string" },
              description: "Optional. Array of strings describing the agent's capabilities"
            }
          },
          required: ["name"]
        }
      },
      {
        name: "xmtp_send",
        description: "Send a direct XMTP message to another agent or address. Requires an online agent to send from.",
        inputSchema: {
          type: "object",
          properties: {
            recipient_address: {
              type: "string", 
              description: "Required. The XMTP address or wallet address of the recipient"
            },
            message: {
              type: "string",
              description: "Required. The message content to send"
            },
            content_type: {
              type: "string",
              description: "Optional. Message content type (text, reply, attachment, etc.)"
            },
            reply_to: {
              type: "string",
              description: "Optional. Message ID to reply to if this is a reply"
            }
          },
          required: ["recipient_address", "message"]
        }
      },
      {
        name: "xmtp_messages",
        description: "Get XMTP messages for an agent or specific conversation. Useful for checking new messages or conversation history.",
        inputSchema: {
          type: "object",
          properties: {
            conversation_id: {
              type: "string",
              description: "Optional. Specific conversation ID to get messages from"
            },
            limit: {
              type: "number",
              description: "Optional. Maximum number of messages to return (default: 50)"
            },
            cursor: {
              type: "string",
              description: "Optional. Pagination cursor for getting more messages"
            },
            start_time: {
              type: "string",
              description: "Optional. ISO timestamp to get messages after this time"
            },
            end_time: {
              type: "string",
              description: "Optional. ISO timestamp to get messages before this time"
            }
          },
          required: []
        }
      },
      {
        name: "xmtp_conversations",
        description: "List XMTP conversations for an agent",
        inputSchema: {
          type: "object",
          properties: {
            limit: {
              type: "number",
              description: "Optional. Maximum number of conversations to return"
            },
            created_after: {
              type: "string",
              description: "Optional. ISO timestamp to get conversations created after this time"
            },
            created_before: {
              type: "string",
              description: "Optional. ISO timestamp to get conversations created before this time"
            }
          },
          required: []
        }
      },
      {
        name: "xmtp_groups_create",
        description: "Create a new XMTP group",
        inputSchema: {
          type: "object",
          properties: {
            participant_addresses: {
              type: "array",
              items: { type: "string" },
              description: "Required. Array of participant addresses to add to the group"
            },
            group_name: {
              type: "string",
              description: "Optional. Name for the group"
            }
          },
          required: ["participant_addresses"]
        }
      },
      {
        name: "agent_status",
        description: "Check if an agent is online",
        inputSchema: {
          type: "object",
          properties: {},
          required: []
        }
      },
      {
        name: "xmtp_send_reply",
        description: "Send a reply to an existing XMTP message",
        inputSchema: {
          type: "object",
          properties: {
            recipient_address: {
              type: "string",
              description: "Required. The address to send the reply to"
            },
            message: {
              type: "string",
              description: "Required. The reply message content"
            },
            reply_to: {
              type: "string",
              description: "Required. The message ID being replied to"
            }
          },
          required: ["recipient_address", "message", "reply_to"]
        }
      },
      {
        name: "xmtp_send_attachment",
        description: "Send a small inline attachment via XMTP",
        inputSchema: {
          type: "object",
          properties: {
            recipient_address: {
              type: "string",
              description: "Required. The address to send the attachment to"
            },
            filename: {
              type: "string",
              description: "Required. The filename of the attachment"
            },
            mimeType: {
              type: "string",
              description: "Required. The MIME type of the attachment"
            },
            data: {
              type: "string",
              description: "Required. The attachment data (base64 encoded)"
            }
          },
          required: ["recipient_address", "filename", "mimeType", "data"]
        }
      },
      {
        name: "xmtp_send_group",
        description: "Send a message to an XMTP group",
        inputSchema: {
          type: "object",
          properties: {
            group_id: {
              type: "string",
              description: "Required. The ID of the group to send the message to"
            },
            message: {
              type: "string",
              description: "Required. The message content to send"
            },
            content_type: {
              type: "string",
              description: "Optional. Message content type"
            },
            reply_to: {
              type: "string",
              description: "Optional. Message ID to reply to"
            },
            reference_inbox_id: {
              type: "string",
              description: "Optional. Reference inbox ID"
            }
          },
          required: ["group_id", "message"]
        }
      },
      {
        name: "xmtp_groups_add_members",
        description: "Add members to an XMTP group",
        inputSchema: {
          type: "object",
          properties: {
            group_id: {
              type: "string",
              description: "Required. The ID of the group to add members to"
            },
            participant_addresses: {
              type: "array",
              items: { type: "string" },
              description: "Required. Array of addresses to add as members"
            }
          },
          required: ["group_id", "participant_addresses"]
        }
      },
      {
        name: "xmtp_groups_add_admins",
        description: "Promote addresses to admins in an XMTP group",
        inputSchema: {
          type: "object",
          properties: {
            group_id: {
              type: "string",
              description: "Required. The ID of the group"
            },
            addresses: {
              type: "array",
              items: { type: "string" },
              description: "Required. Array of addresses to promote to admin"
            }
          },
          required: ["group_id", "addresses"]
        }
      },
      {
        name: "xmtp_groups_remove_admins",
        description: "Demote addresses from admins in an XMTP group",
        inputSchema: {
          type: "object",
          properties: {
            group_id: {
              type: "string",
              description: "Required. The ID of the group"
            },
            addresses: {
              type: "array",
              items: { type: "string" },
              description: "Required. Array of addresses to demote from admin"
            }
          },
          required: ["group_id", "addresses"]
        }
      },
      {
        name: "xmtp_groups_members",
        description: "List members and admins of an XMTP group",
        inputSchema: {
          type: "object",
          properties: {
            group_id: {
              type: "string",
              description: "Required. The ID of the group to list members for"
            }
          },
          required: ["group_id"]
        }
      },
      {
         name: "go_online",
         description: "Bring an agent online by unlocking with password from environment. Required before the agent can send/receive messages.",
         inputSchema: {
           type: "object",
           properties: {},
           required: []
         }
       },
      {
        name: "collect_identities",
        description: "Collect known registered agent identities from the blockchain contract",
        inputSchema: {
          type: "object",
          properties: {},
          required: []
        }
      }
    ]
  };
});

// Register tool call handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    // Get agent_id for tools that need it
    const agent_id = getAgentId();
    
    switch (name) {
      case "health":
        return { content: [{ type: "text", text: JSON.stringify(await httpGet("/health"), null, 2) }] };
      
      case "register_recall_id":
        // Check if ethereum_address.json exists in MEMORY_PATH
        const addressFilePath = path.join(MEMORY_PATH, 'ethereum_address.json');
        try {
          if (fs.existsSync(addressFilePath)) {
            // File exists, read agent_id and call recall_id
            const addressData = JSON.parse(fs.readFileSync(addressFilePath, 'utf8'));
            const recallArgs = {
              agent_id: addressData.address,
              password: process.env.AGENTMESSAGE_ENCRYPTION_PASSWORD || "default_password"
            };
            return { content: [{ type: "text", text: JSON.stringify(await httpPost("/recall_id", recallArgs), null, 2) }] };
          } else {
            // File doesn't exist, call register_id
            const response = await httpPost("/register_id", args);
            
            // Extract agent_id from response and save to ethereum_address.json
            try {
              if (response && response.agent_id) {
                const addressData = { address: response.agent_id };
                // Ensure directory exists before writing file
                const dirPath = path.dirname(addressFilePath);
                if (!fs.existsSync(dirPath)) {
                  fs.mkdirSync(dirPath, { recursive: true });
                }
                fs.writeFileSync(addressFilePath, JSON.stringify(addressData, null, 2));
              }
            } catch (saveError) {
              console.error('Error saving ethereum_address.json:', saveError);
            }
            
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
          }
        } catch (error) {
          return { content: [{ type: "text", text: JSON.stringify({ error: `Error checking ethereum_address.json: ${error.message}` }, null, 2) }] };
        }
      
      case "xmtp_send":
        if (!agent_id) return { content: [{ type: "text", text: JSON.stringify({ error: "No agent registered. Please run register_recall_id first." }, null, 2) }] };
        return { content: [{ type: "text", text: JSON.stringify(await httpPost("/xmtp/send", { ...args, agent_id }), null, 2) }] };
      
      case "xmtp_messages":
        if (!agent_id) return { content: [{ type: "text", text: JSON.stringify({ error: "No agent registered. Please run register_recall_id first." }, null, 2) }] };
        return { content: [{ type: "text", text: JSON.stringify(await httpGet("/xmtp/messages", { ...args, agent_id }), null, 2) }] };
      
      case "xmtp_conversations":
        if (!agent_id) return { content: [{ type: "text", text: JSON.stringify({ error: "No agent registered. Please run register_recall_id first." }, null, 2) }] };
        return { content: [{ type: "text", text: JSON.stringify(await httpGet("/xmtp/conversations", { ...args, agent_id }), null, 2) }] };
      
      case "xmtp_groups_create":
        if (!agent_id) return { content: [{ type: "text", text: JSON.stringify({ error: "No agent registered. Please run register_recall_id first." }, null, 2) }] };
        return { content: [{ type: "text", text: JSON.stringify(await httpPost("/xmtp/groups/create", { ...args, agent_id }), null, 2) }] };
      
      case "agent_status":
        if (!agent_id) return { content: [{ type: "text", text: JSON.stringify({ error: "No agent registered. Please run register_recall_id first." }, null, 2) }] };
        return { content: [{ type: "text", text: JSON.stringify(await httpGet(`/agent/status/${agent_id}`), null, 2) }] };
      
      case "xmtp_send_reply":
        if (!agent_id) return { content: [{ type: "text", text: JSON.stringify({ error: "No agent registered. Please run register_recall_id first." }, null, 2) }] };
        return { content: [{ type: "text", text: JSON.stringify(await httpPost("/xmtp/send_reply", { ...args, agent_id }), null, 2) }] };
      
      case "xmtp_send_attachment":
        if (!agent_id) return { content: [{ type: "text", text: JSON.stringify({ error: "No agent registered. Please run register_recall_id first." }, null, 2) }] };
        return { content: [{ type: "text", text: JSON.stringify(await httpPost("/xmtp/send_attachment", { ...args, agent_id }), null, 2) }] };
      
      case "xmtp_send_group":
        if (!agent_id) return { content: [{ type: "text", text: JSON.stringify({ error: "No agent registered. Please run register_recall_id first." }, null, 2) }] };
        return { content: [{ type: "text", text: JSON.stringify(await httpPost("/xmtp/send_group", { ...args, agent_id }), null, 2) }] };
      
      case "xmtp_groups_add_members":
        if (!agent_id) return { content: [{ type: "text", text: JSON.stringify({ error: "No agent registered. Please run register_recall_id first." }, null, 2) }] };
        return { content: [{ type: "text", text: JSON.stringify(await httpPost("/xmtp/groups/add_members", { ...args, admin_agent_id: agent_id }), null, 2) }] };
      
      case "xmtp_groups_add_admins":
        if (!agent_id) return { content: [{ type: "text", text: JSON.stringify({ error: "No agent registered. Please run register_recall_id first." }, null, 2) }] };
        return { content: [{ type: "text", text: JSON.stringify(await httpPost("/xmtp/groups/add_admins", { ...args, agent_id }), null, 2) }] };
      
      case "xmtp_groups_remove_admins":
        if (!agent_id) return { content: [{ type: "text", text: JSON.stringify({ error: "No agent registered. Please run register_recall_id first." }, null, 2) }] };
        return { content: [{ type: "text", text: JSON.stringify(await httpPost("/xmtp/groups/remove_admins", { ...args, agent_id }), null, 2) }] };
      
      case "xmtp_groups_members":
        if (!agent_id) return { content: [{ type: "text", text: JSON.stringify({ error: "No agent registered. Please run register_recall_id first." }, null, 2) }] };
        return { content: [{ type: "text", text: JSON.stringify(await httpGet("/xmtp/groups/members", { ...args, agent_id }), null, 2) }] };
      
      case "go_online":
        if (!agent_id) return { content: [{ type: "text", text: JSON.stringify({ error: "No agent registered. Please run register_recall_id first." }, null, 2) }] };
        // Get password from environment variable
        const password = process.env.AGENTMESSAGE_ENCRYPTION_PASSWORD || "default_password";
        const goOnlineArgs = { ...args, agent_id, password };
        return { content: [{ type: "text", text: JSON.stringify(await httpPost("/go_online", goOnlineArgs), null, 2) }] };
      
      case "collect_identities":
        return { content: [{ type: "text", text: JSON.stringify(await httpGet("/collect_identities"), null, 2) }] };
      
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return { 
      content: [{ 
        type: "text", 
        text: `Error calling ${name}: ${error.message}` 
      }],
      isError: true
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP XMTP server connected via stdio");
}

main().catch((e) => {
  log("Fatal error:", e);
  process.exit(1);
});