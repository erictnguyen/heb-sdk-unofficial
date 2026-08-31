import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const require = createRequire(new URL('../packages/heb-mcp/package.json', import.meta.url));
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const { port } = address;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForServer(child) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const timeout = setTimeout(() => reject(new Error(`MCP server did not start:\n${stderr}`)), 10_000);

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.includes('Streamable HTTP server listening')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`MCP server exited before startup with code ${code}:\n${stderr}`));
    });
  });
}

test('hosted transport authenticates, lists tools, and rejects unsupported listen methods cleanly', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'heb-mcp-test-'));
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const tokenFile = join(dataDir, 'tokens.json');
  const accessToken = 'test-access-token';

  await writeFile(tokenFile, JSON.stringify({
    v: 1,
    accessTokens: {
      [accessToken]: {
        token: accessToken,
        clientId: 'test-client',
        userId: 'test-user',
        scopes: ['mcp:tools'],
        resource: `${baseUrl}/mcp`,
        expiresAt: Date.UTC(2100, 0, 1),
      },
    },
    refreshTokens: {},
  }));

  const child = spawn(process.execPath, ['packages/heb-mcp/dist/server.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      MCP_MODE: 'remote',
      PORT: String(port),
      MCP_SERVER_URL: baseUrl,
      MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL: '1',
      HEB_SESSION_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      HEB_SESSION_STORE_DIR: join(dataDir, 'sessions'),
      MCP_OAUTH_CLIENTS_FILE: join(dataDir, 'clients.json'),
      MCP_OAUTH_TOKENS_FILE: tokenFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  t.after(async () => {
    child.kill('SIGTERM');
    await rm(dataDir, { recursive: true, force: true });
  });

  await waitForServer(child);

  const unauthorized = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'unauthorized-test', version: '1.0.0' },
      },
    }),
  });
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers.get('www-authenticate') ?? '', /resource_metadata=/);

  const invalidOrigin = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Origin: 'https://invalid.example',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    }),
  });
  assert.equal(invalidOrigin.status, 403);

  for (const method of ['GET', 'DELETE']) {
    const response = await fetch(`${baseUrl}/mcp`, {
      method,
      headers: {
        Accept: 'text/event-stream',
        Authorization: `Bearer ${accessToken}`,
        'MCP-Protocol-Version': '2025-06-18',
      },
    });

    assert.equal(response.status, 405, `${method} /mcp should return 405`);
    assert.equal(response.headers.get('allow'), 'POST');
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
  }

  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  });
  const client = new Client({ name: 'transport-test', version: '1.0.0' });
  t.after(() => client.close());

  await client.connect(transport);
  const { tools } = await client.listTools();

  assert.ok(tools.length > 0);
  assert.ok(tools.some(({ name }) => name === 'heb_get_session_info'));
});
