import { describe, expect, test } from 'bun:test';
import { PreviewServer } from './PreviewServer';
import type { TunableSection } from './types';

const FIXED_SECTIONS: TunableSection[] = [
  {
    id: 'layer:ambient-audio',
    label: 'Ambient Audio',
    params: [
      {
        id: 'silenceFloor',
        label: 'Silence Floor',
        min: 0,
        max: 1,
        step: 0.01,
        value: 0.1,
        default: 0.1,
      },
    ],
  },
  {
    id: 'compiler:spring-damper',
    label: 'Spring Damper',
    params: [
      {
        id: 'body.z.omega',
        label: 'body.z omega',
        min: 0.1,
        max: 50,
        step: 0.1,
        value: 10,
        default: 10,
      },
    ],
  },
];

// Uses a hardcoded high port to avoid needing to access the private `server`
// property just to discover the bound port after Bun binds an ephemeral port 0.
const TEST_PORT = 48777;

describe('PreviewServer tunable WS handlers', () => {
  // ---------------------------------------------------------------------------
  // Test a — tunable-params round-trip
  // ---------------------------------------------------------------------------
  test('tunable-params-request returns the fixed section payload to the requesting socket', async () => {
    const server = new PreviewServer(
      { port: TEST_PORT },
      {
        onTunableParamsRequest: () => FIXED_SECTIONS,
      },
    );

    await server.start();

    const received = await new Promise<{ type: string; data: { sections: TunableSection[] } }>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${TEST_PORT}/`);
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'tunable-params-request' }));
      };
      ws.onmessage = (event) => {
        try {
          resolve(JSON.parse(event.data as string));
        } catch {
          reject(new Error('Failed to parse message'));
        }
        ws.close();
      };
      ws.onerror = () => {
        reject(new Error('WebSocket error'));
      };
    });

    expect(received.type).toBe('tunable-params');
    expect(received.data.sections).toEqual(FIXED_SECTIONS);

    await server.stop();
  });

  // ---------------------------------------------------------------------------
  // Test b — tunable-param-set forwarded to handler
  // ---------------------------------------------------------------------------
  test('tunable-param-set fires the handler with correct args', async () => {
    const recorded: { sectionId: string; paramId: string; value: number }[] = [];
    const server = new PreviewServer(
      { port: TEST_PORT + 1 },
      {
        onTunableParamSet: (data) => recorded.push(data),
      },
    );

    await server.start();

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${TEST_PORT + 1}/`);
      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            type: 'tunable-param-set',
            data: { sectionId: 'layer:ambient-audio', paramId: 'bodyZMax', value: 1.5 },
          }),
        );
        // Wait for server to dispatch, then close
        setTimeout(() => {
          ws.close();
          resolve();
        }, 50);
      };
      ws.onerror = () => {
        reject(new Error('WebSocket error'));
      };
    });

    expect(recorded).toEqual([{ sectionId: 'layer:ambient-audio', paramId: 'bodyZMax', value: 1.5 }]);
    await server.stop();
  });

  // ---------------------------------------------------------------------------
  // Test c — invalid payloads dropped silently
  // ---------------------------------------------------------------------------
  test('tunable-param-set drops invalid payloads without calling handler', async () => {
    const recorded: { sectionId: string; paramId: string; value: number }[] = [];
    const server = new PreviewServer(
      { port: TEST_PORT + 2 },
      {
        onTunableParamSet: (data) => recorded.push(data),
      },
    );

    await server.start();

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${TEST_PORT + 2}/`);
      ws.onopen = () => {
        // Send all invalid payloads followed by one valid payload
        ws.send(JSON.stringify({ type: 'tunable-param-set' })); // missing data
        ws.send(JSON.stringify({ type: 'tunable-param-set', data: { sectionId: 'x', paramId: 'y' } })); // missing value
        ws.send(JSON.stringify({ type: 'tunable-param-set', data: { sectionId: 'x', paramId: 'y', value: 'abc' } })); // non-number
        ws.send(
          JSON.stringify({
            type: 'tunable-param-set',
            data: { sectionId: 'x', paramId: 'y', value: Number.NaN },
          }),
        ); // NaN
        // Valid one — should be the only one recorded
        ws.send(
          JSON.stringify({
            type: 'tunable-param-set',
            data: { sectionId: 'layer:ambient-audio', paramId: 'bodyZMax', value: 2.0 },
          }),
        );
        setTimeout(() => {
          ws.close();
          resolve();
        }, 100);
      };
      ws.onerror = () => {
        reject(new Error('WebSocket error'));
      };
    });

    // Only the valid payload should have reached the handler
    expect(recorded).toEqual([{ sectionId: 'layer:ambient-audio', paramId: 'bodyZMax', value: 2.0 }]);
    await server.stop();
  });
});
