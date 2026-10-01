/**
 * Extract the narration from the pitch reel so there is exactly one source of truth:
 * edit the scene data in agentline-pitch.html and regenerate SCRIPT.md.
 *   npx tsx media/gen-script.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

interface Scene { id: string; dur: number; cues: [number, string][]; detail: string }

const here = dirname(new URL(import.meta.url).pathname);
const html = readFileSync(join(here, 'agentline-pitch.html'), 'utf8');
const start = html.indexOf('const SCENES = [');
const end = html.indexOf('];', html.lastIndexOf("id:'Close'")) + 2;
const SCENES: Scene[] = eval(html.slice(start, end).replace('const SCENES =', ''));

const total = SCENES.reduce((n, s) => n + s.dur, 0);
/** Spoken words are the cue lines; `detail` is reference prose, not read aloud. */
const spoken = (s: Scene) => s.cues.map(([, text]) => text).join(' ');
const words = SCENES.reduce((n, s) => n + spoken(s).split(/\s+/).length, 0);
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

const L: string[] = [];
L.push('# AgentLine — pitch reel narration script', '');
L.push('Written for: whoever records the voiceover.', '');
L.push(`Runtime ${mmss(total)} across ${SCENES.length} scenes · ${words} spoken words · about ${Math.round(words / (total / 60))} words per minute.`, '');
L.push('Every line below is cued to the second it appears on screen, and the on-screen subtitle is');
L.push('that same line — so if you read to the timecodes, the captions match you exactly.', '');
L.push('Open [agentline-pitch.html](agentline-pitch.html), press **Record mode**, then **Space** to play.', '');
L.push('---', '');

let t = 0;
for (const [i, s] of SCENES.entries()) {
  L.push(`## ${String(i + 1).padStart(2, '0')} · ${s.id}`, '');
  L.push(`**${mmss(t)} – ${mmss(t + s.dur)}** · ${s.dur}s`, '');
  // Each line is cued to the second it appears on screen, so the read stays in sync.
  for (const [ct, text] of s.cues) L.push(`\`${mmss(t + ct)}\`  ${text}`, '');
  L.push('<details><summary>Longer form — extra talking points, not read at this pace</summary>', '');
  L.push('', s.detail, '', '</details>', '');
  t += s.dur;
}

L.push('---', '', '## Delivery notes', '');
L.push('- Keep the pace deliberate. The measured figures in scenes 10 and 11 are what a judge will check, so land those cleanly.');
L.push('- Scene 2 is the only place to sound grim. Everything after it is matter-of-fact.');
L.push('- Pronunciation: "four-oh-two" for 402, "P-Q-X-D-H", "H-C-S", "see-eye-dee" for cid, "ed-twenty-five-five-one-nine" for Ed25519.');
L.push('- The closing line is the thesis. Slow down on "an agent can do without it".', '');
L.push('## Producing a video file', '');
L.push('1. Open the reel, click **Record mode** (chrome hides, the stage fills the window).');
L.push('2. Start a screen recording — QuickTime on macOS, or OBS if you want the voiceover on the same pass.');
L.push('3. Press **Space**. The reel runs to the end and stops on the closing card.');
L.push('4. Record the voiceover against it, or narrate live while recording.', '');
L.push('Subtitles are burned into the stage, so the recording carries them without a separate caption track.', '');

writeFileSync(join(here, 'SCRIPT.md'), L.join('\n'));
console.log(`SCRIPT.md written — ${SCENES.length} scenes, ${words} words, ${mmss(total)} runtime`);
