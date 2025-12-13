import express, { type Request, type Response } from 'express';
const { Router } = express;
import nats, { type NatsConnection, type JetStreamClient } from 'nats';
const { connect } = nats;

interface Varz {
  server_id: string;
  server_name: string;
  version: string;
  uptime: string;
  cpu: number;
  mem: number;
  connections: number;
  subscriptions: number;
  total_connections: number;
  routes: number;
  remotes: number;
  leafnodes: number;
  slow_consumers: number;
  in_msgs: number;
  out_msgs: number;
  in_bytes: number;
  out_bytes: number;
  tls_required: boolean;
  auth_required: boolean;
  max_connections: number;
  max_payload: number;
  ping_interval: number;
  ping_max: number;
}

interface ConnectionInfo {
  cid: number;
  ip: string;
  port: number;
  start: string;
  last_activity: string;
  rtt: string;
  uptime: string;
  idle: string;
  pending_bytes: number;
  pending_size: number; // This might be pending messages count? Using pending_size as per original code access
  in_msgs: number;
  out_msgs: number;
  in_bytes: number;
  out_bytes: number;
  subscriptions: number;
  name?: string;
  lang?: string;
  version?: string;
  tls_version?: string;
  tls_cipher_suite?: string;
  authorized_user?: string;
  slow_consumer?: boolean;
}

interface Connz {
  server_id: string;
  now: string;
  num_connections: number;
  total: number;
  offset: number;
  limit: number;
  connections: ConnectionInfo[];
  pending?: number; // Added pending property
}

interface StreamState {
  messages: number;
  bytes: number;
  first_seq: number;
  first_ts: string;
  last_seq: number;
  last_ts: string;
  consumer_count: number;
}

interface StreamConfig {
  name: string;
  subjects?: string[];
  retention: string;
  max_consumers: number;
  max_msgs: number;
  max_bytes: number;
  max_age: number;
  max_msgs_per_subject: number;
  max_msg_size: number;
  storage: string;
  num_replicas: number;
}

interface StreamDetail {
  name: string;
  created: string;
  state: StreamState;
  config: StreamConfig;
}

interface AccountDetail {
  name: string;
  stream_detail?: StreamDetail[];
}

interface Jsz {
  server_id: string;
  now: string;
  config?: {
    max_memory: number;
    max_storage: number;
    store_dir: string;
  };
  memory: number;
  storage: number;
  reserved_memory: number;
  reserved_storage: number;
  streams: number;
  consumers: number;
  messages: number;
  bytes: number;
  accounts: number;
  ha_assets: number;
  api?: {
    total: number;
    errors: number;
  };
  account_details?: AccountDetail[];
}

interface BucketDetail {
  name: string;
  keys: number;
  bytes: number;
  replicas: number;
  storage: string;
}

interface KvStats {
  buckets: number;
  totalKeys: number;
  totalBytes: number;
  bucketDetails: BucketDetail[];
}

interface StreamSummary {
  name: string;
  messages: number;
  bytes: number;
  consumers: number;
  firstSeq: number;
  lastSeq: number;
}

export function createNatsRouter(monitoringUrl: string, natsUrl: string) {
  const router = Router();
  let nc: NatsConnection | null = null;
  let js: JetStreamClient | null = null;

  // Connect to NATS for KV stats
  async function getNatsConnection() {
    if (!nc || nc.isClosed()) {
      nc = await connect({ servers: natsUrl });
      js = nc.jetstream();
    }
    return { nc, js };
  }

  // Proxy to NATS monitoring endpoints
  async function proxyToNats(endpoint: string, res: Response) {
    try {
      const response = await fetch(`${monitoringUrl}${endpoint}`);
      if (!response.ok) {
        throw new Error(`NATS returned ${response.status}`);
      }
      const data = await response.json();
      res.json(data);
    } catch (error: any) {
      res.status(503).json({
        error: 'Failed to connect to NATS',
        message: error.message
      });
    }
  }

  // Server info
  router.get('/varz', (req, res) => proxyToNats('/varz', res));

  // Connection info
  router.get('/connz', async (req, res) => {
    const params = new URLSearchParams();
    if (typeof req.query.subs === 'string') params.set('subs', req.query.subs);
    if (typeof req.query.limit === 'string') params.set('limit', req.query.limit);
    if (typeof req.query.offset === 'string') params.set('offset', req.query.offset);
    if (typeof req.query.sort === 'string') params.set('sort', req.query.sort);
    const queryString = params.toString();
    proxyToNats(`/connz${queryString ? '?' + queryString : ''}`, res);
  });

  // Subscription info
  router.get('/subsz', (req, res) => proxyToNats('/subsz', res));

  // Route info (for clusters)
  router.get('/routez', (req, res) => proxyToNats('/routez', res));

  // Gateway info
  router.get('/gatewayz', (req, res) => proxyToNats('/gatewayz', res));

  // Leaf node info
  router.get('/leafz', (req, res) => proxyToNats('/leafz', res));

  // JetStream info
  router.get('/jsz', async (req, res) => {
    const params = new URLSearchParams();
    if (typeof req.query.acc === 'string') params.set('acc', req.query.acc);
    if (typeof req.query.accounts === 'string') params.set('accounts', req.query.accounts);
    if (typeof req.query.streams === 'string') params.set('streams', req.query.streams);
    if (typeof req.query.consumers === 'string') params.set('consumers', req.query.consumers);
    if (typeof req.query.config === 'string') params.set('config', req.query.config);
    const queryString = params.toString();
    proxyToNats(`/jsz${queryString ? '?' + queryString : ''}`, res);
  });

  // Account info
  router.get('/accountz', (req, res) => proxyToNats('/accountz', res));

  // Health check
  router.get('/healthz', (req, res) => proxyToNats('/healthz', res));

  // Combined status for dashboard
  router.get('/status', async (req, res) => {
    try {
      const [varzRes, connzRes, jszRes] = await Promise.all([
        fetch(`${monitoringUrl}/varz`),
        fetch(`${monitoringUrl}/connz?sort=bytes_to&limit=10`),
        fetch(`${monitoringUrl}/jsz?streams=true&consumers=true`)
      ]);

      const varz = await varzRes.json() as Varz;
      const connz = await connzRes.json() as Connz;
      const jsz = await jszRes.json() as Jsz;

      // Get KV store stats
      let kvStats: KvStats = { buckets: 0, totalKeys: 0, totalBytes: 0, bucketDetails: [] };
      try {
        const { js } = await getNatsConnection();
        if (js) {
          const jsm = await js.jetstreamManager();

          for await (const stream of jsm.streams.list()) {
            if (stream.config.name.startsWith('KV_')) {
              const bucketName = stream.config.name.replace('KV_', '');
              kvStats.buckets++;
              kvStats.totalKeys += stream.state.messages || 0;
              kvStats.totalBytes += stream.state.bytes || 0;
              kvStats.bucketDetails.push({
                name: bucketName,
                keys: stream.state.messages || 0,
                bytes: stream.state.bytes || 0,
                replicas: stream.config.num_replicas || 1,
                storage: stream.config.storage
              });
            }
          }
        }
      } catch (kvError: any) {
        console.error('Error fetching KV stats:', kvError.message);
      }

      // Count slow consumers from connections
      let slowConsumers = 0;
      let pendingBytes = 0;
      let pendingMessages = 0;
      if (connz.connections) {
        connz.connections.forEach(conn => {
          if (conn.slow_consumer) slowConsumers++;
          pendingBytes += conn.pending_bytes || 0;
          pendingMessages += conn.pending_size || 0; // Assuming pending_size based on usage context
        });
      }

      // Count streams and get stream details
      let streamDetails: StreamSummary[] = [];
      if (jsz.account_details) {
        jsz.account_details.forEach(account => {
          if (account.stream_detail) {
            account.stream_detail.forEach(stream => {
              // Skip KV streams (they're counted separately)
              if (!stream.name.startsWith('KV_') && !stream.name.startsWith('OBJ_')) {
                streamDetails.push({
                  name: stream.name,
                  messages: stream.state?.messages || 0,
                  bytes: stream.state?.bytes || 0,
                  consumers: stream.state?.consumer_count || 0,
                  firstSeq: stream.state?.first_seq || 0,
                  lastSeq: stream.state?.last_seq || 0
                });
              }
            });
          }
        });
      }

      res.json({
        server: {
          id: varz.server_id,
          name: varz.server_name,
          version: varz.version,
          uptime: varz.uptime,
          cpu: varz.cpu,
          mem: varz.mem,
          connections: varz.connections,
          subscriptions: varz.subscriptions,
          totalConnections: varz.total_connections,
          routes: varz.routes || 0,
          remotes: varz.remotes || 0,
          leafNodes: varz.leafnodes || 0,
          slowConsumers: varz.slow_consumers || slowConsumers,
          messages: {
            in: varz.in_msgs,
            out: varz.out_msgs
          },
          bytes: {
            in: varz.in_bytes,
            out: varz.out_bytes
          },
          tls_required: varz.tls_required,
          auth_required: varz.auth_required,
          maxConnections: varz.max_connections,
          maxPayload: varz.max_payload,
          pingInterval: varz.ping_interval,
          pingMax: varz.ping_max
        },
        connections: {
          total: connz.num_connections,
          pending: connz.pending,
          pendingBytes: pendingBytes,
          pendingMessages: pendingMessages,
          list: connz.connections
        },
        jetstream: jsz.config ? {
          enabled: true,
          memory: jsz.memory,
          storage: jsz.storage,
          reservedMemory: jsz.reserved_memory || 0,
          reservedStorage: jsz.reserved_storage || 0,
          streams: jsz.streams,
          consumers: jsz.consumers,
          messages: jsz.messages || 0,
          bytes: jsz.bytes || 0,
          streamDetails: streamDetails,
          accounts: jsz.accounts || 1,
          haAssets: jsz.ha_assets || 0,
          apiTotal: jsz.api?.total || 0,
          apiErrors: jsz.api?.errors || 0
        } : { enabled: false },
        kv: kvStats
      });
    } catch (error: any) {
      res.status(500).json({
        error: 'Failed to get NATS status',
        message: error.message
      });
    }
  });

  return router;
}
