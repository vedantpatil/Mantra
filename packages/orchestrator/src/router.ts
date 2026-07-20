import {
  type Intent,
  type IntentSource,
  type Result,
  Err,
  Ok,
  requiresTargetConfirm,
} from "@mantra/core";

/**
 * The intent router (ADR-7). Voice and console both arrive here as raw text; a
 * parser resolves them to the SAME typed Intent, and irreversible intents get an
 * explicit target preview + confirm before they are allowed downstream.
 */
export interface IntentParser {
  /** Constrained tool-use against a fixed JSON schema (impl provided in a later phase). */
  parse(raw: string, source: IntentSource): Promise<Intent>;
}

export interface TargetConfirmer {
  /** Show the resolved target ("Deploy CareerFlint to prod?") and await a decision. */
  confirmTarget(intent: Intent): Promise<boolean>;
}

export class Router {
  constructor(
    private readonly parser: IntentParser,
    private readonly confirmer: TargetConfirmer,
  ) {}

  async route(raw: string, source: IntentSource): Promise<Result<Intent>> {
    const intent = await this.parser.parse(raw, source);
    if (requiresTargetConfirm(intent)) {
      const approved = await this.confirmer.confirmTarget(intent);
      if (!approved) return Err(new Error(`target not confirmed for "${intent.verb}"`));
    }
    return Ok(intent);
  }
}
