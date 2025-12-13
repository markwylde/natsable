import { randomBytes, createHash } from 'crypto';
import { X509Certificate, createPrivateKey, createPublicKey, KeyObject } from 'crypto';
import { readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { type Request, type Response, type NextFunction } from 'express';

interface Session {
  id: string;
  keyFingerprint: string;
  username: string | null;
  createdAt: number;
  expiresAt: number;
}

interface AuthRequest extends Request {
  session?: Session;
}

// In-memory session store (for production, use Redis or similar)
const sessions = new Map<string, Session>();

// Session expiry time (24 hours)
const SESSION_EXPIRY = 24 * 60 * 60 * 1000;

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

// Generate a secure session ID
function generateSessionId(): string {
  return randomBytes(32).toString('hex');
}

// Create a new session
export function createSession(keyFingerprint: string, username: string | null = null): string {
  const sessionId = generateSessionId();
  const session: Session = {
    id: sessionId,
    keyFingerprint,
    username,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_EXPIRY
  };

  sessions.set(sessionId, session);
  return sessionId;
}

// Get session by ID
export function getSession(sessionId: string): Session | null {
  const session = sessions.get(sessionId);
  if (!session) return null;

  // Check if expired
  if (Date.now() > session.expiresAt) {
    sessions.delete(sessionId);
    return null;
  }

  return session;
}

// Delete session
export function deleteSession(sessionId: string): void {
  sessions.delete(sessionId);
}

// Parse a PEM file that may contain both certificate and key
function parsePemBundle(pemContent: string): { key: string | null; cert: string | null } {
  const result: { key: string | null; cert: string | null } = { key: null, cert: null };

  // Extract private key
  const keyMatch = pemContent.match(/-----BEGIN (?:EC |RSA )?PRIVATE KEY-----[\s\S]*?-----END (?:EC |RSA )?PRIVATE KEY-----/);
  if (keyMatch) {
    result.key = keyMatch[0];
  }

  // Extract certificate
  const certMatch = pemContent.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/);
  if (certMatch) {
    result.cert = certMatch[0];
  }

  return result;
}

// Extract username from certificate subject
function extractUsername(cert: X509Certificate): string | null {
  try {
    const subject = cert.subject;
    // Subject is in format like "CN=user@example.com\nemailAddress=user@example.com\nO=Org"
    const lines = subject.split('\n');
    for (const line of lines) {
      const [key, ...valueParts] = line.split('=');
      if (key.trim() === 'CN') {
        return valueParts.join('=').trim();
      }
    }
    // Fallback to emailAddress if CN not found
    for (const line of lines) {
      const [key, ...valueParts] = line.split('=');
      if (key.trim() === 'emailAddress') {
        return valueParts.join('=').trim();
      }
    }
  } catch (e) {
    // Ignore parsing errors
  }
  return null;
}

// Find matching certificate for a private key by checking all certs in certs directory
async function findMatchingCertificate(privateKey: KeyObject, certsDir: string): Promise<X509Certificate | null> {
  try {
    const files = await readdir(certsDir);
    const certFiles = files.filter(f => f.endsWith('.crt') && f !== 'ca.crt' && f !== 'server.crt');

    // Get public key from the private key
    const publicKey = createPublicKey(privateKey);
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });

    for (const file of certFiles) {
      try {
        const certPem = await readFile(join(certsDir, file), 'utf8');
        const cert = new X509Certificate(certPem);

        // Get public key from cert and compare
        const certPublicKeyPem = cert.publicKey.export({ type: 'spki', format: 'pem' });

        if (publicKeyPem === certPublicKeyPem) {
          return cert;
        }
      } catch (e) {
        // Skip invalid certs
        continue;
      }
    }
  } catch (e) {
    // Ignore errors
  }
  return null;
}

interface VerificationResult {
  valid: boolean;
  error?: string;
  fingerprint?: string;
  username?: string | null;
  subject?: string;
  validTo?: string;
  keyOnly?: boolean;
}

// Verify a client key/cert bundle
export async function verifyClientKey(pemContent: string, certsDir: string): Promise<VerificationResult> {
  try {
    const { key: keyPem, cert: certPem } = parsePemBundle(pemContent);

    if (!keyPem) {
      return { valid: false, error: 'No private key found in file' };
    }

    // Parse the private key to verify it's valid
    const privateKey = createPrivateKey(keyPem);

    // If a certificate is included in the bundle, verify it
    if (certPem) {
      const cert = new X509Certificate(certPem);

      // Read CA certificate to verify the client cert was signed by it
      const caCertPem = await readFile(join(certsDir, 'ca.crt'), 'utf8');
      const caCert = new X509Certificate(caCertPem);

      // Verify the certificate was signed by the CA
      if (!cert.verify(caCert.publicKey)) {
        return { valid: false, error: 'Certificate not signed by CA' };
      }

      // Check if certificate is expired
      if (new Date() > new Date(cert.validTo)) {
        return { valid: false, error: 'Certificate has expired' };
      }

      // Get fingerprint and username
      const fingerprint = cert.fingerprint256;
      const username = extractUsername(cert);

      return {
        valid: true,
        fingerprint,
        username,
        subject: cert.subject,
        validTo: cert.validTo
      };
    }

    // If only key provided, try to find matching certificate on server
    const matchingCert = await findMatchingCertificate(privateKey, certsDir);

    if (matchingCert) {
      // Read CA certificate to verify the matched cert was signed by it
      const caCertPem = await readFile(join(certsDir, 'ca.crt'), 'utf8');
      const caCert = new X509Certificate(caCertPem);

      // Verify the certificate was signed by the CA
      if (!matchingCert.verify(caCert.publicKey)) {
        return { valid: false, error: 'Certificate not signed by CA' };
      }

      // Check if certificate is expired
      if (new Date() > new Date(matchingCert.validTo)) {
        return { valid: false, error: 'Certificate has expired' };
      }

      const fingerprint = matchingCert.fingerprint256;
      const username = extractUsername(matchingCert);

      return {
        valid: true,
        fingerprint,
        username,
        subject: matchingCert.subject,
        validTo: matchingCert.validTo
      };
    }

    // No matching cert found - use key hash as fingerprint
    const keyHash = createHash('sha256').update(keyPem).digest('hex');

    return {
      valid: true,
      fingerprint: keyHash,
      keyOnly: true
    };
  } catch (error: any) {
    return { valid: false, error: error.message };
  }
}

// Auth middleware - protects routes
export function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  // Skip auth for login/logout endpoints
  if (req.path === '/api/auth/login' ||
      req.path === '/api/auth/logout' ||
      req.path === '/api/auth/session' ||
      req.path === '/api/health') {
    return next();
  }

  // Skip auth for static files
  if (!req.path.startsWith('/api/')) {
    return next();
  }

  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies['nats-eyes-session'];

  if (!sessionId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const session = getSession(sessionId);
  if (!session) {
    return res.status(401).json({ error: 'Session expired or invalid' });
  }

  // Attach session to request
  req.session = session;
  next();
}

// Clean up expired sessions periodically
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now > session.expiresAt) {
      sessions.delete(id);
    }
  }
}, 60 * 1000); // Clean up every minute
