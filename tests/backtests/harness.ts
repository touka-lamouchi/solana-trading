/**
 * harness.ts — minimal, reusable backtest framework.
 *
 * A backtest here is: replay a time-ordered series of market snapshots through
 * a pure strategy function, collect the decisions it would have made, and
 * summarize the outcome. No chain, no Redis, no execution — we measure what the
 * strategy *would* have detected/sized, using the same pure code the live bot
 * runs (findRankedCycles, simulateCycle, optimal_sizer).
 *
 * Keeping it dependency-free (just console) matches the existing test style and
 * lets it run under ts-node with no setup.
 */

export interface BacktestStep<Snapshot, Decision> {
  snapshot: Snapshot;
  decisions: Decision[];
}

export interface BacktestResult<Decision> {
  name: string;
  steps: number;
  decisions: Decision[];
  // Aggregates filled by the caller-supplied summarize fn.
  summary: Record<string, number | string>;
}

export class Backtest<Snapshot, Decision> {
  private steps: BacktestStep<Snapshot, Decision>[] = [];

  constructor(
    private readonly name: string,
    private readonly strategy: (snapshot: Snapshot, index: number) => Decision[],
  ) {}

  /** Feed one snapshot; record whatever decisions the strategy emits. */
  step(snapshot: Snapshot, index: number): Decision[] {
    const decisions = this.strategy(snapshot, index);
    this.steps.push({ snapshot, decisions });
    return decisions;
  }

  run(series: Snapshot[]): BacktestStep<Snapshot, Decision>[] {
    series.forEach((s, i) => this.step(s, i));
    return this.steps;
  }

  allDecisions(): Decision[] {
    return this.steps.flatMap((s) => s.decisions);
  }

  result(summary: Record<string, number | string>): BacktestResult<Decision> {
    return {
      name: this.name,
      steps: this.steps.length,
      decisions: this.allDecisions(),
      summary,
    };
  }
}

export function printResult(r: BacktestResult<unknown>): void {
  console.log(`\n── Backtest: ${r.name} ──`);
  console.log(`  steps:     ${r.steps}`);
  console.log(`  decisions: ${r.decisions.length}`);
  for (const [k, v] of Object.entries(r.summary)) {
    console.log(`  ${k.padEnd(22)} ${v}`);
  }
}
