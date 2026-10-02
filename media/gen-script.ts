/**
 * Extract the narration from the pitch film so there is one source of truth: edit the
 * scene data in agentegram-pitch.html and regenerate.
 *   npx tsx media/gen-script.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

interface Scene { id: string; act: string; dur: number; three?: string; cues: [number, string][] }

const here = dirname(new URL(import.meta.url).pathname);
const html = readFileSync(join(here, 'agentegram-pitch.html'), 'utf8');
const start = html.indexOf('const SCENES = [');
const end = html.indexOf('];', html.lastIndexOf("id:'Close'")) + 2;
const SCENES: Scene[] = eval(html.slice(start, end).replace('const SCENES =', ''));

const total = SCENES.reduce((n, s) => n + s.dur, 0);
const words = SCENES.reduce((n, s) => n + s.cues.map(([, t]) => t).join(' ').split(/\s+/).length, 0);
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

const L: string[] = [
  '# Agentegram — pitch film narration', '',
  'Written for: whoever records the voiceover.', '',
  `Runtime ${mmss(total)} across ${SCENES.length} scenes · ${words} spoken words · about ${Math.round(words / (total / 60))} words per minute.`, '',
  'Every line is cued to the second it appears on screen, and the subtitle is that same line,',
  'so reading to the timecodes keeps voice and captions in sync.', '',
  'Open agentegram-pitch.html, press **Record** (the stage fills the window), then **Space**.', '',
];
let t = 0, act = '';
for (const [i, s] of SCENES.entries()) {
  if (s.act !== act) { L.push('---', '', `## ${s.act}`, ''); act = s.act; }
  L.push(`### ${String(i).padStart(2, '0')} · ${s.id}${s.three ? '  ·  3D' : ''}`, '', `**${mmss(t)} – ${mmss(t + s.dur)}** · ${s.dur}s`, '');
  for (const [ct, text] of s.cues) L.push(`\`${mmss(t + ct)}\`  ${text}`, '');
  t += s.dur;
}
L.push('---', '', '## Delivery notes', '',
  '- The opening two scenes carry the only outside figures; they are attributed on screen. Land the numbers slowly.',
  '- Scenes 02–05 are the 3D problem: let the animation breathe between lines rather than filling every second.',
  '- Scene 07 (“Take the server away”) is the thesis shot. Pause after “The channel stays.”',
  '- Pronunciation: “four-oh-two” for 402, “P-Q-X-D-H”, “H-C-S”, “x-four-oh-two” for x402.',
  '', '## Producing the file', '',
  '1. Open the film and press **Record**: controls hide and the stage fills the window.',
  '2. Start a screen recording (QuickTime, or OBS to capture voiceover in the same pass).',
  '3. Press **Space**. It plays to the closing card and stops.',
  '', 'Subtitles are part of the stage, so the recording carries them without a caption track.', '');
writeFileSync(join(here, 'SCRIPT.md'), L.join('\n'));
console.log(`SCRIPT.md — ${SCENES.length} scenes, ${words} words, ${mmss(total)}, ${Math.round(words / (total / 60))} wpm`);
