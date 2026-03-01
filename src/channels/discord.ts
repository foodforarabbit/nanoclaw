import fs from 'fs';
import os from 'os';

import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Message,
  TextChannel,
} from 'discord.js';

import {
  ASSISTANT_NAME,
  DISCORD_GUILD_ID,
  TRIGGER_PATTERN,
} from '../config.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup?: (jid: string, group: RegisteredGroup) => void;
  unregisterGroup?: (jid: string) => void;
}

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;
  /** Channel ID auto-created by ensureChannel() — only this one gets deleted on shutdown */
  private autoCreatedChannelId: string | null = null;
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();

  constructor(botToken: string, opts: DiscordChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      // Ignore bot messages (including own)
      if (message.author.bot) return;

      const channelId = message.channelId;
      const chatJid = `dc:${channelId}`;
      let content = message.content;
      const timestamp = message.createdAt.toISOString();
      const senderName =
        message.member?.displayName ||
        message.author.displayName ||
        message.author.username;
      const sender = message.author.id;
      const msgId = message.id;

      // Determine chat name
      let chatName: string;
      if (message.guild) {
        const textChannel = message.channel as TextChannel;
        chatName = `${message.guild.name} #${textChannel.name}`;
      } else {
        chatName = senderName;
      }

      // Translate Discord @bot mentions into TRIGGER_PATTERN format.
      // Discord mentions look like <@botUserId> — these won't match
      // TRIGGER_PATTERN (e.g., ^@Andy\b), so we prepend the trigger
      // when the bot is @mentioned.
      if (this.client?.user) {
        const botId = this.client.user.id;
        const isBotMentioned =
          message.mentions.users.has(botId) ||
          content.includes(`<@${botId}>`) ||
          content.includes(`<@!${botId}>`);

        if (isBotMentioned) {
          // Strip the <@botId> mention to avoid visual clutter
          content = content
            .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
            .trim();
          // Prepend trigger if not already present
          if (!TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }
      }

      // Warn if content is empty — likely MESSAGE_CONTENT intent not enabled
      if (!content && message.attachments.size === 0) {
        logger.warn(
          { chatJid, chatName },
          'Received message with empty content — enable MESSAGE_CONTENT privileged intent in Discord Developer Portal',
        );
      }

      // Handle attachments — store placeholders so the agent knows something was sent
      if (message.attachments.size > 0) {
        const attachmentDescriptions = [...message.attachments.values()].map(
          (att) => {
            const contentType = att.contentType || '';
            if (contentType.startsWith('image/')) {
              return `[Image: ${att.name || 'image'}]`;
            } else if (contentType.startsWith('video/')) {
              return `[Video: ${att.name || 'video'}]`;
            } else if (contentType.startsWith('audio/')) {
              return `[Audio: ${att.name || 'audio'}]`;
            } else {
              return `[File: ${att.name || 'file'}]`;
            }
          },
        );
        if (content) {
          content = `${content}\n${attachmentDescriptions.join('\n')}`;
        } else {
          content = attachmentDescriptions.join('\n');
        }
      }

      // Handle reply context — include who the user is replying to
      if (message.reference?.messageId) {
        try {
          const repliedTo = await message.channel.messages.fetch(
            message.reference.messageId,
          );
          const replyAuthor =
            repliedTo.member?.displayName ||
            repliedTo.author.displayName ||
            repliedTo.author.username;
          content = `[Reply to ${replyAuthor}] ${content}`;
        } catch {
          // Referenced message may have been deleted
        }
      }

      // Store chat metadata for discovery
      this.opts.onChatMetadata(chatJid, timestamp, chatName);

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Discord channel',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Discord message stored',
      );
    });

    // Handle errors gracefully
    this.client.on(Events.Error, (err) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    return new Promise<void>((resolve) => {
      this.client!.once(Events.ClientReady, async (readyClient) => {
        logger.info(
          { username: readyClient.user.tag, id: readyClient.user.id },
          'Discord bot connected',
        );
        console.log(`\n  Discord bot: ${readyClient.user.tag}`);
        console.log(
          `  Use /chatid command or check channel IDs in Discord settings\n`,
        );

        await this.ensureChannel();
        resolve();
      });

      this.client!.login(this.botToken);
    });
  }

  /**
   * Auto-create and register a Discord channel if none exists.
   * Only runs when DISCORD_GUILD_ID is set and no dc:* channel is registered.
   * Also ensures existing auto-channels have requiresTrigger=false.
   */
  private async ensureChannel(): Promise<void> {
    if (!DISCORD_GUILD_ID || !this.client || !this.opts.registerGroup) return;

    const groups = this.opts.registeredGroups();
    const existingDcJid = Object.keys(groups).find((jid) =>
      jid.startsWith('dc:'),
    );

    if (existingDcJid) {
      const existing = groups[existingDcJid];
      const channelId = existingDcJid.replace(/^dc:/, '');

      // Verify the Discord channel still exists
      let channelStillExists = false;
      try {
        const ch = await this.client.channels.fetch(channelId);
        channelStillExists = ch !== null;
      } catch {
        channelStillExists = false;
      }

      if (channelStillExists) {
        if (existing.name.startsWith('nc-')) {
          this.autoCreatedChannelId = channelId;

          // Reactivate a previously closed channel by stripping the [closed] suffix
          try {
            const ch = await this.client.channels.fetch(channelId);
            if (ch && 'name' in ch) {
              const textCh = ch as TextChannel;
              if (textCh.name.endsWith('-closed')) {
                const activeName = textCh.name.replace(/-closed$/, '');
                await textCh.setName(activeName);
                logger.info(
                  { channelId, oldName: textCh.name, newName: activeName },
                  'Reactivated closed Discord channel',
                );
              }
            }
          } catch (err) {
            logger.warn(
              { channelId, err },
              'Failed to reactivate closed Discord channel',
            );
          }
        }
        if (existing.requiresTrigger !== false) {
          logger.info(
            { jid: existingDcJid },
            'Updating existing Discord channel to requiresTrigger=false',
          );
          this.opts.registerGroup(existingDcJid, {
            ...existing,
            requiresTrigger: false,
          });
        }
        return;
      }

      // Channel was deleted externally — clean up the stale registration
      logger.warn(
        { jid: existingDcJid, channelId },
        'Registered Discord channel no longer exists, removing stale entry',
      );
      this.opts.unregisterGroup?.(existingDcJid);
    }

    try {
      const guild = await this.client.guilds.fetch(DISCORD_GUILD_ID);

      // Build channel name from Codespace env vars or hostname.
      // CODESPACE_NAME is set by the Codespace runtime in VS Code terminals
      // but not in SSH sessions. Fall back to the shared config file.
      let codespaceName = process.env.CODESPACE_NAME;
      if (!codespaceName && process.env.CODESPACES === 'true') {
        try {
          const envFile =
            '/workspaces/.codespaces/shared/environment-variables.json';
          const envData = JSON.parse(fs.readFileSync(envFile, 'utf-8'));
          codespaceName = envData.CODESPACE_NAME;
        } catch {
          // Fall through to hostname
        }
      }
      const channelName = codespaceName
        ? `nc-${codespaceName}`.slice(0, 100).toLowerCase()
        : `nc-local-${os.hostname()}`.slice(0, 100).toLowerCase();

      const channel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
      });

      const jid = `dc:${channel.id}`;
      this.autoCreatedChannelId = channel.id;
      const folderName = channelName
        .replace(/[^a-zA-Z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .slice(0, 64);

      this.opts.registerGroup(jid, {
        name: channelName,
        folder: folderName,
        trigger: `@${ASSISTANT_NAME}`,
        requiresTrigger: false,
        added_at: new Date().toISOString(),
      });

      this.opts.onChatMetadata(
        jid,
        new Date().toISOString(),
        `${guild.name} #${channelName}`,
        'discord',
        true,
      );

      // Post welcome message
      const repo = process.env.GITHUB_REPOSITORY || '';
      const branch = process.env.GITHUB_REF_NAME || '';
      const user = process.env.GITHUB_USER || process.env.USER || '';

      let welcome: string;
      if (codespaceName) {
        const lines = [
          `**NanoClaw is online**\n`,
          `Codespace: \`${codespaceName}\``,
        ];
        if (repo)
          lines.push(
            `Repository: \`${repo}\`${branch ? ` (branch: \`${branch}\`)` : ''}`,
          );
        if (user) lines.push(`User: \`${user}\``);
        lines.push('');
        lines.push(`Open in browser: https://${codespaceName}.github.dev`);
        lines.push(
          `Open in VS Code: https://github.com/codespaces/${codespaceName}`,
        );
        lines.push('');
        lines.push(`Send any message here to interact with the agent.`);
        welcome = lines.join('\n');
      } else {
        welcome = [
          `**NanoClaw is online**\n`,
          `Host: \`${os.hostname()}\``,
          user ? `User: \`${user}\`` : '',
          `Working directory: \`${process.cwd()}\``,
          '',
          `Send any message here to interact with the agent.`,
        ]
          .filter(Boolean)
          .join('\n');
      }

      await channel.send(welcome);
      logger.info(
        { channelName, channelId: channel.id, guildId: DISCORD_GUILD_ID },
        'Auto-created Discord channel',
      );
      console.log(`  Auto-created Discord channel: #${channelName}`);
    } catch (err) {
      logger.error(
        { err, guildId: DISCORD_GUILD_ID },
        'Failed to auto-create Discord channel',
      );
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }

      const textChannel = channel as TextChannel;

      // Discord has a 2000 character limit per message — split if needed
      const MAX_LENGTH = 2000;
      if (text.length <= MAX_LENGTH) {
        await textChannel.send(text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await textChannel.send(text.slice(i, i + MAX_LENGTH));
        }
      }
      logger.info({ jid, length: text.length }, 'Discord message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dc:');
  }

  async disconnect(): Promise<void> {
    if (!this.client) return;

    // Mark auto-created channel as closed instead of deleting it
    if (this.autoCreatedChannelId) {
      try {
        const channel = await this.client.channels.fetch(
          this.autoCreatedChannelId,
        );
        if (channel && 'setName' in channel) {
          const textChannel = channel as TextChannel;
          if ('send' in channel) {
            await textChannel.send('**NanoClaw shutting down**');
          }
          if (!textChannel.name.endsWith('-closed')) {
            await textChannel.setName(`${textChannel.name}-closed`);
          }
          logger.info(
            { channelId: this.autoCreatedChannelId },
            'Marked Discord channel as closed',
          );
        }
      } catch (err) {
        logger.warn(
          { channelId: this.autoCreatedChannelId, err },
          'Failed to mark Discord channel as closed on shutdown',
        );
      }
    }

    this.client.destroy();
    this.client = null;
    logger.info('Discord bot stopped');
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client) return;

    const existing = this.typingIntervals.get(jid);
    if (existing) {
      clearInterval(existing);
      this.typingIntervals.delete(jid);
    }

    if (!isTyping) return;

    const sendOnce = async () => {
      try {
        const channelId = jid.replace(/^dc:/, '');
        const channel = await this.client!.channels.fetch(channelId);
        if (channel && 'sendTyping' in channel) {
          await (channel as TextChannel).sendTyping();
        }
      } catch (err) {
        logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
      }
    };

    await sendOnce();
    // Discord typing indicator expires after ~10s; refresh every 8s
    this.typingIntervals.set(jid, setInterval(sendOnce, 8_000));
  }
}
