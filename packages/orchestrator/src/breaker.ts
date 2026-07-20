/**
 * Metering + circuit breaker (ADR-4). Wraps every model call: converts token usage
 * to dollars, trips when an agent exceeds its cap OR loops on the same action.
 * This is deterministic middleware — an LLM cannot talk its way past it.
 */
export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface Pricing {
  readonly inputPerMTok: number; // USD per 1M input tokens
  readonly outputPerMTok: number; // USD per 1M output tokens
}

export type TripReason = "budget" | "loop";

export interface BreakerOptions {
  readonly capUsd: number;
  readonly pricing: Pricing;
  /** Trip if the same action signature repeats this many times in a row. */
  readonly loopThreshold?: number;
  readonly onTrip: (reason: TripReason, detail: string) => void;
}

export class CircuitBreaker {
  private spendUsd = 0;
  private tripped = false;
  private lastSig: string | undefined;
  private repeatCount = 0;
  private readonly loopThreshold: number;

  constructor(private readonly opts: BreakerOptions) {
    this.loopThreshold = opts.loopThreshold ?? 8;
  }

  get isTripped(): boolean {
    return this.tripped;
  }

  get spend(): number {
    return this.spendUsd;
  }

  /** Record usage from one model call. Returns false once the breaker has tripped. */
  record(usage: Usage): boolean {
    if (this.tripped) return false;
    const { inputPerMTok, outputPerMTok } = this.opts.pricing;
    this.spendUsd +=
      (usage.inputTokens / 1_000_000) * inputPerMTok +
      (usage.outputTokens / 1_000_000) * outputPerMTok;
    if (this.spendUsd >= this.opts.capUsd) {
      this.trip("budget", `spend $${this.spendUsd.toFixed(2)} ≥ cap $${this.opts.capUsd}`);
      return false;
    }
    return true;
  }

  /** Note an action's signature for doom-loop detection. Returns false if it trips. */
  noteAction(signature: string): boolean {
    if (this.tripped) return false;
    if (signature === this.lastSig) {
      this.repeatCount += 1;
    } else {
      this.lastSig = signature;
      this.repeatCount = 1;
    }
    if (this.repeatCount >= this.loopThreshold) {
      this.trip("loop", `action repeated ${this.repeatCount}×: ${signature}`);
      return false;
    }
    return true;
  }

  private trip(reason: TripReason, detail: string): void {
    this.tripped = true;
    this.opts.onTrip(reason, detail);
  }
}
