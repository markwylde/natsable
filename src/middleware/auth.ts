import { createHash, createVerify, randomBytes } from 'node:crypto';
import { X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { NextFunction, Request, Response } from 'express';

interface Session {
  id: string;
  keyFingerprint: string;
  username: string | null;
  createdAt: number;
  expiresAt: number;
}

interface Challenge {
  challenge: string;
  certFingerprint: string;
  createdAt: number;
  expiresAt: number;
}

interface AuthRequest extends Request {
  session?: Session;
}

// In-memory session store (for production, use Redis or similar)
const sessions = new Map<string, Session>();

// In-memory challenge store (short-lived, 60 seconds)
const challenges = new Map<string, Challenge>();

// Session expiry time (24 hours)
const SESSION_EXPIRY = 24 * 60 * 60 * 1000;

// Challenge expiry time (60 seconds)
const CHALLENGE_EXPIRY = 60 * 1000;

// Parse cookies from request header
function parseCookies(
  cookieHeader: string | undefined,
): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;

  cookieHeader.split(';').forEach((cookie) => {
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
export function createSession(
  keyFingerprint: string,
  username: string | null = null,
): string {
  const sessionId = generateSessionId();
  const session: Session = {
    id: sessionId,
    keyFingerprint,
    username,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_EXPIRY,
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

// Parse a PEM file to extract certificate
function parseCertFromPem(pemContent: string): string | null {
  const certMatch = pemContent.match(
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/,
  );
  return certMatch ? certMatch[0] : null;
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

interface ChallengeResult {
  valid: boolean;
  error?: string;
  challengeId?: string;
  challenge?: string;
  fingerprint?: string;
  username?: string | null;
  validTo?: string;
}

interface VerifySignatureResult {
  valid: boolean;
  error?: string;
  fingerprint?: string;
  username?: string | null;
  validTo?: string;
}

// Create a challenge for a certificate
export async function createChallenge(
  certPem: string,
  certsDir: string,
): Promise<ChallengeResult> {
  try {
    const certContent = parseCertFromPem(certPem);
    if (!certContent) {
      return { valid: false, error: 'No certificate found in file' };
    }

    const cert = new X509Certificate(certContent);

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

    // Generate a random challenge
    const challengeId = randomBytes(16).toString('hex');
    const challenge = randomBytes(32).toString('base64');
    const fingerprint = cert.fingerprint256;

    // Store the challenge
    challenges.set(challengeId, {
      challenge,
      certFingerprint: fingerprint,
      createdAt: Date.now(),
      expiresAt: Date.now() + CHALLENGE_EXPIRY,
    });

    const username = extractUsername(cert);

    return {
      valid: true,
      challengeId,
      challenge,
      fingerprint,
      username,
      validTo: cert.validTo,
    };
  } catch (error: any) {
    return { valid: false, error: error.message };
  }
}

// Verify a signed challenge
export async function verifySignature(
  challengeId: string,
  signature: string,
  certPem: string,
  certsDir: string,
): Promise<VerifySignatureResult> {
  try {
    // Get the challenge
    const storedChallenge = challenges.get(challengeId);
    if (!storedChallenge) {
      return { valid: false, error: 'Challenge not found or expired' };
    }

    // Check if challenge is expired
    if (Date.now() > storedChallenge.expiresAt) {
      challenges.delete(challengeId);
      return { valid: false, error: 'Challenge expired' };
    }

    // Parse the certificate
    const certContent = parseCertFromPem(certPem);
    if (!certContent) {
      return { valid: false, error: 'No certificate found' };
    }

    const cert = new X509Certificate(certContent);

    // Verify the certificate fingerprint matches
    if (cert.fingerprint256 !== storedChallenge.certFingerprint) {
      return { valid: false, error: 'Certificate mismatch' };
    }

    // Re-verify the certificate is signed by CA (defense in depth)
    const caCertPem = await readFile(join(certsDir, 'ca.crt'), 'utf8');
    const caCert = new X509Certificate(caCertPem);
    if (!cert.verify(caCert.publicKey)) {
      return { valid: false, error: 'Certificate not signed by CA' };
    }

    // Verify the signature using the certificate's public key
    const verify = createVerify('SHA256');
    verify.update(storedChallenge.challenge);
    verify.end();

    const signatureBuffer = Buffer.from(signature, 'base64');
    const isValid = verify.verify(cert.publicKey, signatureBuffer);

    if (!isValid) {
      return { valid: false, error: 'Invalid signature' };
    }

    // Delete the used challenge
    challenges.delete(challengeId);

    const fingerprint = cert.fingerprint256;
    const username = extractUsername(cert);

    return {
      valid: true,
      fingerprint,
      username,
      validTo: cert.validTo,
    };
  } catch (error: any) {
    return { valid: false, error: error.message };
  }
}

// Auth middleware - protects routes
export function authMiddleware(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) {
  // Skip auth for login/logout/challenge endpoints
  if (
    req.path === '/api/auth/login' ||
    req.path === '/api/auth/logout' ||
    req.path === '/api/auth/session' ||
    req.path === '/api/auth/challenge' ||
    req.path === '/api/health'
  ) {
    return next();
  }

  // Skip auth for static files
  if (!req.path.startsWith('/api/')) {
    return next();
  }

  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies['natsable-session'];

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

// Clean up expired sessions and challenges periodically
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now > session.expiresAt) {
      sessions.delete(id);
    }
  }
  for (const [id, challenge] of challenges) {
    if (now > challenge.expiresAt) {
      challenges.delete(id);
    }
  }
}, 60 * 1000); // Clean up every minute
