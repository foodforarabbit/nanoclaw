/**
 * Direct Runner for NanoClaw
 * Spawns agent-runner as a Node.js subprocess instead of a Docker container.
 * Used in Codespaces and environments where Docker is not available.
 * Same stdin/stdout JSON protocol and IPC as container-runner.
 */
import { ChildProcess, execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  TIMEZONE,
} from './config.js';
import { readEnvFile } from './env.js';
import {
  resolveGroupFolderPath,
  resolveGroupIpcPath,
} from './group-folder.js';
import { logger } from './logger.js';
import { ContainerInput, ContainerOutput } from './container-runner.js';
import { RegisteredGroup } from './types.js';

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function readSecrets(): Record<string, string> {
  return readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);
}

function ensureAgentRunnerBuilt(): void {
  const projectRoot = process.cwd();
  const distIndex = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'dist',
    'index.js',
  );
  if (fs.existsSync(distIndex)) return;

  logger.info('Agent-runner dist not found, compiling...');
  const agentRunnerDir = path.join(projectRoot, 'container', 'agent-runner');
  execSync('npm install && npm run build', {
    cwd: agentRunnerDir,
    stdio: 'pipe',
  });
  logger.info('Agent-runner compiled');
}

export async function runDirectAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();
  const projectRoot = process.cwd();

  ensureAgentRunnerBuilt();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });

  // Set up sessions directory (same as container-runner)
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // Sync skills
  const skillsSrc = path.join(projectRoot, 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }

  const globalDir = path.join(GROUPS_DIR, 'global');

  // Collect extra directories from additionalMounts config
  const extraDirs: string[] = [];
  if (group.containerConfig?.additionalMounts) {
    for (const mount of group.containerConfig.additionalMounts) {
      const resolved = mount.hostPath.replace(/^~/, process.env.HOME || '~');
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        extraDirs.push(resolved);
      }
    }
  }
  // Also include NANOCLAW_EXTRA_DIRS env var (colon-separated paths)
  const envExtraDirs = process.env.NANOCLAW_EXTRA_DIRS;
  if (envExtraDirs) {
    for (const dir of envExtraDirs.split(':')) {
      if (dir && fs.existsSync(dir)) {
        extraDirs.push(dir);
      }
    }
  }

  const secrets = readSecrets();
  input.secrets = secrets;

  const agentRunnerPath = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'dist',
    'index.js',
  );

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    TZ: TIMEZONE,
    HOME: groupSessionsDir.replace(/\/\.claude$/, ''),
    NANOCLAW_DIRECT_MODE: '1',
    NANOCLAW_GROUP_DIR: groupDir,
    NANOCLAW_IPC_DIR: groupIpcDir,
    NANOCLAW_GLOBAL_DIR: globalDir,
    // Secret env vars for the SDK (agent-runner merges these from ContainerInput.secrets too)
    ...secrets,
  };

  // Set up extra dir as a single base directory or pass individual paths
  if (extraDirs.length > 0) {
    // Create a symlink farm in a temp dir so agent-runner's /workspace/extra/* scan works
    const extraBase = path.join(DATA_DIR, 'sessions', group.folder, 'extra');
    fs.mkdirSync(extraBase, { recursive: true });
    for (const dir of extraDirs) {
      const linkName = path.join(extraBase, path.basename(dir));
      try {
        if (fs.existsSync(linkName)) fs.unlinkSync(linkName);
        fs.symlinkSync(dir, linkName);
      } catch {
        // Symlink may fail on some systems; agent-runner will still work without extras
      }
    }
    env.NANOCLAW_EXTRA_DIR = extraBase;
  }

  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const processName = `nanoclaw-direct-${safeName}-${Date.now()}`;

  logger.info(
    {
      group: group.name,
      processName,
      groupDir,
      ipcDir: groupIpcDir,
      isMain: input.isMain,
    },
    'Spawning direct agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const proc = spawn('node', [agentRunnerPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: groupDir,
      env,
    });

    onProcess(proc, processName);

    let stdout = '';
    let stderr = '';
    const MAX_OUTPUT = 10 * 1024 * 1024; // 10MB
    let stdoutTruncated = false;
    let stderrTruncated = false;

    // Pass input via stdin (same protocol as container-runner)
    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();
    delete input.secrets;

    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();
    let hadStreamingOutput = false;

    proc.stdout.on('data', (data) => {
      const chunk = data.toString();

      if (!stdoutTruncated) {
        const remaining = MAX_OUTPUT - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
        } else {
          stdout += chunk;
        }
      }

      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while (
          (startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1
        ) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break;

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            resetTimeout();
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    proc.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ agent: group.folder }, line);
      }
      if (stderrTruncated) return;
      const remaining = MAX_OUTPUT - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    const timeoutMs = Math.max(
      group.containerConfig?.timeout || 300_000,
      IDLE_TIMEOUT + 30_000,
    );

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, processName },
        'Direct agent timeout, killing',
      );
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
      }, 5000);
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    proc.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, duration, code },
            'Direct agent timed out after output (idle cleanup)',
          );
          outputChain.then(() =>
            resolve({ status: 'success', result: null, newSessionId }),
          );
          return;
        }
        resolve({
          status: 'error',
          result: null,
          error: `Direct agent timed out after ${timeoutMs}ms`,
        });
        return;
      }

      // Write log
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `direct-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      if (isVerbose || code !== 0) {
        fs.writeFileSync(
          logFile,
          [
            `=== Direct Agent Run Log ===`,
            `Group: ${group.name}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            ``,
            `=== Stderr ===`,
            stderr,
            ``,
            `=== Stdout ===`,
            stdout,
          ].join('\n'),
        );
      }

      if (code !== 0) {
        logger.error(
          { group: group.name, code, duration },
          'Direct agent exited with error',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Direct agent exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Direct agent completed (streaming mode)',
          );
          resolve({ status: 'success', result: null, newSessionId });
        });
        return;
      }

      // Legacy fallback: parse last output marker
      try {
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);
        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }
        resolve(JSON.parse(jsonLine));
      } catch (err) {
        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse direct agent output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, error: err },
        'Direct agent spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Direct agent spawn error: ${err.message}`,
      });
    });
  });
}
