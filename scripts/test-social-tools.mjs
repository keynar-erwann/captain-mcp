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
