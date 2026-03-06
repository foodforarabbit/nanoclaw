import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, LOCAL_DIR } from '../config.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

const LOCAL_POLL_INTERVAL = 1000;
const LOCAL_JID = 'local:default';
const LOCAL_GROUP_FOLDER = 'local';

export interface LocalChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
}

export class LocalChannel implements Channel {
  name = 'local';

  private opts: LocalChannelOpts;
  private inboxDir: string;
  private outboxDir: string;
  private connected = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: LocalChannelOpts) {
    this.opts = opts;
    this.inboxDir = path.join(LOCAL_DIR, 'inbox');
    this.outboxDir = path.join(LOCAL_DIR, 'outbox');
  }

  async connect(): Promise<void> {
    fs.mkdirSync(this.inboxDir, { recursive: true });
    fs.mkdirSync(this.outboxDir, { recursive: true });

    // Auto-register the local group if not already registered
    const groups = this.opts.registeredGroups();
    if (!groups[LOCAL_JID]) {
      this.opts.registerGroup(LOCAL_JID, {
        name: 'Local Channel',
        folder: LOCAL_GROUP_FOLDER,
        trigger: `@${ASSISTANT_NAME}`,
        requiresTrigger: false,
        added_at: new Date().toISOString(),
      });
    }

    this.opts.onChatMetadata(
      LOCAL_JID,
      new Date().toISOString(),
      'Local Channel',
      'local',
      true,
    );

    this.connected = true;
    this.pollInbox();
    logger.info(
      { inbox: this.inboxDir, outbox: this.outboxDir },
      'Local channel connected',
    );
  }

  private pollInbox(): void {
    if (!this.connected) return;

    try {
      const files = fs
        .readdirSync(this.inboxDir)
        .filter((f) => f.endsWith('.json'))
        .sort();

      for (const file of files) {
        const filePath = path.join(this.inboxDir, file);
        try {
          const raw = fs.readFileSync(filePath, 'utf-8');
          const data = JSON.parse(raw);

          if (!data.text) {
            logger.warn({ file }, 'Local inbox message missing "text" field');
            fs.unlinkSync(filePath);
            continue;
          }

          const msgId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const sender = data.sender || 'local';
          const senderName = data.senderName || data.sender || 'Local Process';
          const timestamp = new Date().toISOString();

          this.opts.onMessage(LOCAL_JID, {
            id: msgId,
            chat_jid: LOCAL_JID,
            sender,
            sender_name: senderName,
            content: data.text,
            timestamp,
          });

          logger.info(
            { file, sender, requestId: data.requestId },
            'Local inbox message received',
          );

          fs.unlinkSync(filePath);
        } catch (err) {
          logger.error({ file, err }, 'Error processing local inbox message');
          // Move to errors directory
          const errorDir = path.join(LOCAL_DIR, 'errors');
          fs.mkdirSync(errorDir, { recursive: true });
          try {
            fs.renameSync(filePath, path.join(errorDir, file));
          } catch {
            // Best-effort cleanup
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error reading local inbox directory');
    }

    this.pollTimer = setTimeout(() => this.pollInbox(), LOCAL_POLL_INTERVAL);
  }

  async sendMessage(
    _jid: string,
    text: string,
    _attachments?: import('../types.js').Attachment[],
  ): Promise<void> {
    const timestamp = Date.now();
    const filename = `${timestamp}-${Math.random().toString(36).slice(2, 8)}.txt`;
    const filepath = path.join(this.outboxDir, filename);
    const tempPath = `${filepath}.tmp`;

    try {
      fs.writeFileSync(tempPath, text);
      fs.renameSync(tempPath, filepath);
      logger.info(
        { filename, length: text.length },
        'Local outbox response written',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to write local outbox response');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('local:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    logger.info('Local channel disconnected');
  }
}
