import express, { type Request, type Response } from 'express';
const { Router } = express;
import { readdir, readFile, writeFile, unlink, mkdir } from 'fs/promises';
import { join } from 'path';
import { execSync } from 'child_process';
import { X509Certificate, createPrivateKey, generateKeyPairSync } from 'crypto';

interface CertificateInfo {
  subject: Record<string, string>;
  issuer: Record<string, string>;
  serialNumber: string;
  validFrom: string;
  validTo: string;
  isExpired: boolean;
  fingerprint: string;
  keyType: string | undefined;
}

interface CertificateFile extends CertificateInfo {
  name: string;
  filename: string;
  hasPrivateKey?: boolean;
  error?: string;
}

export function createCertificateRouter(certsDir: string) {
  const router = Router();

  // Helper to read certificate details using Node's built-in X509Certificate
  async function getCertificateInfo(certPath: string): Promise<CertificateInfo> {
    try {
      const certPem = await readFile(certPath, 'utf8');
      const cert = new X509Certificate(certPem);

      // Parse subject and issuer
      const parseDistinguishedName = (dn: string): Record<string, string> => {
        const result: Record<string, string> = {};
        const parts = dn.split('\n');
        for (const part of parts) {
          const [key, ...valueParts] = part.split('=');
          if (key && valueParts.length > 0) {
            result[key.trim()] = valueParts.join('=').trim();
          }
        }
        return result;
      };

      return {
        subject: parseDistinguishedName(cert.subject),
        issuer: parseDistinguishedName(cert.issuer),
        serialNumber: cert.serialNumber,
        validFrom: cert.validFrom,
        validTo: cert.validTo,
        isExpired: new Date() > new Date(cert.validTo),
        fingerprint: cert.fingerprint256.replace(/:/g, ':'),
        keyType: cert.publicKey.asymmetricKeyType
      };
    } catch (error: any) {
      throw new Error(`Failed to read certificate: ${error.message}`);
    }
  }

  // List all certificates
  router.get('/', async (req, res) => {
    try {
      const files = await readdir(certsDir);
      const certFiles = files.filter(f => f.endsWith('.crt') && f !== 'ca.crt');

      const certificates = await Promise.all(
        certFiles.map(async (file) => {
          const name = file.replace('.crt', '');
          const certPath = join(certsDir, file);
          const keyPath = join(certsDir, `${name}.key`);

          try {
            const info = await getCertificateInfo(certPath);
            let hasPrivateKey = false;
            try {
              await readFile(keyPath);
              hasPrivateKey = true;
            } catch {}

            return {
              name,
              filename: file,
              hasPrivateKey,
              ...info
            };
          } catch (error: any) {
            return {
              name,
              filename: file,
              error: error.message
            } as CertificateFile;
          }
        })
      );

      res.json({ certificates });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Get CA certificate info
  router.get('/ca', async (req, res) => {
    try {
      const caPath = join(certsDir, 'ca.crt');
      const info = await getCertificateInfo(caPath);
      res.json({ ca: info });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Get specific certificate
  router.get('/:name', async (req, res) => {
    try {
      const { name } = req.params;
      const certPath = join(certsDir, `${name}.crt`);
      const info = await getCertificateInfo(certPath);
      res.json({ certificate: { name, ...info } });
    } catch (error: any) {
      res.status(404).json({ error: `Certificate not found: ${error.message}` });
    }
  });

  // Create new client certificate using openssl
  router.post('/', async (req, res) => {
    try {
      const { username, email, days = 365 } = req.body;
      // Use organization if provided and non-empty, otherwise use default
      const organization = req.body.organization?.trim() || 'Natsable';

      if (!username || !email) {
        return res.status(400).json({ error: 'Username and email are required' });
      }

      // Sanitize username for filename
      const safeName = username.replace(/[^a-zA-Z0-9-_]/g, '-').toLowerCase();
      const certPath = join(certsDir, `${safeName}-client.crt`);
      const keyPath = join(certsDir, `${safeName}-client.key`);
      const csrPath = join(certsDir, `${safeName}-client.csr`);
      const cnfPath = join(certsDir, `${safeName}-client.cnf`);
      const extPath = join(certsDir, `${safeName}-client-ext.cnf`);

      // Check if certificate already exists
      try {
        await readFile(certPath);
        return res.status(409).json({ error: 'Certificate already exists for this user' });
      } catch {}

      // Create CSR config
      const csrConfig = `[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn

[dn]
CN = ${email}
emailAddress = ${email}
O = ${organization}
`;
      await writeFile(cnfPath, csrConfig);

      // Create extensions config
      const extConfig = `authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage = digitalSignature
extendedKeyUsage = clientAuth
subjectAltName = email:${email}
`;
      await writeFile(extPath, extConfig);

      try {
        // Generate EC key
        execSync(`openssl ecparam -name prime256v1 -genkey -noout -out "${keyPath}"`, { cwd: certsDir });

        // Generate CSR
        execSync(`openssl req -new -sha256 -key "${keyPath}" -out "${csrPath}" -config "${cnfPath}"`, { cwd: certsDir });

        // Sign with CA
        execSync(`openssl x509 -req -sha256 -days ${days} -in "${csrPath}" -CA ca.crt -CAkey ca.key -CAcreateserial -out "${certPath}" -extfile "${extPath}"`, { cwd: certsDir });

        // Set key file permissions
        execSync(`chmod 600 "${keyPath}"`, { cwd: certsDir });

        // Clean up temp files
        await unlink(csrPath).catch(() => {});
        await unlink(cnfPath).catch(() => {});
        await unlink(extPath).catch(() => {});

        const info = await getCertificateInfo(certPath);

        res.status(201).json({
          message: 'Certificate created successfully',
          certificate: {
            name: `${safeName}-client`,
            ...info
          }
        });
      } catch (execError: any) {
        // Clean up on error
        await unlink(keyPath).catch(() => {});
        await unlink(csrPath).catch(() => {});
        await unlink(cnfPath).catch(() => {});
        await unlink(extPath).catch(() => {});
        throw new Error(`Failed to generate certificate: ${execError.message}`);
      }
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Delete certificate
  router.delete('/:name', async (req, res) => {
    try {
      const { name } = req.params;

      // Don't allow deleting CA or server certs
      if (name === 'ca' || name === 'server') {
        return res.status(403).json({ error: 'Cannot delete CA or server certificate' });
      }

      const certPath = join(certsDir, `${name}.crt`);
      const keyPath = join(certsDir, `${name}.key`);

      try {
        await unlink(certPath);
      } catch {}

      try {
        await unlink(keyPath);
      } catch {}

      res.json({ message: `Certificate ${name} deleted` });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Download certificate bundle (cert + key)
  router.get('/:name/download', async (req, res) => {
    try {
      const { name } = req.params;
      const certPath = join(certsDir, `${name}.crt`);
      const keyPath = join(certsDir, `${name}.key`);

      const cert = await readFile(certPath, 'utf8');
      let bundle = cert;

      try {
        const key = await readFile(keyPath, 'utf8');
        bundle = `${cert}\n${key}`;
      } catch {}

      res.setHeader('Content-Type', 'application/x-pem-file');
      res.setHeader('Content-Disposition', `attachment; filename="${name}.pem"`);
      res.send(bundle);
    } catch (error: any) {
      res.status(404).json({ error: `Certificate not found: ${error.message}` });
    }
  });

  return router;
}
