import express, { type Request, type Response } from 'express';
const { Router } = express;
import nats, { type NatsConnection, type JetStreamClient, type StreamInfo, type ConsumerInfo, type ConnectionOptions, type StreamConfig, type ConsumerConfig, type MsgHdrs, DeliverPolicy, AckPolicy, ReplayPolicy, RetentionPolicy, StorageType } from 'nats';
const { connect, StringCodec } = nats;
import { join } from 'path';

const sc = StringCodec();

interface StreamState {
  messages: number;
  bytes: number;
  firstSeq: number;
  lastSeq: number;
  firstTs?: string; // These might be dates or strings depending on NATS client version
  lastTs?: string;
  consumerCount: number;
}

interface StreamResponse {
  name: string;
  description: string;
  subjects?: string[];
  retention: RetentionPolicy;
  maxConsumers: number;
  maxMsgs: number;
  maxBytes: number;
  maxAge: number;
  maxMsgSize: number;
  storage: StorageType;
  replicas: number;
  duplicateWindow: number;
  state: StreamState;
  config?: StreamConfig;
}

interface ConsumerResponse {
  name: string;
  streamName: string;
  created: string | number | Date; // Adjust based on NATS client
  config: ConsumerConfig;
  delivered: {
    consumer_seq: number;
    stream_seq: number;
  };
  ackFloor: {
    consumer_seq: number;
    stream_seq: number;
  };
  numAckPending: number;
  numRedelivered: number;
  numWaiting: number;
  numPending: number;
  cluster?: unknown;
  pushBound?: boolean;
}

export function createJetstreamRouter(natsUrl: string, certsDir: string) {
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

  // Helper to convert MsgHdrs to object
  function headersToObject(headers: MsgHdrs): Record<string, string[]> {
    const obj: Record<string, string[]> = {};
    for (const [key, value] of headers) {
      obj[key] = value;
    }
    return obj;
  }

  // List all streams
  router.get('/streams', async (req, res) => {
    try {
      const { js } = await getNatsConnection();
      const jsm = await js.jetstreamManager();

      const streams: StreamResponse[] = [];
      
      // Correct iteration for async iterable
      for await (const stream of jsm.streams.list()) {
        // Skip KV and Object Store streams
        if (stream.config.name.startsWith('KV_') || stream.config.name.startsWith('OBJ_')) {
          continue;
        }

        streams.push({
          name: stream.config.name,
          description: stream.config.description || '',
          subjects: stream.config.subjects,
          retention: stream.config.retention,
          maxConsumers: stream.config.max_consumers,
          maxMsgs: stream.config.max_msgs,
          maxBytes: stream.config.max_bytes,
          maxAge: stream.config.max_age,
          maxMsgSize: stream.config.max_msg_size,
          storage: stream.config.storage,
          replicas: stream.config.num_replicas,
          duplicateWindow: stream.config.duplicate_window || 0,
          state: {
            messages: stream.state.messages,
            bytes: stream.state.bytes,
            firstSeq: stream.state.first_seq,
            lastSeq: stream.state.last_seq,
            consumerCount: stream.state.consumer_count
          }
        });
      }

      res.json({ streams });
    } catch (error: any) {
      console.error('Error listing streams:', error);
      res.status(500).json({ error: 'Failed to list streams', message: error.message });
    }
  });

  // Create a new stream
  router.post('/streams', async (req, res) => {
    try {
      const { name, subjects, description, retention, maxMsgs, maxBytes, maxAge, replicas, storage } = req.body;

      if (!name) {
        return res.status(400).json({ error: 'Stream name is required' });
      }

      if (!subjects || !Array.isArray(subjects) || subjects.length === 0) {
        return res.status(400).json({ error: 'At least one subject is required' });
      }

      // Validate stream name (alphanumeric, underscore, dash)
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
        return res.status(400).json({ error: 'Stream name can only contain alphanumeric characters, underscores, and dashes' });
      }

      const { js } = await getNatsConnection();
      const jsm = await js.jetstreamManager();

      const config: Partial<StreamConfig> = {
        name,
        subjects,
        description: description || '',
        retention: (retention as RetentionPolicy) || RetentionPolicy.Limits,
        storage: (storage as StorageType) || StorageType.File,
        num_replicas: replicas || 1
      };

      if (maxMsgs) config.max_msgs = parseInt(maxMsgs);
      if (maxBytes) config.max_bytes = parseInt(maxBytes);
      if (maxAge) config.max_age = parseInt(maxAge); // nanoseconds

      await jsm.streams.add(config);

      res.json({
        success: true,
        stream: name,
        message: `Stream "${name}" created successfully`
      });
    } catch (error: any) {
      console.error('Error creating stream:', error);
      res.status(500).json({ error: 'Failed to create stream', message: error.message });
    }
  });

  // Delete a stream
  router.delete('/streams/:name', async (req, res) => {
    try {
      const { name } = req.params;
      const { js } = await getNatsConnection();
      const jsm = await js.jetstreamManager();

      await jsm.streams.delete(name);

      res.json({ success: true, message: `Stream "${name}" deleted successfully` });
    } catch (error: any) {
      console.error('Error deleting stream:', error);
      res.status(500).json({ error: 'Failed to delete stream', message: error.message });
    }
  });

  // Get stream info
  router.get('/streams/:name', async (req, res) => {
    try {
      const { name } = req.params;
      const { js } = await getNatsConnection();
      const jsm = await js.jetstreamManager();

      const stream = await jsm.streams.info(name);

      const response: StreamResponse = {
        name: stream.config.name,
        description: stream.config.description || '',
        subjects: stream.config.subjects,
        retention: stream.config.retention,
        maxConsumers: stream.config.max_consumers,
        maxMsgs: stream.config.max_msgs,
        maxBytes: stream.config.max_bytes,
        maxAge: stream.config.max_age,
        maxMsgSize: stream.config.max_msg_size,
        storage: stream.config.storage,
        replicas: stream.config.num_replicas,
        duplicateWindow: stream.config.duplicate_window || 0,
        state: {
          messages: stream.state.messages,
          bytes: stream.state.bytes,
          firstSeq: stream.state.first_seq,
          lastSeq: stream.state.last_seq,
          firstTs: stream.state.first_ts, // Adjust type if needed
          lastTs: stream.state.last_ts,
          consumerCount: stream.state.consumer_count
        },
        config: stream.config
      };
      res.json(response);
    } catch (error: any) {
      console.error('Error getting stream info:', error);
      res.status(500).json({ error: 'Failed to get stream info', message: error.message });
    }
  });

  // List consumers for a stream
  router.get('/streams/:name/consumers', async (req, res) => {
    try {
      const { name } = req.params;
      const { js } = await getNatsConnection();
      const jsm = await js.jetstreamManager();

      const consumers: ConsumerResponse[] = [];
      for await (const consumer of jsm.consumers.list(name)) {
        consumers.push({
          name: consumer.name,
          streamName: consumer.stream_name,
          created: consumer.created,
          config: consumer.config,
          delivered: {
            consumer_seq: consumer.delivered.consumer_seq,
            stream_seq: consumer.delivered.stream_seq
          },
          ackFloor: {
            consumer_seq: consumer.ack_floor.consumer_seq,
            stream_seq: consumer.ack_floor.stream_seq
          },
          numAckPending: consumer.num_ack_pending,
          numRedelivered: consumer.num_redelivered,
          numWaiting: consumer.num_waiting,
          numPending: consumer.num_pending,
          cluster: consumer.cluster,
          pushBound: consumer.push_bound
        });
      }

      res.json({ consumers, stream: name });
    } catch (error: any) {
      console.error('Error listing consumers:', error);
      res.status(500).json({ error: 'Failed to list consumers', message: error.message });
    }
  });

  // Create a consumer
  router.post('/streams/:name/consumers', async (req, res) => {
    try {
      const { name: streamName } = req.params;
      const { name, durableName, filterSubject, deliverPolicy, ackPolicy, maxDeliver, ackWait } = req.body;

      const consumerName = durableName || name;
      if (!consumerName) {
        return res.status(400).json({ error: 'Consumer name is required' });
      }

      const { js } = await getNatsConnection();
      const jsm = await js.jetstreamManager();

      const config: Partial<ConsumerConfig> = {
        durable_name: consumerName,
        deliver_policy: (deliverPolicy as DeliverPolicy) || DeliverPolicy.All,
        ack_policy: (ackPolicy as AckPolicy) || AckPolicy.Explicit
      };

      if (filterSubject) config.filter_subject = filterSubject;
      if (maxDeliver) config.max_deliver = parseInt(maxDeliver);
      if (ackWait) config.ack_wait = parseInt(ackWait);

      await jsm.consumers.add(streamName, config);

      res.json({
        success: true,
        consumer: consumerName,
        stream: streamName,
        message: `Consumer "${consumerName}" created successfully`
      });
    } catch (error: any) {
      console.error('Error creating consumer:', error);
      res.status(500).json({ error: 'Failed to create consumer', message: error.message });
    }
  });

  // Delete a consumer
  router.delete('/streams/:name/consumers/:consumer', async (req, res) => {
    try {
      const { name: streamName, consumer } = req.params;
      const { js } = await getNatsConnection();
      const jsm = await js.jetstreamManager();

      await jsm.consumers.delete(streamName, consumer);

      res.json({ success: true, message: `Consumer "${consumer}" deleted successfully` });
    } catch (error: any) {
      console.error('Error deleting consumer:', error);
      res.status(500).json({ error: 'Failed to delete consumer', message: error.message });
    }
  });

  // Get consumer info
  router.get('/streams/:name/consumers/:consumer', async (req, res) => {
    try {
      const { name: streamName, consumer } = req.params;
      const { js } = await getNatsConnection();
      const jsm = await js.jetstreamManager();

      const info = await jsm.consumers.info(streamName, consumer);

      const response: ConsumerResponse = {
        name: info.name,
        streamName: info.stream_name,
        created: info.created,
        config: info.config,
        delivered: {
          consumer_seq: info.delivered.consumer_seq,
          stream_seq: info.delivered.stream_seq
        },
        ackFloor: {
          consumer_seq: info.ack_floor.consumer_seq,
          stream_seq: info.ack_floor.stream_seq
        },
        numAckPending: info.num_ack_pending,
        numRedelivered: info.num_redelivered,
        numWaiting: info.num_waiting,
        numPending: info.num_pending,
        cluster: info.cluster,
        pushBound: info.push_bound
      };
      res.json(response);
    } catch (error: any) {
      console.error('Error getting consumer info:', error);
      res.status(500).json({ error: 'Failed to get consumer info', message: error.message });
    }
  });

  // Get messages from a stream (browse mode)
  router.get('/streams/:name/messages', async (req, res) => {
    try {
      const { name } = req.params;
      const { startSeq, limit = '50' } = req.query;
      const { js } = await getNatsConnection();
      const jsm = await js.jetstreamManager();

      // Get stream info first to know the bounds
      const streamInfo = await jsm.streams.info(name);
      const firstSeq = streamInfo.state.first_seq;
      const lastSeq = streamInfo.state.last_seq;

      if (lastSeq < firstSeq) {
        return res.json({ messages: [], stream: name, firstSeq, lastSeq });
      }

      const messages: any[] = [];
      const stream = await js.streams.get(name);

      // Default to last N messages
      const effectiveLimit = Math.min(parseInt(limit as string), 100);
      const start = startSeq ? parseInt(startSeq as string) : Math.max(firstSeq, lastSeq - effectiveLimit + 1);

      // Fetch messages
      for (let seq = start; seq <= lastSeq && messages.length < effectiveLimit; seq++) {
        try {
          const msg = await stream.getMessage({ seq });
          if (msg) {
            let data: any;
            try {
              data = sc.decode(msg.data);
              // Try to parse as JSON
              try {
                data = JSON.parse(data);
              } catch {
                // Not JSON, keep as string
              }
            } catch {
              // If decoding fails, return as base64
              data = Buffer.from(msg.data).toString('base64');
            }

            messages.push({
              seq: msg.seq,
              subject: msg.subject,
              data,
              time: msg.time, // or msg.info.timestamp if available
              headers: msg.header ? headersToObject(msg.header) : null
            });
          }
        } catch (e) {
          // Message might have been deleted, skip
          continue;
        }
      }

      res.json({
        messages,
        stream: name,
        firstSeq,
        lastSeq,
        hasMore: start + messages.length <= lastSeq
      });
    } catch (error: any) {
      console.error('Error getting messages:', error);
      res.status(500).json({ error: 'Failed to get messages', message: error.message });
    }
  });

  // Get a single message by sequence
  router.get('/streams/:name/messages/:seq', async (req, res) => {
    try {
      const { name, seq } = req.params;
      const { js } = await getNatsConnection();

      const stream = await js.streams.get(name);
      const msg = await stream.getMessage({ seq: parseInt(seq) });

      if (!msg) {
        return res.status(404).json({ error: 'Message not found' });
      }

      let data: any;
      try {
        data = sc.decode(msg.data);
        try {
          data = JSON.parse(data);
        } catch {
          // Not JSON
        }
      } catch {
        data = Buffer.from(msg.data).toString('base64');
      }

      res.json({
        seq: msg.seq,
        subject: msg.subject,
        data,
        time: msg.time,
        headers: msg.header ? headersToObject(msg.header) : null,
        stream: name
      });
    } catch (error: any) {
      console.error('Error getting message:', error);
      res.status(500).json({ error: 'Failed to get message', message: error.message });
    }
  });

  // Publish a message to a subject
  router.post('/streams/:name/publish', async (req, res) => {
    try {
      const { name } = req.params;
      const { subject, data, headers } = req.body;

      if (!subject) {
        return res.status(400).json({ error: 'Subject is required' });
      }

      const { js } = await getNatsConnection();

      // Convert data to string if it's an object
      const payload = typeof data === 'object' ? JSON.stringify(data) : String(data || '');

      const pubAck = await js.publish(subject, sc.encode(payload));

      res.json({
        success: true,
        seq: pubAck.seq,
        stream: pubAck.stream,
        duplicate: pubAck.duplicate,
        message: `Message published to "${subject}" (seq: ${pubAck.seq})`
      });
    } catch (error: any) {
      console.error('Error publishing message:', error);
      res.status(500).json({ error: 'Failed to publish message', message: error.message });
    }
  });

  // Purge stream messages
  router.post('/streams/:name/purge', async (req, res) => {
    try {
      const { name } = req.params;
      const { filter, seq, keep } = req.body;
      const { js } = await getNatsConnection();
      const jsm = await js.jetstreamManager();

      const opts: any = {}; // Type depends on PurgeOptions
      if (filter) opts.filter = filter;
      if (seq) opts.seq = parseInt(seq);
      if (keep) opts.keep = parseInt(keep);

      const result = await jsm.streams.purge(name, opts);

      res.json({
        success: true,
        purged: result.purged,
        message: `Purged ${result.purged} messages from stream "${name}"`
      });
    } catch (error: any) {
      console.error('Error purging stream:', error);
      res.status(500).json({ error: 'Failed to purge stream', message: error.message });
    }
  });

  // Delete a specific message by sequence
  router.delete('/streams/:name/messages/:seq', async (req, res) => {
    try {
      const { name, seq } = req.params;
      const { noErase } = req.query;
      const { js } = await getNatsConnection();
      const jsm = await js.jetstreamManager();

      await jsm.streams.deleteMessage(name, parseInt(seq), noErase !== 'true');

      res.json({
        success: true,
        message: `Message ${seq} deleted from stream "${name}"`
      });
    } catch (error: any) {
      console.error('Error deleting message:', error);
      res.status(500).json({ error: 'Failed to delete message', message: error.message });
    }
  });

  return router;
}
