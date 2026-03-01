# NanoClaw Capabilities Reference

A machine-readable reference for external agents, scripts, and humans that want to interact with a running NanoClaw instance. For codebase internals, see [../CLAUDE.md](../CLAUDE.md). For philosophy and setup, see [../README.md](../README.md).

## Overview

NanoClaw is a single Node.js process that receives messages from multiple channels, stores them in SQLite, and routes them to Claude agents running in isolated Linux containers. Each group/channel gets its own container, filesystem, and memory. Agents respond via the channel they were triggered from.

## Channels

Channels are the I/O interfaces through which NanoClaw sends and receives messages. Each channel uses a JID (Job ID) scheme to identify conversations.

| Channel | JID Scheme | Trigger Required | Notes |
|---------|-----------|-----------------|-------|
| WhatsApp | `{id}@g.us` (groups), `{id}@s.whatsapp.net` (DMs) | Yes (except main) | Default channel. Uses Baileys. |
| Discord | `dc:{channelId}` | No | Requires `DISCORD_BOT_TOKEN`. |
| Local | `local:default` | No | Always active. File-based inbox/outbox. |

### Trigger Pattern

Non-main groups require messages to start with `@{ASSISTANT_NAME}` (default: `@Andy`, case-insensitive). The main group and channels with `requiresTrigger: false` process all messages.

## Local Communication

Two mechanisms exist for local processes on the same machine to interact with NanoClaw.

### 1. IPC Message Injection (Fire-and-Forget)

Inject a synthetic message into an existing channel's message stream. The agent runs and responds via whichever channel owns the target group (WhatsApp, Discord, etc.).

**Path:** `data/ipc/{groupFolder}/tasks/`

**Format:**
```json
{
  "type": "inject_message",
  "prompt": "Your message to the agent",
  "sender": "script-name",
  "senderName": "My Script",
  "targetJid": "optional — defaults to main group JID"
}
```

**Behavior:**
- IPC watcher picks up the file within ~1 second
- Stores a synthetic message in SQLite
- Message loop picks it up within ~2 seconds
- Agent runs in the target group's container context
- Response goes to the target group's channel (WhatsApp/Discord)

**Example:**
```bash
echo '{"type":"inject_message","prompt":"Check server health"}' \
  > data/ipc/main/tasks/$(date +%s)-health.json
```

**Authorization:** Non-main groups can only inject messages to their own group. The main group can inject to any group.

### 2. Local Channel (Bidirectional)

A full channel with file-based inbox and outbox. Responses come back as local files, not to WhatsApp/Discord.

**Inbox:** `data/local/inbox/*.json`

```json
{
  "text": "Your message to the agent",
  "sender": "script-name",
  "senderName": "My Script",
  "requestId": "optional-correlation-id"
}
```

**Outbox:** `data/local/outbox/{timestamp}-{random}.txt`

Each response is written as a plain text file. Files are written atomically (`.tmp` then rename).

**Behavior:**
- Local channel polls inbox every 1 second
- Messages are processed, then the inbox file is deleted
- Agent runs in the `local` group's container context (`groups/local/`)
- Response is written to the outbox directory
- Malformed files are moved to `data/local/errors/`

**Example (send and poll for response):**
```bash
# Send
echo '{"text":"List all scheduled tasks","sender":"orchestrator"}' \
  > data/local/inbox/$(date +%s).json

# Poll for response
while [ -z "$(ls data/local/outbox/ 2>/dev/null)" ]; do sleep 1; done
cat data/local/outbox/*.txt
```

**Programmatic usage:**
1. Write to inbox with a `requestId` for correlation
2. Poll `data/local/outbox/` for new files
3. Clean up response files after reading

## IPC Task Reference

External processes communicate with NanoClaw by writing JSON files to `data/ipc/{groupFolder}/tasks/`. The IPC watcher polls every 1 second.

Files must have a `.json` extension. After processing, files are deleted. On error, files are moved to `data/ipc/errors/`.

### inject_message

Inject a synthetic message that triggers the agent. See [Local Communication](#1-ipc-message-injection-fire-and-forget) above.

### schedule_task

Create a scheduled task.

```json
{
  "type": "schedule_task",
  "prompt": "Task instructions for the agent",
  "schedule_type": "cron | interval | once",
  "schedule_value": "cron expression | milliseconds | ISO timestamp",
  "targetJid": "target group JID",
  "context_mode": "group | isolated"
}
```

### pause_task / resume_task / cancel_task

Manage an existing task.

```json
{
  "type": "pause_task",
  "taskId": "task-id"
}
```

### refresh_groups

Sync group metadata from connected channels. Main group only.

```json
{
  "type": "refresh_groups"
}
```

### register_group

Register a new group. Main group only.

```json
{
  "type": "register_group",
  "jid": "chat JID",
  "name": "Group Name",
  "folder": "group-folder-name",
  "trigger": "@Andy",
  "requiresTrigger": false
}
```

## IPC Message Reference

Agents inside containers send outbound messages by writing to `data/ipc/{groupFolder}/messages/`.

```json
{
  "type": "message",
  "chatJid": "target JID",
  "text": "Message text"
}
```

## Scheduled Tasks

Tasks are recurring or one-time agent runs. Created via IPC `schedule_task` or by asking the agent.

| Schedule Type | Value Format | Example |
|--------------|-------------|---------|
| `cron` | Cron expression | `0 9 * * 1-5` (weekdays 9am) |
| `interval` | Milliseconds | `3600000` (every hour) |
| `once` | ISO 8601 timestamp | `2026-03-15T14:00:00Z` |

Tasks run in the group context of the group that created them. The scheduler checks for due tasks every 60 seconds.

## Agent Model

### Container Isolation

Each agent invocation spawns a Linux container (Apple Container on macOS, or Docker). The container has:
- The group's folder mounted at `/workspace/group`
- IPC directories for communication
- Skills and session data
- Optionally: additional mounts via `containerConfig`

Agents have Bash access inside the container (safe — commands run in the container, not on the host).

### Group Folders

Each group gets an isolated folder under `groups/`:

```
groups/
├── main/           # Main channel (admin)
│   ├── CLAUDE.md   # Per-group memory
│   └── logs/       # Container execution logs
├── local/          # Local channel
│   ├── CLAUDE.md
│   └── logs/
└── global/
    └── CLAUDE.md   # Shared memory (read-only for non-main)
```

The agent reads both `groups/{name}/CLAUDE.md` and `groups/global/CLAUDE.md` on each run. Only the main group can write to global memory.

### Direct Mode

Set `RUNNER_MODE=direct` to run agents as Node.js subprocesses instead of containers (no Docker required, less isolation).

## Directory Layout

```
data/
├── ipc/
│   ├── main/
│   │   ├── messages/    # Agent → host outbound messages
│   │   ├── tasks/       # Inbound task commands (inject_message, schedule_task, etc.)
│   │   └── input/       # Host → agent follow-up messages (while container is active)
│   ├── local/
│   │   ├── messages/
│   │   ├── tasks/
│   │   └── input/
│   └── errors/          # Failed IPC files
├── local/
│   ├── inbox/           # Local channel inbound messages
│   ├── outbox/          # Local channel responses
│   └── errors/          # Malformed inbox files
groups/
├── main/
├── local/
└── global/
store/
└── messages.db          # SQLite database
```

## Timing

| Component | Poll Interval |
|-----------|--------------|
| Message loop | 2 seconds |
| IPC watcher | 1 second |
| Local channel inbox | 1 second |
| Task scheduler | 60 seconds |
| Idle timeout | 30 minutes (configurable via `IDLE_TIMEOUT`) |

## Configuration

Key environment variables (set in `.env` or environment):

| Variable | Default | Description |
|----------|---------|-------------|
| `ASSISTANT_NAME` | `Andy` | Trigger word and bot identity |
| `RUNNER_MODE` | `container` | `container` or `direct` |
| `CONTAINER_TIMEOUT` | `1800000` | Max container runtime (ms) |
| `IDLE_TIMEOUT` | `1800000` | Container idle timeout (ms) |
| `MAX_CONCURRENT_CONTAINERS` | `5` | Max parallel agent containers |
| `DISCORD_BOT_TOKEN` | — | Enables Discord channel |
| `DISCORD_ONLY` | `false` | Skip WhatsApp, Discord only |
