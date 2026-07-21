import { resolve } from "node:path";
import { WhisperCppTranscriber, normalizeVoiceCommand } from "@mantra/orchestrator";

/**
 * Transcribe a WAV file with local whisper.cpp and show both the raw transcript and the
 * normalized console command — the same pipeline the desktop push-to-talk uses. Needs a
 * whisper binary + model (MANTRA_WHISPER_BIN / MANTRA_WHISPER_MODEL, or --model).
 */
export async function transcribeCommand(fileArg: string): Promise<number> {
  const wav = resolve(fileArg);
  try {
    const { text } = await new WhisperCppTranscriber().transcribe(wav);
    const command = normalizeVoiceCommand(text);
    console.log(`\n▸ transcript: ${text}`);
    console.log(`▸ command:    ${command}`);
    return 0;
  } catch (e) {
    console.error(`\n✗ ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
