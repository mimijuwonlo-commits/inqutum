#!/usr/bin/env tsx
/**
 * Synthetic Journey Monitor runner.
 *
 * Usage:
 *   npm run journey:monitor
 *   npm run journey:monitor -- --json
 *   npm run journey:monitor -- --check --retries 2 --sla-ms 1500
 */

import {
  SyntheticJourneyMonitor,
  formatSyntheticJourneyReport,
  type SyntheticJourneyReport,
} from '../backend/src/ops/synthetic-journey-monitor';

const MAX_RETRIES = 5;

export interface SyntheticJourneyCliArguments {
  json: boolean;
  check: boolean;
  help: boolean;
  retries: number;
  slaThresholdMs?: number;
}

export const SYNTHETIC_JOURNEY_CLI_USAGE = [
  'Usage: npm run journey:monitor -- [options]',
  '',
  'Options:',
  '  --json          Print machine-readable JSON.',
  '  --check         Exit with code 1 on journey failure or SLA breach.',
  '  --retries N     Retry transient failures N times (0-' + MAX_RETRIES + ').',
  '  --sla-ms N      Mark the journey as breaching an SLA above N milliseconds.',
  '  --help          Show this help text.',
  '',
  'Exit codes: 0 = report is acceptable (or --check was not requested),',
  '            1 = monitor failed, 2 = invalid command-line arguments.',
].join(String.fromCharCode(10));

function parseNonNegativeInteger(value: string | undefined, option: string): number {
  if (value === undefined || !/^(0|[1-9]\\d*)$/.test(value)) {
    throw new Error(`${option} requires a non-negative integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${option} must be a safe integer.`);
  return parsed;
}

export function parseSyntheticJourneyCliArguments(args: readonly string[]): SyntheticJourneyCliArguments {
  const parsed: SyntheticJourneyCliArguments = { json: false, check: false, help: false, retries: 0 };
  const seen = new Set<string>();

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (seen.has(arg)) throw new Error(`Duplicate option: ${arg}`);
    seen.add(arg);

    switch (arg) {
      case '--json':
        parsed.json = true;
        break;
      case '--check':
        parsed.check = true;
        break;
      case '--help':
      case '-h':
        parsed.help = true;
        break;
      case '--retries': {
        const count = parseNonNegativeInteger(args[++index], '--retries');
        if (count > MAX_RETRIES) throw new Error(`--retries cannot exceed ${MAX_RETRIES}.`);
        parsed.retries = count;
        break;
      }
      case '--sla-ms': {
        const threshold = parseNonNegativeInteger(args[++index], '--sla-ms');
        if (threshold === 0) throw new Error('--sla-ms must be greater than zero.');
        parsed.slaThresholdMs = threshold;
        break;
      }
      default:
        throw new Error(`Unknown synthetic monitor option: ${arg}`);
    }
  }

  return parsed;
}

export interface SyntheticJourneyCliIO {
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
}

/** Runs the CLI through the monitor's bounded retry/history path. */
export async function runSyntheticJourneyCli(
  args: readonly string[] = process.argv.slice(2),
  monitor: Pick<SyntheticJourneyMonitor, 'runJourneyWithRetry'> = new SyntheticJourneyMonitor(),
  io: SyntheticJourneyCliIO = {}
): Promise<number> {
  const stdout = io.stdout ?? ((message: string) => console.log(message));
  const stderr = io.stderr ?? ((message: string) => console.error(message));

  let parsed: SyntheticJourneyCliArguments;
  try {
    parsed = parseSyntheticJourneyCliArguments(args);
  } catch (error) {
    stderr(`${error instanceof Error ? error.message : String(error)}${String.fromCharCode(10)}${SYNTHETIC_JOURNEY_CLI_USAGE}`);
    return 2;
  }

  if (parsed.help) {
    stdout(SYNTHETIC_JOURNEY_CLI_USAGE);
    return 0;
  }

  try {
    const report: SyntheticJourneyReport = await monitor.runJourneyWithRetry({
      maxRetries: parsed.retries,
      ...(parsed.slaThresholdMs === undefined ? {} : { slaThresholdMs: parsed.slaThresholdMs }),
    });
    stdout(parsed.json ? JSON.stringify(report, null, 2) : formatSyntheticJourneyReport(report));
    return parsed.check && (!report.success || report.slaBreached === true) ? 1 : 0;
  } catch (error) {
    stderr(`Synthetic journey monitor fatal error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

// Avoid running the monitor when imported by the test suite.
if (require.main === module || process.argv[1]?.endsWith('synthetic-journey-monitor.ts')) {
  void runSyntheticJourneyCli().then((code) => {
    process.exitCode = code;
  });
}
