#!/usr/bin/env bash
# cleanup-discord-channels.sh
#
# Removes orphaned NanoClaw Discord channels whose Codespace no longer exists.
# Run from any machine with `gh` CLI and the Discord bot token available.
#
# Usage:
#   DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... ./scripts/cleanup-discord-channels.sh [--dry-run]
#
# Requires: curl, jq, gh (GitHub CLI, authenticated)

set -euo pipefail

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
  echo "[dry-run] No channels will be deleted."
fi

if [[ -z "${DISCORD_BOT_TOKEN:-}" ]]; then
  # Try loading from .env
  if [[ -f .env ]]; then
    DISCORD_BOT_TOKEN=$(grep '^DISCORD_BOT_TOKEN=' .env | cut -d= -f2-)
  fi
  if [[ -z "${DISCORD_BOT_TOKEN:-}" ]]; then
    echo "Error: DISCORD_BOT_TOKEN not set and not found in .env" >&2
    exit 1
  fi
fi

if [[ -z "${DISCORD_GUILD_ID:-}" ]]; then
  if [[ -f .env ]]; then
    DISCORD_GUILD_ID=$(grep '^DISCORD_GUILD_ID=' .env | cut -d= -f2-)
  fi
  if [[ -z "${DISCORD_GUILD_ID:-}" ]]; then
    echo "Error: DISCORD_GUILD_ID not set and not found in .env" >&2
    exit 1
  fi
fi

echo "Fetching Discord channels for guild ${DISCORD_GUILD_ID}..."
CHANNELS=$(curl -s -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
  "https://discord.com/api/v10/guilds/${DISCORD_GUILD_ID}/channels")

# Filter to nc-* text channels (type 0 = GUILD_TEXT)
NC_CHANNELS=$(echo "$CHANNELS" | jq -r '.[] | select(.type == 0 and (.name | startswith("nc-"))) | "\(.id) \(.name)"')

if [[ -z "$NC_CHANNELS" ]]; then
  echo "No nc-* channels found. Nothing to clean up."
  exit 0
fi

echo ""
echo "Found NanoClaw channels:"
echo "$NC_CHANNELS" | while read -r id name; do
  echo "  #${name} (${id})"
done
echo ""

# Get active codespace names
echo "Fetching active codespaces..."
ACTIVE_CODESPACES=$(gh codespace list --json name -q '.[].name' 2>/dev/null || echo "")

if [[ -z "$ACTIVE_CODESPACES" ]]; then
  echo "Warning: No active codespaces found (or gh CLI not authenticated)."
  echo "All nc-* channels will be considered orphaned."
  echo ""
fi

DELETED=0
KEPT=0

echo "$NC_CHANNELS" | while read -r channel_id channel_name; do
  # Extract codespace name from channel name
  # Handles: nc-<codespace-name> and nc-local-<hostname> (fallback naming)
  codespace_name="${channel_name#nc-}"

  # nc-local-* with non-codespace hostnames are truly local
  if [[ "$codespace_name" == local-* && "$codespace_name" != local-codespaces-* ]]; then
    echo "  SKIP  #${channel_name} (local machine)"
    KEPT=$((KEPT + 1))
    continue
  fi

  # Check if any active codespace matches (by name or hostname fragment)
  matched=false
  if [[ -n "$ACTIVE_CODESPACES" ]]; then
    while IFS= read -r cs_name; do
      # Direct name match: nc-<codespace-name>
      if [[ "$codespace_name" == "$cs_name" ]]; then
        matched=true
        break
      fi
      # Hostname fallback match: nc-local-codespaces-<id> where codespace name contains the id
      if [[ "$codespace_name" == local-codespaces-* ]]; then
        host_id="${codespace_name#local-codespaces-}"
        if [[ "$cs_name" == *"$host_id"* ]]; then
          matched=true
          break
        fi
      fi
    done <<< "$ACTIVE_CODESPACES"
  fi

  if [[ "$matched" == "true" ]]; then
    echo "  KEEP  #${channel_name} (codespace active)"
    KEPT=$((KEPT + 1))
  else
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "  WOULD DELETE  #${channel_name} (codespace gone)"
    else
      echo "  DELETE  #${channel_name} (codespace gone)"
      HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
        -X DELETE \
        -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
        "https://discord.com/api/v10/channels/${channel_id}")
      if [[ "$HTTP_CODE" == "200" || "$HTTP_CODE" == "204" ]]; then
        echo "          Deleted successfully"
      else
        echo "          Failed (HTTP ${HTTP_CODE})"
      fi
    fi
    DELETED=$((DELETED + 1))
  fi
done

echo ""
echo "Done. Deleted: ${DELETED}, Kept: ${KEPT}"
