import 'reflect-metadata';

import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import { HealthCheckManager } from '../HealthCheckManager';
import { type HealthCheckable, type HealthCheckResult, HealthStatus } from '../types';

const INTERVAL = 300_000;

class FakeService implements HealthCheckable {
  probes = 0;
  status = HealthStatus.UNHEALTHY;
  constructor(private readonly name: string) {}
  getServiceName(): string {
    return this.name;
  }
  async checkHealth(): Promise<HealthCheckResult> {
    this.probes++;
    return { status: this.status, timestamp: Date.now() };
  }
}

async function advance(ms: number): Promise<void> {
  jest.advanceTimersByTime(ms);
  // Let the forced probe's promise chain settle (setImmediate stays real).
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('HealthCheckManager recovery probe', () => {
  let manager: HealthCheckManager;
  let service: FakeService;

  beforeEach(() => {
    jest.useFakeTimers();
    manager = new HealthCheckManager();
    service = new FakeService('svc');
    manager.registerService(service, { recoveryInterval: INTERVAL, cacheDuration: 60_000 });
  });

  afterEach(() => {
    manager.shutdown();
    jest.useRealTimers();
  });

  it('re-probes an unhealthy service, keeps re-scheduling while it fails, and stops once healthy', async () => {
    await manager.checkHealth('svc');
    expect(service.probes).toBe(1);
    expect(manager.isServiceHealthySync('svc')).toBe(false);

    await advance(INTERVAL);
    expect(service.probes).toBe(2);
    expect(manager.isServiceHealthySync('svc')).toBe(false);

    service.status = HealthStatus.HEALTHY;
    await advance(INTERVAL);
    expect(service.probes).toBe(3);
    expect(manager.isServiceHealthySync('svc')).toBe(true);

    await advance(INTERVAL * 3);
    expect(service.probes).toBe(3);
  });

  it('keeps a single pending timer per service', async () => {
    await manager.checkHealth('svc', { force: true });
    await manager.checkHealth('svc', { force: true });
    expect(service.probes).toBe(2);

    await advance(INTERVAL);
    expect(service.probes).toBe(3);
  });

  it('schedules recovery when markServiceUnhealthy reaches the threshold', async () => {
    service.status = HealthStatus.HEALTHY;
    manager.markServiceUnhealthy('svc');
    await advance(INTERVAL);
    expect(service.probes).toBe(0);

    manager.markServiceUnhealthy('svc');
    expect(manager.isServiceHealthySync('svc')).toBe(false);
    await advance(INTERVAL);
    expect(service.probes).toBe(1);
    expect(manager.isServiceHealthySync('svc')).toBe(true);
  });

  it('cancels the pending probe on markServiceHealthy, resetService and unregisterService', async () => {
    await manager.checkHealth('svc');
    manager.markServiceHealthy('svc');
    await advance(INTERVAL);
    expect(service.probes).toBe(1);

    await manager.checkHealth('svc', { force: true });
    manager.resetService('svc');
    await advance(INTERVAL);
    expect(service.probes).toBe(2);

    await manager.checkHealth('svc', { force: true });
    manager.unregisterService('svc');
    await advance(INTERVAL);
    expect(service.probes).toBe(3);
  });

  it('does not schedule anything without a recovery interval', async () => {
    const plain = new FakeService('plain');
    manager.registerService(plain);
    await manager.checkHealth('plain');
    await advance(INTERVAL * 2);
    expect(plain.probes).toBe(1);
  });

  it('cancels pending probes on shutdown', async () => {
    await manager.checkHealth('svc');
    manager.shutdown();
    await advance(INTERVAL);
    expect(service.probes).toBe(1);
  });
});
