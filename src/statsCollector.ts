// Server-side stats collector that maintains 24 hours of historical data
// Data is collected every second and stored in memory

const COLLECTION_INTERVAL = 1000; // 1 second
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const CLEANUP_INTERVAL = 60 * 1000; // Clean old data every minute

interface DataPoint {
  timestamp: number;
  connections: number;
  subscriptions: number;
  msgsIn: number;
  msgsOut: number;
  bytesIn: number;
  bytesOut: number;
  msgsInRate: number;
  msgsOutRate: number;
  bytesInRate: number;
  bytesOutRate: number;
  cpu: number;
  mem: number;
}

interface PrevData {
  timestamp: number;
  msgsIn: number;
  msgsOut: number;
  bytesIn: number;
  bytesOut: number;
}

interface VarzResponse {
  in_msgs: number;
  out_msgs: number;
  in_bytes: number;
  out_bytes: number;
  connections: number;
  subscriptions: number;
  cpu: number;
  mem: number;
}

export class StatsCollector {
  private monitoringUrl: string;
  private dataPoints: DataPoint[];
  private prevData: PrevData | null;
  private collectionTimer: NodeJS.Timeout | null;
  private cleanupTimer: NodeJS.Timeout | null;
  private isRunning: boolean;

  constructor(monitoringUrl: string) {
    this.monitoringUrl = monitoringUrl;
    this.dataPoints = [];
    this.prevData = null;
    this.collectionTimer = null;
    this.cleanupTimer = null;
    this.isRunning = false;
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;

    console.log('Stats collector started');

    // Start collecting immediately
    this.collect();

    // Set up collection interval
    this.collectionTimer = setInterval(
      () => this.collect(),
      COLLECTION_INTERVAL,
    );

    // Set up cleanup interval to remove old data
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL);
  }

  stop() {
    if (!this.isRunning) return;
    this.isRunning = false;

    if (this.collectionTimer) {
      clearInterval(this.collectionTimer);
      this.collectionTimer = null;
    }

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    console.log('Stats collector stopped');
  }

  async collect() {
    try {
      const [varzRes, connzRes] = await Promise.all([
        fetch(`${this.monitoringUrl}/varz`),
        fetch(`${this.monitoringUrl}/connz`),
      ]);

      if (!varzRes.ok || !connzRes.ok) {
        return; // Skip this data point if we can't connect
      }

      const varz = (await varzRes.json()) as VarzResponse;
      // const connz = await connzRes.json(); // Not used currently?

      const now = Date.now();

      // Calculate rates (per second) if we have previous data
      let msgsInRate = 0;
      let msgsOutRate = 0;
      let bytesInRate = 0;
      let bytesOutRate = 0;

      if (this.prevData) {
        const timeDelta = (now - this.prevData.timestamp) / 1000; // seconds
        if (timeDelta > 0 && timeDelta < 5) {
          // Only calculate if within reasonable range
          msgsInRate = Math.max(
            0,
            (varz.in_msgs - this.prevData.msgsIn) / timeDelta,
          );
          msgsOutRate = Math.max(
            0,
            (varz.out_msgs - this.prevData.msgsOut) / timeDelta,
          );
          bytesInRate = Math.max(
            0,
            (varz.in_bytes - this.prevData.bytesIn) / timeDelta,
          );
          bytesOutRate = Math.max(
            0,
            (varz.out_bytes - this.prevData.bytesOut) / timeDelta,
          );
        }
      }

      // Store current values for next rate calculation
      this.prevData = {
        timestamp: now,
        msgsIn: varz.in_msgs,
        msgsOut: varz.out_msgs,
        bytesIn: varz.in_bytes,
        bytesOut: varz.out_bytes,
      };

      // Create data point
      const dataPoint: DataPoint = {
        timestamp: now,
        connections: varz.connections || 0,
        subscriptions: varz.subscriptions || 0,
        msgsIn: varz.in_msgs || 0,
        msgsOut: varz.out_msgs || 0,
        bytesIn: varz.in_bytes || 0,
        bytesOut: varz.out_bytes || 0,
        msgsInRate: Math.round(msgsInRate),
        msgsOutRate: Math.round(msgsOutRate),
        bytesInRate: Math.round(bytesInRate),
        bytesOutRate: Math.round(bytesOutRate),
        cpu: varz.cpu || 0,
        mem: varz.mem || 0,
      };

      this.dataPoints.push(dataPoint);
    } catch (error) {
      // Silently ignore collection errors - NATS might not be available yet
    }
  }

  cleanup() {
    const cutoff = Date.now() - MAX_AGE_MS;
    const beforeCount = this.dataPoints.length;
    this.dataPoints = this.dataPoints.filter((dp) => dp.timestamp >= cutoff);
    const removed = beforeCount - this.dataPoints.length;
    if (removed > 0) {
      console.log(`Stats collector: removed ${removed} old data points`);
    }
  }

  // Get historical data, optionally limited to last N seconds
  getHistory(maxSeconds: number | null = null) {
    if (!maxSeconds) {
      return this.dataPoints;
    }

    const cutoff = Date.now() - maxSeconds * 1000;
    return this.dataPoints.filter((dp) => dp.timestamp >= cutoff);
  }

  // Get summary statistics
  getSummary() {
    return {
      dataPoints: this.dataPoints.length,
      oldestTimestamp:
        this.dataPoints.length > 0 ? this.dataPoints[0].timestamp : null,
      newestTimestamp:
        this.dataPoints.length > 0
          ? this.dataPoints[this.dataPoints.length - 1].timestamp
          : null,
      isRunning: this.isRunning,
    };
  }
}

export function createStatsCollector(monitoringUrl: string) {
  return new StatsCollector(monitoringUrl);
}
