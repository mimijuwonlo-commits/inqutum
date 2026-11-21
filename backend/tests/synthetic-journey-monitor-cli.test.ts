import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  parseSyntheticJourneyCliArguments,
  runSyntheticJourneyCli,
} from '../../scripts/synthetic-journey-monitor';
import type { SyntheticJourneyReport } from '../src/ops/synthetic-journey-monitor';

const successReport: SyntheticJourneyReport = {
  journeyId: 'journey-test',
  timestamp: '2026-11-21T12:00:00.000Z',
  success: true,
  totalLatencyMs: 12,
  attempts: 2,
  slaBreached: false,
  steps: [],
};

describe('Synthetic journey monitor CLI (#489)', () => {
  it('parses JSON, check, bounded retry and SLA options', () => {
    assert.deepEqual(parseSyntheticJourneyCliArguments([
      '--json', '--check', '--retries', '3', '--sla-ms', '1500',
    ]), {
      json: true,
      check: true,
      help: false,
      retries: 3,
      slaThresholdMs: 1500,
    });
  });

  it('rejects malformed, missing, duplicate and unbounded retry values', () => {
    assert.throws(() => parseSyntheticJourneyCliArguments(['--retries']), /requires a non-negative integer/);
    assert.throws(() => parseSyntheticJourneyCliArguments(['--retries', '1.5']), /requires a non-negative integer/);
    assert.throws(() => parseSyntheticJourneyCliArguments(['--retries', '6']), /cannot exceed/);
    assert.throws(() => parseSyntheticJourneyCliArguments(['--json', '--json']), /Duplicate option/);
    assert.throws(() => parseSyntheticJourneyCliArguments(['--unknown']), /Unknown synthetic monitor option/);
  });

  it('delegates once to the built-in retry method and emits machine-readable attempt data', async () => {
    const calls: unknown[] = [];
    const output: string[] = [];
    const errors: string[] = [];
    const monitor = {
      async runJourneyWithRetry(options: unknown) {
        calls.push(options);
        return successReport;
      },
    };

    const exitCode = await runSyntheticJourneyCli(
      ['--json', '--retries', '2', '--sla-ms', '1000'],
      monitor as any,
      { stdout: (message) => output.push(message), stderr: (message) => errors.push(message) }
    );

    assert.equal(exitCode, 0);
    assert.deepEqual(calls, [{ maxRetries: 2, slaThresholdMs: 1000 }]);
    const report = JSON.parse(output[0] ?? '');
    assert.equal(report.attempts, 2);
    assert.equal(report.slaBreached, false);
    assert.equal(errors.length, 0);
  });

  it('fails check mode when the journey fails or breaches its SLA', async () => {
    const failedMonitor = {
      async runJourneyWithRetry() { return { ...successReport, success: false }; },
    };
    const slowMonitor = {
      async runJourneyWithRetry() { return { ...successReport, slaBreached: true }; },
    };

    const failed = await runSyntheticJourneyCli(['--check'], failedMonitor as any, { stdout: () => undefined, stderr: () => undefined });
    const breached = await runSyntheticJourneyCli(['--check'], slowMonitor as any, { stdout: () => undefined, stderr: () => undefined });
    assert.equal(failed, 1);
    assert.equal(breached, 1);
  });

  it('shows help without executing the journey', async () => {
    const output: string[] = [];
    const monitor = {
      async runJourneyWithRetry() { throw new Error('must not run'); },
    };
    const code = await runSyntheticJourneyCli(['--help'], monitor as any, {
      stdout: (message) => output.push(message),
      stderr: () => undefined,
    });
    assert.equal(code, 0);
    assert.match(output[0] ?? '', /Usage: npm run journey:monitor/);
  });
});
