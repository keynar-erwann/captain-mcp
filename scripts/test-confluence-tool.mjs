import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { registerCaptainTools } from '../dist/tools.js';
import { runWithConfig } from '../dist/captainClient.js';

const TOOL = 'captain_index_confluence';

function handlers() {
  const map = new Map();
  registerCaptainTools({ registerTool: (name, definition, handler) => map.set(name, { definition, handler }) });
  return map;
}
const call = (name, args) => runWithConfig({ apiKey: 'synthetic' }, () => handlers().get(name).handler(args));

const creds = {
  collection: 'wiki',
  confluence_site: 'example.atlassian.net',
  confluence_email: 'person@example.com',
  confluence_api_token: 'synthetic-token',
};

function captureFetch(t) {
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    seen.push({ url: String(url), method: options.method, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ job_id: 'job_1' }), { status: 200 });
  });
  return seen;
}

test('registers the Confluence tool', () => {
  assert.ok(handlers().has(TOOL));
});

test('does not offer the options the Confluence routes refuse', () => {
  const shape = handlers().get(TOOL).definition.inputSchema;
  for (const refused of ['skip_existing', 'overwrite_existing', 'max_files', 'parsing_script', 'transcription_language']) {
    assert.equal(shape[refused], undefined, `${refused} must not be offered: the API answers 422`);
  }
  const schema = z.object(shape);
  assert.ok(schema.safeParse({ ...creds, include_images: true }).success);
});

test('a whole-site import posts to /index/confluence with only the fields given', async (t) => {
  const seen = captureFetch(t);
  await call(TOOL, { ...creds, space_keys: ['ENG', 'OPS'] });
  assert.equal(seen.length, 1);
  assert.match(seen[0].url, /\/v2\/collections\/wiki\/index\/confluence$/);
  assert.equal(seen[0].method, 'POST');
  assert.deepEqual(seen[0].body, {
    confluence_site: 'example.atlassian.net',
    confluence_email: 'person@example.com',
    confluence_api_token: 'synthetic-token',
    processing_type: 'advanced',
    space_keys: ['ENG', 'OPS'],
  });
});

test('a space import posts to /index/confluence/space', async (t) => {
  const seen = captureFetch(t);
  await call(TOOL, { ...creds, space_key: 'ENG', include_images: true, include_comments: false });
  assert.match(seen[0].url, /\/index\/confluence\/space$/);
  assert.equal(seen[0].body.space_key, 'ENG');
  assert.equal(seen[0].body.include_images, true);
  assert.equal(seen[0].body.include_comments, false);
});

test('a page import posts to /index/confluence/page and passes include_descendants', async (t) => {
  const seen = captureFetch(t);
  await call(TOOL, { ...creds, page_id: '123456', include_descendants: false, force: true });
  assert.match(seen[0].url, /\/index\/confluence\/page$/);
  assert.equal(seen[0].body.page_id, '123456');
  assert.equal(seen[0].body.include_descendants, false);
  assert.equal(seen[0].body.force, true);
  for (const k of ['skip_existing', 'overwrite_existing']) assert.equal(k in seen[0].body, false);
});

test('conflicting scopes are refused before anything is sent', async (t) => {
  const seen = captureFetch(t);
  await assert.rejects(call(TOOL, { ...creds, page_id: '1', space_key: 'ENG' }), /not both/);
  await assert.rejects(call(TOOL, { ...creds, space_key: 'ENG', space_keys: ['OPS'] }), /whole-site/);
  assert.equal(seen.length, 0);
});

test('the image-link tool names original and Confluence attachments', () => {
  // registered by registerDocumentTools; read it from the built module
  return import('../dist/documentTools.js').then(({ registerDocumentTools }) => {
    const map = new Map();
    registerDocumentTools({ registerTool: (name, definition) => map.set(name, definition) });
    const d = map.get('captain_create_asset_urls').description;
    assert.match(d, /`original`/);
    assert.match(d, /confluence:\/\//);
    assert.match(d, /25 attachment ids/);
    assert.match(d, /PII masking/);
  });
});
