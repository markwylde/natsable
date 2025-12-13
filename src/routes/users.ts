import express, { type Request, type Response } from 'express';
const { Router } = express;
import { readFile, writeFile, readdir } from 'fs/promises';
import { join } from 'path';

interface Permissions {
  publish: string;
  subscribe: string;
}

interface NatsUser {
  username: string;
  hasPassword: boolean;
  permissions: Permissions;
}

interface ParsedConfig {
  users: NatsUser[];
}

export function createUsersRouter(configDir: string, certsDir: string, configFile: string = 'nats-server-dev.conf') {
  const router = Router();
  const configPath = join(configDir, configFile);

  // Parse NATS config file (simplified parser for user management)
  function parseNatsConfig(content: string): ParsedConfig {
    // This is a simplified parser - NATS config is not JSON
    // For production, consider using a proper NATS config parser
    const users: NatsUser[] = [];

    // Find users array in authorization block - handle nested braces
    const usersArrayMatch = content.match(/users\s*:\s*\[/);
    if (usersArrayMatch) {
      const startIdx = usersArrayMatch.index! + usersArrayMatch[0].length;
      let depth = 1;
      let endIdx = startIdx;

      // Find matching closing bracket
      for (let i = startIdx; i < content.length && depth > 0; i++) {
        if (content[i] === '[') depth++;
        else if (content[i] === ']') depth--;
        endIdx = i;
      }

      const usersBlock = content.substring(startIdx, endIdx);

      // Parse individual user blocks - handle nested braces
      let braceDepth = 0;
      let blockStart = -1;

      for (let i = 0; i < usersBlock.length; i++) {
        if (usersBlock[i] === '{') {
          if (braceDepth === 0) blockStart = i;
          braceDepth++;
        } else if (usersBlock[i] === '}') {
          braceDepth--;
          if (braceDepth === 0 && blockStart !== -1) {
            const block = usersBlock.substring(blockStart, i + 1);

            // Match user (with or without quotes)
            const userMatch = block.match(/user\s*:\s*"?([^"\s\n}]+)"?/);
            const passwordMatch = block.match(/password\s*:\s*"([^"]+)"/);

            // Parse permissions
            const publishMatch = block.match(/publish\s*:\s*(?:"([^"]+)"|\[([^\]]+)\]|(\>))/);
            const subscribeMatch = block.match(/subscribe\s*:\s*(?:"([^"]+)"|\[([^\]]+)\]|(\>))/);

            if (userMatch && passwordMatch) {
              // Only include users with passwords (password-based auth)
              users.push({
                username: userMatch[1],
                hasPassword: true,
                permissions: {
                  publish: publishMatch ? (publishMatch[1] || publishMatch[2] || publishMatch[3] || '') : '',
                  subscribe: subscribeMatch ? (subscribeMatch[1] || subscribeMatch[2] || subscribeMatch[3] || '') : ''
                }
              });
            }
            blockStart = -1;
          }
        }
      }
    }

    return { users };
  }

  // List all users from config
  router.get('/', async (req, res) => {
    try {
      const content = await readFile(configPath, 'utf8');
      const { users } = parseNatsConfig(content);

      // Also check for certificate-based users in certs directory
      const certFiles = await readdir(certsDir);
      const certUsers = certFiles
        .filter(f => f.endsWith('-client.crt'))
        .map(f => f.replace('-client.crt', ''));

      res.json({
        passwordUsers: users,
        certificateUsers: certUsers,
        configFile: configPath
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Get user details
  router.get('/:username', async (req, res) => {
    try {
      const { username } = req.params;
      const content = await readFile(configPath, 'utf8');
      const { users } = parseNatsConfig(content);

      const user = users.find(u => u.username === username);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      res.json({ user });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Note: Creating/updating users would require modifying the NATS config file
  // This is complex because NATS uses a custom config format, not JSON
  // For a production system, you'd want to:
  // 1. Use nsc tool for JWT-based auth (recommended)
  // 2. Or implement a proper NATS config parser/generator

  // Provide info about recommended approach
  router.get('/info/recommendations', (req, res) => {
    res.json({
      message: 'User management recommendations',
      options: [
        {
          name: 'Certificate-based auth (TLS)',
          description: 'Use client certificates for authentication. This is managed through the /api/certificates endpoints.',
          recommended: true,
          security: 'high'
        },
        {
          name: 'JWT-based auth with nsc',
          description: 'Use NATS Security Command (nsc) tool for managing operators, accounts, and users with JWTs.',
          recommended: true,
          security: 'high',
          docs: 'https://docs.nats.io/using-nats/nats-tools/nsc'
        },
        {
          name: 'Password-based auth',
          description: 'Simple username/password authentication. Less secure but easier to set up.',
          recommended: false,
          security: 'medium'
        }
      ]
    });
  });

  return router;
}
