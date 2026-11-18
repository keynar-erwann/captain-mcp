import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { registerCaptainTools } from '../dist/tools.js';
import { runWithConfig } from '../dist/captainClient.js';

function handlers() {
  const map = new Map();
  registerCaptainTools({ registerTool: (name, definition, handler) => map.set(name, { definition, handler }) });
  return map;
}
const call = (name, args) => runWithConfig({ apiKey: 'synthetic' }, () => handlers().get(name).handler(args));

function captureFetch(t) {
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    seen.push({ url: String(url), method: options.method, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ job_id: 'job_1' }), { status: 200 });
  });
  return seen;
}

const IG = 'https://www.instagram.com/reel/CxYz123AbC/';
const TT = 'https://www.tiktok.com/@demo/video/7301234567890123456';

test('registers both social tools', () => {
  const map = handlers();
  assert.ok(map.has('captain_index_instagram'));
  assert.ok(map.has('captain_index_tiktok'));
});

test('does not offer options the social routes refuse', () => {
  for (const name of ['captain_index_instagram', 'captain_index_tiktok']) {
    const shape = handlers().get(name).definition.inputSchema;
    for (const refused of ['max_files', 'transcription_language', 'parsing_script', 'languages', 'on_missing_transcript']) {
      assert.equal(shape[refused], undefined, `${name} must not offer ${refused}: the API answers 422`);
    }
  }
  assert.equal(handlers().get('captain_index_tiktok').definition.inputSchema.include_images, undefined,
    'TikTok has no include_images: the route answers 422');
  assert.ok(handlers().get('captain_index_instagram').definition.inputSchema.include_images);
});

test('mode is audio or video only, and urls is capped at 20', () => {
  const schema = z.object(handlers().get('captain_index_instagram').definition.inputSchema);
  assert.ok(schema.safeParse({ collection: 'c', urls: IG, mode: 'video' }).success);
  assert.equal(schema.safeParse({ collection: 'c', urls: IG, mode: 'transcript' }).success, false);
  assert.equal(schema.safeParse({ collection: 'c', urls: Array(21).fill(IG) }).success, false);
  assert.equal(schema.safeParse({ collection: 'c', urls: [] }).success, false);
});

test('one Instagram URL posts { url } with only the fields given', async (t) => {
  const seen = captureFetch(t);
  await call('captain_index_instagram', { collection: 'social', urls: IG, include_images: false });
  assert.equal(seen.length, 1);
  assert.match(seen[0].url, /\/v2\/collections\/social\/index\/instagram$/);
  assert.equal(seen[0].method, 'POST');
  assert.deepEqual(seen[0].body, { url: IG, include_images: false });
});

test('several TikTok URLs post { urls } and pass the options through', async (t) => {
  const seen = captureFetch(t);
  await call('captain_index_tiktok', {
    collection: 'social', urls: [TT, 'https://vm.tiktok.com/ZMabc123/'], mode: 'video',
    include_caption: false, skip_existing: false, overwrite_existing: true, custom_metadata: { team: 'growth' },
  });
  assert.match(seen[0].url, /\/index\/tiktok$/);
  assert.deepEqual(seen[0].body, {
    urls: [TT, 'https://vm.tiktok.com/ZMabc123/'], mode: 'video', include_caption: false,
    skip_existing: false, overwrite_existing: true, custom_metadata: { team: 'growth' },
  });
});

test('skip_existing and overwrite_existing both true is refused before anything is sent', async (t) => {
  const seen = captureFetch(t);
  await assert.rejects(
    call('captain_index_instagram', { collection: 'c', urls: IG, skip_existing: true, overwrite_existing: true }),
    /skip_existing to be false/);
  assert.equal(seen.length, 0);
});

test('the descriptions state the audio default and that slideshow photos are not indexed', () => {
  const ig = handlers().get('captain_index_instagram').definition.description;
  const tt = handlers().get('captain_index_tiktok').definition.description;
  for (const d of [ig, tt]) {
    assert.match(d, /Audio is the default mode/);
    assert.match(d, /no_audio_stream/);
  }
  assert.match(tt, /slideshow photos are not indexed/);
});

test('captain_job_status lists each post and each failed item', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    job_id: 'job_1', status: 'completed', job_type: 'index_instagram',
    source_report: {
      source: 'instagram', posts_seen: 1, posts_indexed: 1, posts_skipped_unchanged: 0, posts_failed: 0,
      social_posts: [{
        platform: 'instagram', post_id: 'BQ0eAlwhDrw', status: 'indexed', mode_used: 'audio', reason: null,
        items: [1, 2, 3].map((n) => ({ kind: 'audio', index: n, status: 'failed', reason: 'no_audio_stream', file_name: `instagram_BQ0eAlwhDrw_${n}.m4a` }))
          .concat([{ kind: 'caption', status: 'queued', reason: null, file_name: 'instagram_BQ0eAlwhDrw_caption.txt' }]),
      }],
    },
  }), { status: 200 }));
  const out = await call('captain_job_status', { job_id: 'job_1' });
  const text = out.content[0].text;
  assert.match(text, /Posts: 1 seen, 1 indexed, 0 skipped \(unchanged\), 0 failed/);
  assert.match(text, /BQ0eAlwhDrw \[indexed\] audio, 1 of 4 items indexed or queued/);
  for (const n of [1, 2, 3]) assert.match(text, new RegExp(`audio ${n} failed: no_audio_stream`));
});
