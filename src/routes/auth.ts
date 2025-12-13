import express, { type Request, type Response } from 'express';
const { Router } = express;
import { createSession, getSession, deleteSession, verifyClientKey } from '../middleware/auth.ts';

// Parse cookies from request header
function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;

  cookieHeader.split(';').forEach(cookie => {
    const [name, ...rest] = cookie.trim().split('=');
    cookies[name] = rest.join('=');
  });

  return cookies;
}

export function createAuthRouter(certsDir: string) {
  const router = Router();

  // Login with client key/cert bundle (.pem file)
  router.post('/login', async (req, res) => {
    try {
      const { key } = req.body;

      if (!key) {
        return res.status(400).json({ error: 'Client credentials file is required' });
      }

      // Verify the key/cert bundle
      const result = await verifyClientKey(key, certsDir);

      if (!result.valid) {
        return res.status(401).json({ error: result.error || 'Invalid credentials' });
      }

      // Create session with username if available
      // @ts-ignore - fingerprint is present if valid is true
      const sessionId = createSession(result.fingerprint, result.username);

      // Set cookie (httpOnly for security, 24 hour expiry)
      res.setHeader('Set-Cookie', [
        `nats-eyes-session=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${24 * 60 * 60}`
      ]);

      res.json({
        success: true,
        message: 'Login successful',
        session: {
          fingerprint: result.fingerprint,
          username: result.username || null,
          keyOnly: result.keyOnly || false,
          validTo: result.validTo || null
        }
      });
    } catch (error: any) {
      console.error('Login error:', error);
      res.status(500).json({ error: 'Login failed: ' + error.message });
    }
  });

  // Logout
  router.post('/logout', (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    const sessionId = cookies['nats-eyes-session'];

    if (sessionId) {
      deleteSession(sessionId);
    }

    // Clear cookie
    res.setHeader('Set-Cookie', [
      'nats-eyes-session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'
    ]);

    res.json({ success: true, message: 'Logged out' });
  });

  // Check session status
  router.get('/session', (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    const sessionId = cookies['nats-eyes-session'];

    if (!sessionId) {
      return res.json({ authenticated: false });
    }

    const session = getSession(sessionId);
    if (!session) {
      return res.json({ authenticated: false });
    }

    res.json({
      authenticated: true,
      session: {
        fingerprint: session.keyFingerprint,
        username: session.username || null,
        expiresAt: new Date(session.expiresAt).toISOString()
      }
    });
  });

  return router;
}
