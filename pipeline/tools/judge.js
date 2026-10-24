export const meta = {
  name: 'scene-judge',
  description: 'Independent judges score each reconstructed scene against its video (grid + metrics), then a skeptic re-checks failures',
  phases: [{ title: 'Judge', detail: 'one judge per clip' }, { title: 'Verify', detail: 'skeptic re-checks each verdict' }, { title: 'Synthesize' }],
}

const CLIPS = args.clips  // [{id, title, grid, metrics, gaps, notes, shots:[{t, inGap}]}]
const RUBRIC = `
You are an independent judge. The question: from the recorded camera (same position, direction and field of view as
the video), does the reconstructed 3D scene "very largely match what we see in the video"?

You get a comparison grid image (rows = moments in time; columns = original video frame | render from the same camera |
amplified absolute difference) and metrics (PSNR/SSIM/colour-histogram match, whole frame and centre third).
Read the grid image with the Read tool and look carefully at every row.

Score each 1-5 (5 = indistinguishable at a glance, 4 = clearly the same scene with small blur or colour shifts,
3 = recognisable but with obvious errors in parts, 2 = only partly recognisable, 1 = unrelated/garbage):
  layout   - geometry and layout: same walls, floor, furniture, in the same places and sizes
  colour   - colours and lighting
  dynamic  - moving things (people, props): present where the video has them, absent where it doesn't
For rows marked "tracking lost" the pipeline knows the recording is unreliable there (the viewer fades those stretches
out); score them separately and do NOT count them against the main verdict, but say whether the fade is justified.
List every concrete defect you see with its row time and a plain description (e.g. "22 s: left half is smeared
blobs"). Say which defects look fixable in the pipeline (e.g. pruning, colour, alignment) versus inherent to the footage.
Verdict: largely_matches = true only if the non-lost rows average >= 3.5 on layout and >= 3 on colour, with no row
below 2 on layout. Be strict and specific; do not be generous.`

const SCORE = { type: 'object', properties: {
  layout: { type: 'number' }, colour: { type: 'number' }, dynamic: { type: 'number' },
  lost_rows_score: { type: 'number' }, fade_justified: { type: 'boolean' },
  largely_matches: { type: 'boolean' },
  defects: { type: 'array', items: { type: 'object', properties: { t: { type: 'number' }, what: { type: 'string' }, fixable: { type: 'string' } }, required: ['t', 'what', 'fixable'] } },
  summary: { type: 'string' } }, required: ['layout', 'colour', 'dynamic', 'lost_rows_score', 'fade_justified', 'largely_matches', 'defects', 'summary'] }

const VERDICT = { type: 'object', properties: { agree: { type: 'boolean' }, reason: { type: 'string' }, corrected: SCORE }, required: ['agree', 'reason'] }

const judged = await pipeline(CLIPS,
  c => agent(`${RUBRIC}\nClip: ${c.id} "${c.title}". ${c.notes}\nRows marked tracking lost: ${c.shots.filter(s => s.inGap).map(s => s.t + ' s').join(', ') || 'none'}.\nGrid image: ${c.grid}\nMetrics JSON: ${c.metrics} (read it with Read).`,
    { label: `judge:${c.id}`, phase: 'Judge', schema: SCORE, model: 'opus' }),
  (score, c) => score ? agent(`${RUBRIC}\nA first judge scored clip ${c.id} "${c.title}" as follows: ${JSON.stringify(score)}.
Independently look at the same grid (${c.grid}) and metrics (${c.metrics}) and decide whether you AGREE with the verdict and scores.
If you disagree, give your corrected full score object. Be the skeptic: catch generosity and catch unfair harshness equally.`,
    { label: `verify:${c.id}`, phase: 'Verify', schema: VERDICT, model: 'opus' }).then(v => ({ id: c.id, title: c.title, first: score, check: v })) : null)

const results = judged.filter(Boolean)
phase('Synthesize')
const report = await agent(`Write a short, plain-English judging report (markdown, <= 350 words) for a hackathon team from these per-clip
judgements of their video -> 3D scene pipeline. For each clip one line with the final scores (use the skeptic's corrected
scores where they disagreed), then the 3-5 most important defects across clips grouped as "fixable in the pipeline" vs
"inherent to the footage", then an overall verdict on whether the scenes largely match the videos from the recorded camera.
Data: ${JSON.stringify(results)}`, { label: 'report', phase: 'Synthesize', model: 'opus' })
return { results, report }
