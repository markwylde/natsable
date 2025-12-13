import express, { type Request, type Response } from 'express';
const { Router } = express;
import nats, { type NatsConnection, type JetStreamClient, type ConnectionOptions, type KvEntry, type KvStatus, type StorageType } from 'nats';
const { connect, StringCodec } = nats;
import { join } from 'path';

const sc = StringCodec();

interface KVBucketInfo {
  name: string;
  streamName: string;
  description: string;
  subjects?: string[];
  maxBytes: number;
  maxMsgSize: number;
  maxAge: number;
  storage: StorageType;
  replicas: number;
  state: unknown; // StreamState type from nats but 'unknown' is used to avoid deep type dependency if not needed locally
}

interface KVKey {
  key: string;
  value: any;
  revision: number;
  created: Date | number;
  operation: string;
  bucket: string;
}

interface KVHistoryEntry {
  key: string;
  value: any;
  revision: number;
  created: Date | number;
  operation: string;
}

export function createKvRouter(natsUrl: string, certsDir: string) {
  const router = Router();
  let nc: NatsConnection | null = null;
  let js: JetStreamClient | null = null;

  // Connect to NATS on first request using TLS client certificate
  async function getNatsConnection() {
    if (!nc || nc.isClosed()) {
      // Ensure TLS prefix for secure connections
      const serverUrl = natsUrl.startsWith('tls://') ? natsUrl : `tls://${natsUrl}`;
      const tlsOptions: ConnectionOptions = {
        servers: serverUrl,
        tls: {
          // Client certificates for authentication (self-signed)
          // Server uses Let's Encrypt (verified by system CA)
          certFile: join(certsDir, 'admin-client.crt'),
          keyFile: join(certsDir, 'admin-client.key'),
        }
      };
      nc = await connect(tlsOptions);
      js = nc.jetstream();
    }
    return { nc, js: js! };
  }

  // List all KV buckets
  router.get('/buckets', async (req, res) => {
    try {
      const { js } = await getNatsConnection();
      const jsm = await js.jetstreamManager();

      const kvBuckets: KVBucketInfo[] = [];

      for await (const stream of jsm.streams.list()) {
        // KV buckets are streams with names starting with KV_
        if (stream.config.name.startsWith('KV_')) {
          const bucketName = stream.config.name.replace('KV_', '');
          kvBuckets.push({
            name: bucketName,
            streamName: stream.config.name,
            description: stream.config.description || '',
            subjects: stream.config.subjects,
            maxBytes: stream.config.max_bytes,
            maxMsgSize: stream.config.max_msg_size,
            maxAge: stream.config.max_age,
            storage: stream.config.storage,
            replicas: stream.config.num_replicas,
            state: stream.state
          });
        }
      }

      res.json({ buckets: kvBuckets });
    } catch (error: any) {
      console.error('Error listing KV buckets:', error);
      res.status(500).json({ error: 'Failed to list KV buckets', message: error.message });
    }
  });

  // Create a new KV bucket
  router.post('/buckets', async (req, res) => {
    try {
      const { name, description, maxBytes, maxAge, replicas, history } = req.body;

      if (!name) {
        return res.status(400).json({ error: 'Bucket name is required' });
      }

      // Validate bucket name (alphanumeric, underscore, dash)
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
        return res.status(400).json({ error: 'Bucket name can only contain alphanumeric characters, underscores, and dashes' });
      }

      const { js } = await getNatsConnection();

      const opts: any = {
        description: description || '',
        history: history || 1,
        replicas: replicas || 1
      };

      if (maxBytes) opts.max_bucket_size = parseInt(maxBytes);
      if (maxAge) opts.ttl = parseInt(maxAge);

      // Note: js.views.kv normally expects name without KV_ prefix if using standard KV
      await js.views.kv(name, opts);

      res.json({
        success: true,
        bucket: name,
        message: `Bucket "${name}" created successfully`
      });
    } catch (error: any) {
      console.error('Error creating KV bucket:', error);
      res.status(500).json({ error: 'Failed to create KV bucket', message: error.message });
    }
  });

  // Delete a KV bucket
  router.delete('/buckets/:name', async (req, res) => {
    try {
      const { name } = req.params;
      const { js } = await getNatsConnection();
      const jsm = await js.jetstreamManager();

      await jsm.streams.delete(`KV_${name}`);

      res.json({ success: true, message: `Bucket "${name}" deleted successfully` });
    } catch (error: any) {
      console.error('Error deleting KV bucket:', error);
      res.status(500).json({ error: 'Failed to delete KV bucket', message: error.message });
    }
  });

  // Get bucket info
  router.get('/buckets/:name', async (req, res) => {
    try {
      const { name } = req.params;
      const { js } = await getNatsConnection();
      const kv = await js.views.kv(name);
      const status: KvStatus = await kv.status();

      res.json({
        name: status.bucket,
        streamName: status.streamInfo.config.name,
        // @ts-ignore - description might be missing in type defs depending on version
        description: status.description || '',
        values: status.values,
        history: status.history,
        ttl: status.ttl,
        replicas: status.replicas,
        bytes: status.streamInfo.state.bytes,
        storage: status.backingStore,
        streamInfo: status.streamInfo
      });
    } catch (error: any) {
      console.error('Error getting bucket info:', error);
      res.status(500).json({ error: 'Failed to get bucket info', message: error.message });
    }
  });

  // List keys in a bucket
  router.get('/buckets/:name/keys', async (req, res) => {
    try {
      const { name } = req.params;
      const { search, limit = '100' } = req.query;
      const { js } = await getNatsConnection();
      const kv = await js.views.kv(name);

      const keys: string[] = [];
      const keyIterator = await kv.keys();

      for await (const key of keyIterator) {
        if (search && typeof search === 'string') {
          if (key.toLowerCase().includes(search.toLowerCase())) {
            keys.push(key);
          }
        } else {
          keys.push(key);
        }

        if (keys.length >= parseInt(limit as string)) break;
      }

      res.json({ keys, bucket: name });
    } catch (error: any) {
      console.error('Error listing keys:', error);
      res.status(500).json({ error: 'Failed to list keys', message: error.message });
    }
  });

  // Get a specific key value
  router.get('/buckets/:name/keys/:key', async (req, res) => {
    try {
      const { name, key } = req.params;
      const { js } = await getNatsConnection();
      const kv = await js.views.kv(name);

      const entry = await kv.get(key);

      if (!entry) {
        return res.status(404).json({ error: 'Key not found' });
      }

      let value: any;
      try {
        value = sc.decode(entry.value);
        // Try to parse as JSON
        try {
          value = JSON.parse(value);
        } catch {
          // Not JSON, keep as string
        }
      } catch {
        // If decoding fails, return as base64
        value = Buffer.from(entry.value).toString('base64');
      }

      const response: KVKey = {
        key: entry.key,
        value,
        revision: entry.revision,
        created: entry.created,
        operation: entry.operation,
        bucket: name
      };
      res.json(response);
    } catch (error: any) {
      console.error('Error getting key:', error);
      res.status(500).json({ error: 'Failed to get key', message: error.message });
    }
  });

  // Get key history
  router.get('/buckets/:name/keys/:key/history', async (req, res) => {
    try {
      const { name, key } = req.params;
      const { js } = await getNatsConnection();
      const kv = await js.views.kv(name);

      const history: KVHistoryEntry[] = [];
      const historyIterator = await kv.history({ key });

      for await (const entry of historyIterator) {
        let value: any;
        try {
          value = sc.decode(entry.value);
          try {
            value = JSON.parse(value);
          } catch {
            // Not JSON, keep as string
          }
        } catch {
          value = entry.value ? Buffer.from(entry.value).toString('base64') : null;
        }

        history.push({
          key: entry.key,
          value,
          revision: entry.revision,
          created: entry.created,
          operation: entry.operation
        });
      }

      res.json({ history, key, bucket: name });
    } catch (error: any) {
      console.error('Error getting key history:', error);
      res.status(500).json({ error: 'Failed to get key history', message: error.message });
    }
  });

  // Create or update a key
  router.put('/buckets/:name/keys/:key', async (req, res) => {
    try {
      const { name, key } = req.params;
      const { value } = req.body;

      if (value === undefined) {
        return res.status(400).json({ error: 'Value is required' });
      }

      const { js } = await getNatsConnection();
      const kv = await js.views.kv(name);

      // Convert value to string if it's an object
      const stringValue = typeof value === 'object' ? JSON.stringify(value) : String(value);

      const revision = await kv.put(key, sc.encode(stringValue));

      res.json({
        success: true,
        key,
        revision,
        message: `Key "${key}" saved successfully`
      });
    } catch (error: any) {
      console.error('Error saving key:', error);
      res.status(500).json({ error: 'Failed to save key', message: error.message });
    }
  });

  // Create a key (only if it doesn't exist)
  router.post('/buckets/:name/keys/:key', async (req, res) => {
    try {
      const { name, key } = req.params;
      const { value } = req.body;

      if (value === undefined) {
        return res.status(400).json({ error: 'Value is required' });
      }

      const { js } = await getNatsConnection();
      const kv = await js.views.kv(name);

      // Check if key exists
      const existing = await kv.get(key);
      if (existing) {
        return res.status(409).json({ error: 'Key already exists', key });
      }

      // Convert value to string if it's an object
      const stringValue = typeof value === 'object' ? JSON.stringify(value) : String(value);

      const revision = await kv.create(key, sc.encode(stringValue));

      res.json({
        success: true,
        key,
        revision,
        message: `Key "${key}" created successfully`
      });
    } catch (error: any) {
      console.error('Error creating key:', error);
      if (error.message.includes('wrong last sequence')) {
        res.status(409).json({ error: 'Key already exists', message: error.message });
      } else {
        res.status(500).json({ error: 'Failed to create key', message: error.message });
      }
    }
  });

  // Delete a key
  router.delete('/buckets/:name/keys/:key', async (req, res) => {
    try {
      const { name, key } = req.params;
      const { purge } = req.query;

      const { js } = await getNatsConnection();
      const kv = await js.views.kv(name);

      if (purge === 'true') {
        await kv.purge(key);
      } else {
        await kv.delete(key);
      }

      res.json({
        success: true,
        message: purge === 'true'
          ? `Key "${key}" purged successfully (all history removed)`
          : `Key "${key}" deleted successfully`
      });
    } catch (error: any) {
      console.error('Error deleting key:', error);
      res.status(500).json({ error: 'Failed to delete key', message: error.message });
    }
  });

  // Rename a key (copy to new key, delete old key)
  router.post('/buckets/:name/keys/:key/rename', async (req, res) => {
    try {
      const { name, key } = req.params;
      const { newKey } = req.body;

      if (!newKey) {
        return res.status(400).json({ error: 'New key name is required' });
      }

      if (newKey === key) {
        return res.status(400).json({ error: 'New key name must be different from current key' });
      }

      const { js } = await getNatsConnection();
      const kv = await js.views.kv(name);

      // Get current value
      const entry = await kv.get(key);
      if (!entry) {
        return res.status(404).json({ error: 'Key not found' });
      }

      // Check if new key already exists
      const existingNew = await kv.get(newKey);
      if (existingNew) {
        return res.status(409).json({ error: 'Target key already exists' });
      }

      // Create new key with same value
      const revision = await kv.put(newKey, entry.value);

      // Delete old key
      await kv.delete(key);

      res.json({
        success: true,
        oldKey: key,
        newKey,
        revision,
        message: `Key renamed from "${key}" to "${newKey}"`
      });
    } catch (error: any) {
      console.error('Error renaming key:', error);
      res.status(500).json({ error: 'Failed to rename key', message: error.message });
    }
  });

  // Watch bucket for changes (using SSE)
  router.get('/buckets/:name/watch', async (req, res) => {
    try {
      const { name } = req.params;
      const { js } = await getNatsConnection();
      const kv = await js.views.kv(name);

      // Set up SSE
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      const watcher = await kv.watch();

      // Handle client disconnect
      req.on('close', () => {
        watcher.stop();
      });

      for await (const entry of watcher) {
        let value: any;
        try {
          value = entry.value ? sc.decode(entry.value) : null;
          try {
            value = JSON.parse(value);
          } catch {
            // Not JSON
          }
        } catch {
          value = entry.value ? Buffer.from(entry.value).toString('base64') : null;
        }

        const event = {
          key: entry.key,
          value,
          revision: entry.revision,
          operation: entry.operation,
          timestamp: new Date().toISOString()
        };

        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (error: any) {
      console.error('Error watching bucket:', error);
      res.status(500).json({ error: 'Failed to watch bucket', message: error.message });
    }
  });

  return router;
}
