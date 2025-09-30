#!/usr/bin/env ts-node

/**
 * Simple CLI to call MCP XMTP server endpoints.
 * Requires Node >= 18 (global fetch) and ts-node for execution.
 *
 * Usage examples:
 *   ts-node src/cli.ts send --agent <agentId> --to <recipient> --text "Hello"
 *   ts-node src/cli.ts send-reply --agent <agentId> --to <recipient> --text "Re: Hi" --replyTo <messageId>
 *   ts-node src/cli.ts send-attachment --agent <agentId> --to <recipient> --file ./image.jpg --mime image/jpeg --name image.jpg
 *   ts-node src/cli.ts messages --agent <agentId> [--conversation <id>] [--limit 50] [--cursor CURSOR] [--start 2024-01-01T00:00:00Z] [--end 2024-12-31T23:59:59Z]
 *   ts-node src/cli.ts conversations --agent <agentId> [--limit 20] [--createdAfter 2024-01-01T00:00:00Z] [--createdBefore 2024-12-31T23:59:59Z]
 *   ts-node src/cli.ts create-group --agent <agentId> --participants 0xabc...,0xdef... [--name "My Group"]
 */

import * as fs from 'fs';

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:58548';

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    }
  }
  return args;
}

async function httpPost(path: string, body: any) {
  const res = await fetch(`${SERVER_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${text}`);
  }
  return res.json();
}

async function httpGet(path: string, params?: Record<string, string | number | undefined>) {
  const url = new URL(`${SERVER_URL}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (typeof v !== 'undefined' && v !== null && String(v).length > 0) {
        url.searchParams.set(k, String(v));
      }
    }
  }
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${text}`);
  }
  return res.json();
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  try {
    switch (cmd) {
      case 'send': {
        const agent = String(args['agent'] || '');
        const to = String(args['to'] || '');
        const text = String(args['text'] || '');
        if (!agent || !to || !text) throw new Error('Usage: send --agent <agentId> --to <recipient> --text "Hello"');
        const result = await httpPost('/xmtp/send', {
          agent_id: agent,
          recipient_address: to,
          message: text,
          content_type: 'text',
        });
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      case 'send-reply': {
        const agent = String(args['agent'] || '');
        const to = String(args['to'] || '');
        const text = String(args['text'] || '');
        const replyTo = String(args['replyTo'] || '');
        if (!agent || !to || !text || !replyTo) throw new Error('Usage: send-reply --agent <agentId> --to <recipient> --text "Re: Hi" --replyTo <messageId>');
        const result = await httpPost('/xmtp/send', {
          agent_id: agent,
          recipient_address: to,
          message: text,
          content_type: 'reply',
          reply_to: replyTo,
        });
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      case 'send-attachment': {
        const agent = String(args['agent'] || '');
        const to = String(args['to'] || '');
        const file = String(args['file'] || '');
        const mime = String(args['mime'] || 'application/octet-stream');
        const name = String(args['name'] || 'file');
        if (!agent || !to || !file || !fs.existsSync(file)) throw new Error('Usage: send-attachment --agent <agentId> --to <recipient> --file <path> [--mime <mime>] [--name <filename>]');
        const dataBuf = fs.readFileSync(file);
        // Small attachments inline via ContentTypeAttachment
        const message = {
          filename: name,
          mimeType: mime,
          data: Array.from(dataBuf),
        };
        const result = await httpPost('/xmtp/send', {
          agent_id: agent,
          recipient_address: to,
          message,
          content_type: 'attachment',
        });
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      case 'messages': {
        const agent = String(args['agent'] || '');
        const conversation = (args['conversation'] as string) || '';
        const limit = args['limit'] ? Number(args['limit']) : 50;
        const cursor = (args['cursor'] as string) || undefined;
        const start = (args['start'] as string) || undefined;
        const end = (args['end'] as string) || undefined;
        if (!agent) throw new Error('Usage: messages --agent <agentId> [--conversation <id>] [--limit 50] [--cursor CURSOR] [--start ISO] [--end ISO]');
        const result = await httpGet('/xmtp/messages', {
          agent_id: agent,
          conversation_id: conversation || undefined,
          limit,
          cursor,
          start_time: start,
          end_time: end,
        });
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      case 'conversations': {
        const agent = String(args['agent'] || '');
        const limit = args['limit'] ? Number(args['limit']) : undefined;
        const createdAfter = (args['createdAfter'] as string) || undefined;
        const createdBefore = (args['createdBefore'] as string) || undefined;
        if (!agent) throw new Error('Usage: conversations --agent <agentId> [--limit 20] [--createdAfter ISO] [--createdBefore ISO]');
        const result = await httpGet('/xmtp/conversations', {
          agent_id: agent,
          limit: typeof limit === 'number' ? String(limit) : undefined,
          created_after: createdAfter,
          created_before: createdBefore,
        });
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      case 'create-group': {
        const agent = String(args['agent'] || '');
        const participants = String(args['participants'] || '');
        const name = (args['name'] as string) || undefined;
        if (!agent || !participants) throw new Error('Usage: create-group --agent <agentId> --participants 0xabc...,0xdef... [--name "My Group"]');
        const participant_addresses = participants.split(',').map(s => s.trim()).filter(Boolean);
        const result = await httpPost('/xmtp/groups/create', {
          agent_id: agent,
          participant_addresses,
          group_name: name,
        });
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      default:
        console.log('Commands: send, send-reply, send-attachment, messages, conversations, create-group');
        process.exit(1);
    }
  } catch (err: any) {
    console.error(err.message || err);
    process.exit(1);
  }
}

main();