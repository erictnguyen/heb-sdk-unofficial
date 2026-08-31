import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const clientGuideUrl = new URL(
  '../packages/docs/src/content/docs/docs/mcp/client-guide.mdx',
  import.meta.url
);

test('Cursor install link configures the hosted MCP URL', async () => {
  const guide = await readFile(clientGuideUrl, 'utf8');
  const match = guide.match(/https:\/\/cursor\.com\/en-US\/install-mcp\?[^)\s]+/);

  assert.ok(match, 'Cursor install link is missing from the hosted setup guide');

  const installUrl = new URL(match[0]);
  const encodedConfig = installUrl.searchParams.get('config');
  assert.ok(encodedConfig, 'Cursor install link is missing its config parameter');

  const config = JSON.parse(Buffer.from(encodedConfig, 'base64').toString('utf8'));
  assert.deepEqual(config, { url: 'https://heb-mcp.hildy.io/mcp' });
});
