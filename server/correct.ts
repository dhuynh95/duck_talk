/**
 * One fast text call that fixes what the ears misheard, using the pairs the user
 * taught in review mode as few-shot examples.
 *
 * Costs nothing until it has been taught something: with no corrections there is no
 * call at all, so the feature adds zero latency and zero chance of a hallucinated
 * "fix" until a real edit exists. That is the lesson from the web app's version,
 * which called an LLM on every turn and rewrote instructions nobody asked it to.
 *
 *   node correct.ts "what is the latest complete"     print the correction and its cost
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI } from '@google/genai';
import { load, render, type Correction } from './corrections.ts';
import { packaged } from './paths.ts';

// Ships with the relay and is not editable from the phone: unlike the voice and
// Claude prompts, this one is not a preference, it is what makes the model rewrite
// instead of answer.
const PROMPT = readFileSync(packaged('./prompts/correct.md'), 'utf8');
export const CORRECT_MODEL = process.env['CORRECT_MODEL'] ?? 'gemini-2.5-flash-lite';

/** The instruction as the user meant it. Returns `text` unchanged if nothing is known or the call fails. */
export async function correct(
  ai: GoogleGenAI,
  model: string,
  text: string,
  corrections: Correction[],
  log: (m: string) => void = () => {},
): Promise<string> {
  if (!corrections.length || !text.trim()) return text;
  try {
    const res = await ai.models.generateContent({
      model,
      contents: text,
      config: { systemInstruction: PROMPT + render(corrections), temperature: 0 },
    });
    const out = res.text?.trim();
    return out || text;
  } catch (e) {
    log(`correct failed, using what was heard: ${e}`);
    return text;
  }
}

// --- CLI: run alone ---------------------------------------------------------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const text = process.argv.slice(2).join(' ');
  if (!text) { console.error('usage: node correct.ts "what is the latest complete"'); process.exit(1); }
  const corrections = load();
  const ai = new GoogleGenAI({ apiKey: process.env['GEMINI_API_KEY'] });
  const t0 = performance.now();
  const out = await correct(ai, CORRECT_MODEL, text, corrections, console.error);
  console.log(JSON.stringify({
    model: CORRECT_MODEL,
    corrections: corrections.length,
    in: text,
    out,
    changed: out !== text,
    ms: Math.round(performance.now() - t0),
  }, null, 2));
}
