import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Speech-to-text (P5). Voice is an equal peer of the console (§5.7): a spoken utterance is
 * transcribed, then normalized into the SAME `<verb> <target>: <text>` grammar the console
 * parses — so voice and typing converge on one intent path. The Transcriber is injected, so
 * the pipeline is testable with a fake and driven live by a local whisper.cpp binary (no
 * cloud STT — audio never leaves the machine).
 */

export interface TranscriptResult {
  readonly text: string;
  readonly confidence?: number;
}

export interface Transcriber {
  /** Transcribe a WAV file (16 kHz mono is ideal for whisper.cpp). */
  transcribe(wavPath: string): Promise<TranscriptResult>;
}

/** Deterministic transcriber for tests — returns scripted text regardless of input. */
export class FakeTranscriber implements Transcriber {
  constructor(private readonly script: string, private readonly confidence = 1) {}
  async transcribe(_wavPath: string): Promise<TranscriptResult> {
    return { text: this.script, confidence: this.confidence };
  }
}

/**
 * Local whisper.cpp transcriber. Runs the whisper.cpp CLI over a WAV file with timestamps
 * off, so stdout is plain text. Binary + model come from opts or `MANTRA_WHISPER_BIN` /
 * `MANTRA_WHISPER_MODEL`. Not exercised offline (needs the binary + a model file).
 */
export class WhisperCppTranscriber implements Transcriber {
  private readonly binary: string;
  private readonly model?: string;

  constructor(opts?: { binary?: string; model?: string }) {
    this.binary = opts?.binary ?? process.env.MANTRA_WHISPER_BIN ?? "whisper-cli";
    this.model = opts?.model ?? process.env.MANTRA_WHISPER_MODEL;
  }

  async transcribe(wavPath: string): Promise<TranscriptResult> {
    if (!this.model) throw new Error("no whisper model — set MANTRA_WHISPER_MODEL or pass { model }");
    if (!existsSync(wavPath)) throw new Error(`audio file not found: ${wavPath}`);
    const out = execFileSync(this.binary, ["-m", this.model, "-f", wavPath, "-nt", "-l", "auto"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    // Strip any stray [hh:mm:ss] timestamps and collapse whitespace defensively.
    const text = out.replace(/\[[\d:.\s\->]+\]/g, "").replace(/\s+/g, " ").trim();
    return { text };
  }
}

const FILLER = /^(?:(?:hey|ok|okay|um|uh|so)\s+)*(?:mantra[,]?\s+)?/i;
const COLON_WORDS = /\s+(?:colon|colin|semicolon|semi-colon)\s+/gi;
const VERBS_NEEDING_TARGET = new Set(["run", "run!", "crew", "ship"]);

/**
 * Normalize a raw voice transcript into the console command grammar `<verb> <target>: <text>`.
 * Deterministic + pure, so it's fully unit-tested. Handles a leading wake/filler phrase, the
 * spoken word "colon", "run bang" → "run!", and — when no colon was spoken — inserting one
 * after the target for verbs that need it. Non-command speech is returned cleaned but intact.
 */
export function normalizeVoiceCommand(raw: string): string {
  let s = raw.trim().replace(FILLER, "").trim();
  if (!s) return "";
  // "run bang <target> …" → "run! <target> …"
  s = s.replace(/^run\s+bang\b/i, "run!");
  // spoken "colon" → ":"; also a trailing "… colon"
  s = s.replace(COLON_WORDS, ": ").replace(/\s+(?:colon|colin|semicolon)\s*$/i, ":");
  s = s.replace(/\s+/g, " ").replace(/[.?!]+$/g, "").trim();

  const words = s.split(" ");
  const verb = words[0]?.toLowerCase();
  if (verb && VERBS_NEEDING_TARGET.has(verb) && !s.includes(":") && words.length >= 3) {
    // No colon was spoken: treat the second word as the target, the rest as the task.
    s = `${words[0]} ${words[1]}: ${words.slice(2).join(" ")}`;
  }
  return s.trim();
}
