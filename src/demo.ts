import nats, { type ConnectionOptions, type NatsConnection, type JetStreamClient, RetentionPolicy, StorageType, DiscardPolicy, AckPolicy, DeliverPolicy, ReplayPolicy } from 'nats';
const { connect, StringCodec, JSONCodec } = nats;
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const sc = StringCodec();
const jc = JSONCodec();

// Configuration
const NATS_URL = process.env.NATS_URL || 'localhost:4223';
const CERTS_DIR = process.env.CERTS_DIR || join(__dirname, '..', 'certs');

// Load certificates for TLS with client authentication
let tlsOptions: Partial<ConnectionOptions> = {};
try {
  const caCert = readFileSync(join(CERTS_DIR, 'ca.crt'), 'utf8');
  const clientCert = readFileSync(join(CERTS_DIR, 'user1-client.crt'), 'utf8');
  const clientKey = readFileSync(join(CERTS_DIR, 'user1-client.key'), 'utf8');
  tlsOptions = {
    tls: {
      ca: caCert,
      cert: clientCert,
      key: clientKey,
    }
  };
  console.log('TLS enabled with client certificate (user1)');
} catch (err: any) {
  console.log('Certificate files not found:', err.message);
}

// Demo data generators
const users = ['alice', 'bob', 'charlie', 'diana', 'eve', 'frank', 'grace', 'henry'];
const actions = ['login', 'logout', 'purchase', 'view', 'click', 'scroll', 'search', 'share'];
const products = ['laptop', 'phone', 'tablet', 'headphones', 'keyboard', 'mouse', 'monitor', 'webcam'];
const statuses = ['success', 'pending', 'failed', 'processing'];
const services = ['api-gateway', 'auth-service', 'payment-service', 'inventory', 'notifications', 'analytics'];
const levels = ['info', 'warn', 'error', 'debug'];

function randomItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomNumber(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateUserEvent() {
  return {
    userId: `user-${randomNumber(1000, 9999)}`,
    username: randomItem(users),
    action: randomItem(actions),
    timestamp: new Date().toISOString(),
    metadata: {
      ip: `192.168.${randomNumber(1, 255)}.${randomNumber(1, 255)}`,
      userAgent: 'Mozilla/5.0 Demo Client',
      sessionId: `sess-${randomNumber(10000, 99999)}`
    }
  };
}

function generateOrderEvent() {
  const quantity = randomNumber(1, 5);
  const price = randomNumber(10, 500);
  return {
    orderId: `ORD-${randomNumber(100000, 999999)}`,
    userId: `user-${randomNumber(1000, 9999)}`,
    product: randomItem(products),
    quantity,
    price,
    total: quantity * price,
    currency: 'USD',
    status: randomItem(statuses),
    timestamp: new Date().toISOString()
  };
}

function generateLogEvent() {
  return {
    service: randomItem(services),
    level: randomItem(levels),
    message: `Processing request ${randomNumber(1000, 9999)}`,
    traceId: `trace-${randomNumber(100000, 999999)}`,
    duration: randomNumber(1, 500),
    timestamp: new Date().toISOString()
  };
}

function generateMetricEvent() {
  return {
    service: randomItem(services),
    metric: randomItem(['cpu', 'memory', 'requests', 'latency', 'errors']),
    value: randomNumber(0, 100),
    unit: randomItem(['percent', 'ms', 'count', 'bytes']),
    timestamp: new Date().toISOString()
  };
}

function generateNotification() {
  const types = ['email', 'sms', 'push', 'webhook'];
  return {
    notificationId: `notif-${randomNumber(10000, 99999)}`,
    type: randomItem(types),
    recipient: `${randomItem(users)}@example.com`,
    subject: `Notification about ${randomItem(products)}`,
    status: randomItem(['sent', 'delivered', 'failed', 'queued']),
    timestamp: new Date().toISOString()
  };
}

// JetStream stream configurations
const streamConfigs: any[] = [
  {
    name: 'ORDERS',
    subjects: ['orders.>'],
    description: 'Order processing events',
    maxMsgs: 10000,
    maxAge: 24 * 60 * 60 * 1000000000,
    storage: 'file',
  },
  {
    name: 'USERS',
    subjects: ['users.>'],
    description: 'User activity events',
    maxMsgs: 50000,
    maxAge: 7 * 24 * 60 * 60 * 1000000000,
    storage: 'file',
  },
  {
    name: 'LOGS',
    subjects: ['logs.>'],
    description: 'Application logs',
    maxMsgs: 100000,
    maxAge: 3 * 24 * 60 * 60 * 1000000000,
    storage: 'file',
  },
  {
    name: 'METRICS',
    subjects: ['metrics.>'],
    description: 'System metrics',
    maxMsgs: 200000,
    maxAge: 1 * 24 * 60 * 60 * 1000000000,
    storage: 'memory',
  },
  {
    name: 'NOTIFICATIONS',
    subjects: ['notifications.>'],
    description: 'Notification events',
    retention: 'workqueue',
    maxMsgs: 5000,
    storage: 'file',
  }
];

// JetStream consumer configurations
const consumerConfigs = [
  { stream: 'ORDERS', name: 'order-processor', filterSubject: 'orders.created', description: 'Processes new orders' },
  { stream: 'ORDERS', name: 'order-analytics', filterSubject: 'orders.>', description: 'Analytics on all orders' },
  { stream: 'ORDERS', name: 'payment-handler', filterSubject: 'orders.payment.>', description: 'Handles payments' },
  { stream: 'USERS', name: 'user-tracker', filterSubject: 'users.activity.>', description: 'Tracks user activity' },
  { stream: 'USERS', name: 'auth-monitor', filterSubject: 'users.auth.>', description: 'Monitors authentication' },
  { stream: 'LOGS', name: 'error-alerter', filterSubject: 'logs.error', description: 'Alerts on errors' },
  { stream: 'LOGS', name: 'log-archiver', filterSubject: 'logs.>', description: 'Archives all logs' },
  { stream: 'METRICS', name: 'metrics-aggregator', filterSubject: 'metrics.>', description: 'Aggregates metrics' },
  { stream: 'NOTIFICATIONS', name: 'email-sender', filterSubject: 'notifications.email', description: 'Sends emails' },
  { stream: 'NOTIFICATIONS', name: 'push-sender', filterSubject: 'notifications.push', description: 'Sends push notifications' },
];

async function setupJetStream(js: JetStreamClient) {
  const jsm = await js.jetstreamManager();

  console.log('Setting up JetStream streams...');
  for (const config of streamConfigs) {
    try {
      try {
        await jsm.streams.delete(config.name);
      } catch (e) {
        // Stream doesn't exist
      }

      await jsm.streams.add({
        name: config.name,
        subjects: config.subjects,
        description: config.description,
        retention: config.retention === 'workqueue' ? RetentionPolicy.Workqueue : RetentionPolicy.Limits,
        max_msgs: config.maxMsgs,
        max_age: config.maxAge || 0,
        storage: config.storage === 'memory' ? StorageType.Memory : StorageType.File,
        num_replicas: 1,
        discard: DiscardPolicy.Old,
        duplicate_window: 120000000000,
      });
      console.log(`  Created stream: ${config.name}`);
    } catch (err: any) {
      console.log(`  Stream ${config.name}: ${err.message}`);
    }
  }

  console.log('Setting up JetStream consumers...');
  for (const config of consumerConfigs) {
    try {
      await jsm.consumers.add(config.stream, {
        name: config.name,
        durable_name: config.name,
        description: config.description,
        filter_subject: config.filterSubject,
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.All,
        replay_policy: ReplayPolicy.Instant,
        max_deliver: 3,
        ack_wait: 30000000000,
      });
      console.log(`  Created consumer: ${config.stream}/${config.name}`);
    } catch (err: any) {
      if (!err.message.includes('already exists')) {
        console.log(`  Consumer ${config.stream}/${config.name}: ${err.message}`);
      }
    }
  }

  // Publish initial messages
  console.log('Publishing initial JetStream messages...');

  for (let i = 0; i < 50; i++) {
    const order = generateOrderEvent();
    const subSubject = randomItem(['created', 'updated', 'payment.pending', 'payment.completed', 'shipped', 'delivered']);
    await js.publish(`orders.${subSubject}`, jc.encode(order));
  }

  for (let i = 0; i < 100; i++) {
    const user = generateUserEvent();
    const subSubject = randomItem(['activity.view', 'activity.click', 'activity.search', 'auth.login', 'auth.logout', 'profile.update']);
    await js.publish(`users.${subSubject}`, jc.encode(user));
  }

  for (let i = 0; i < 200; i++) {
    const log = generateLogEvent();
    await js.publish(`logs.${log.level}`, jc.encode(log));
  }

  for (let i = 0; i < 150; i++) {
    const metric = generateMetricEvent();
    await js.publish(`metrics.${metric.service}.${metric.metric}`, jc.encode(metric));
  }

  for (let i = 0; i < 30; i++) {
    const notifType = randomItem(['email', 'push', 'sms', 'webhook']);
    const notif = generateNotification();
    await js.publish(`notifications.${notifType}`, jc.encode(notif));
  }

  console.log('  Published 530 initial messages');

  return jsm;
}

async function main() {
  console.log('Natsable Demo');
  console.log('==============');
  console.log(`URL: ${NATS_URL}`);
  console.log('Auth: Client certificate (user1)');
  console.log('');

  let nc: NatsConnection;
  try {
    nc = await connect({
      servers: NATS_URL,
      ...tlsOptions,
    });
    console.log('Connected to NATS server');
    console.log(`Server: ${nc.getServer()}`);
    console.log('');
  } catch (err: any) {
    console.error('Failed to connect to NATS:', err.message);
    console.log('');
    console.log('Make sure NATS is running: npm run docker:up');
    process.exit(1);
  }

  // Setup JetStream
  const js = nc.jetstream();
  const jsm = await setupJetStream(js);

  console.log('');

  // Set up subscribers for core NATS pub/sub
  const subs: any[] = [];

  const userSub = nc.subscribe('app.users.>');
  subs.push(userSub);
  (async () => {
    for await (const msg of userSub) {
      const data: any = jc.decode(msg.data);
      console.log(`[${msg.subject}] User: ${data.username} - ${data.action}`);
    }
  })();

  const orderSub = nc.subscribe('app.orders.>');
  subs.push(orderSub);
  (async () => {
    for await (const msg of orderSub) {
      const data: any = jc.decode(msg.data);
      console.log(`[${msg.subject}] Order: ${data.orderId} - $${data.total}`);
    }
  })();

  const logSub = nc.subscribe('app.logs.>');
  subs.push(logSub);
  (async () => {
    for await (const msg of logSub) {
      const data: any = jc.decode(msg.data);
      console.log(`[${msg.subject}] ${data.level.toUpperCase()}: ${data.service} - ${data.message}`);
    }
  })();

  const echoSub = nc.subscribe('app.services.echo');
  subs.push(echoSub);
  (async () => {
    for await (const msg of echoSub) {
      const request = sc.decode(msg.data);
      if (msg.reply) {
        msg.respond(sc.encode(`Echo: ${request}`));
      }
    }
  })();

  const timeSub = nc.subscribe('app.services.time');
  subs.push(timeSub);
  (async () => {
    for await (const msg of timeSub) {
      if (msg.reply) {
        msg.respond(jc.encode({ time: new Date().toISOString(), timezone: 'UTC' }));
      }
    }
  })();

  console.log('Starting continuous event publishing...');
  console.log('Press Ctrl+C to stop');
  console.log('');

  let eventCount = 0;
  const intervals: NodeJS.Timeout[] = [];

  // Core NATS pub/sub events
  intervals.push(setInterval(() => {
    const event = generateUserEvent();
    nc.publish(`app.users.${event.action}`, jc.encode(event));
    eventCount++;
  }, 500));

  intervals.push(setInterval(() => {
    const event = generateOrderEvent();
    nc.publish(`app.orders.${event.status}`, jc.encode(event));
    eventCount++;
  }, 2000));

  intervals.push(setInterval(() => {
    const event = generateLogEvent();
    nc.publish(`app.logs.${event.service}.${event.level}`, jc.encode(event));
    eventCount++;
  }, 300));

  // JetStream events
  intervals.push(setInterval(async () => {
    const order = generateOrderEvent();
    const subSubject = randomItem(['created', 'updated', 'payment.pending', 'payment.completed', 'shipped', 'delivered']);
    await js.publish(`orders.${subSubject}`, jc.encode(order));
    eventCount++;
  }, 2000));

  intervals.push(setInterval(async () => {
    const user = generateUserEvent();
    const subSubject = randomItem(['activity.view', 'activity.click', 'activity.search', 'auth.login', 'auth.logout', 'profile.update']);
    await js.publish(`users.${subSubject}`, jc.encode(user));
    eventCount++;
  }, 500));

  intervals.push(setInterval(async () => {
    const log = generateLogEvent();
    await js.publish(`logs.${log.level}`, jc.encode(log));
    eventCount++;
  }, 300));

  intervals.push(setInterval(async () => {
    const metric = generateMetricEvent();
    await js.publish(`metrics.${metric.service}.${metric.metric}`, jc.encode(metric));
    eventCount++;
  }, 1000));

  intervals.push(setInterval(async () => {
    const notifType = randomItem(['email', 'push', 'sms', 'webhook']);
    const notif = generateNotification();
    await js.publish(`notifications.${notifType}`, jc.encode(notif));
    eventCount++;
  }, 5000));

  // Request/reply every 5s
  intervals.push(setInterval(async () => {
    try {
      await nc.request('app.services.echo', sc.encode('Hello NATS!'), { timeout: 1000 });
      await nc.request('app.services.time', sc.encode(''), { timeout: 1000 });
    } catch (err) {
      // Ignore
    }
  }, 5000));

  // Stats display
  const statsInterval = setInterval(async () => {
    console.log('');
    console.log(`--- Stats: ${eventCount} events ---`);
    for (const config of streamConfigs) {
      try {
        const stream = await jsm.streams.info(config.name);
        console.log(`  ${config.name}: ${stream.state.messages} msgs`);
      } catch (e) {
        // ignore
      }
    }
  }, 10000);

  const shutdown = async () => {
    console.log('');
    console.log('Shutting down...');

    intervals.forEach(i => clearInterval(i));
    clearInterval(statsInterval);

    for (const sub of subs) {
      sub.unsubscribe();
    }

    await nc.drain();
    console.log(`Done. Total events: ${eventCount}`);
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(console.error);
