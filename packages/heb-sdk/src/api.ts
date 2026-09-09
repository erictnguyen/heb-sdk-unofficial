import { createHash } from 'node:crypto';
import { logDebug } from './logger.js';
import { MOBILE_QUERY_TEXT } from './queries.js';
import { ensureFreshSession, normalizeHeaders, resolveEndpoint } from './session.js';
import type { HEBSession } from './types.js';
import { GRAPHQL_HASHES, MOBILE_GRAPHQL_HASHES } from './types.js';

/**
 * GraphQL request payload structure.
 */
export interface GraphQLPayload {
  operationName: string;
  variables: Record<string, unknown>;
  /** Full query text; only sent on the APQ fallback after PersistedQueryNotFound. */
  query?: string;
  extensions?: {
    persistedQuery?: {
      version: number;
      sha256Hash: string;
    };
  };
}

/**
 * HEB API error structure.
 */
export interface HEBAPIError {
  message: string;
  extensions?: {
    code?: string;
    classification?: string;
  };
}

/**
 * GraphQL response wrapper.
 */
export interface GraphQLResponse<T> {
  data?: T;
  errors?: HEBAPIError[];
}

/**
 * Common HEB API error codes.
 */
export const ERROR_CODES = {
  INVALID_PRODUCT_STORE: 'INVALID_PRODUCT_STORE',
  UNAUTHORIZED: 'UNAUTHORIZED',
  NOT_FOUND: 'NOT_FOUND',
} as const;

/**
 * Execute a GraphQL request against the HEB API.
 */
export async function graphqlRequest<T>(
  session: HEBSession,
  payload: GraphQLPayload
): Promise<GraphQLResponse<T>> {
  await ensureFreshSession(session);
  const headers = normalizeHeaders(session.headers);
  logDebug(session, `${payload.operationName} request`, payload);
  const response = await fetch(resolveEndpoint(session, 'graphql'), {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    logDebug(session, `${payload.operationName} error response`, body);
    throw new Error(`HEB API request failed: ${response.status} ${response.statusText}\n${body}`);
  }

  const json = await response.json();
  logDebug(session, `${payload.operationName} response`, json);
  return json as GraphQLResponse<T>;
}

export const PERSISTED_QUERY_NOT_FOUND = 'PERSISTED_QUERY_NOT_FOUND';

/** Max requests one persistedQuery() call may make while recovering from PersistedQueryNotFound. */
const PERSISTED_QUERY_ATTEMPTS = 2;

export function isPersistedQueryNotFound(response: GraphQLResponse<unknown>): boolean {
  return response.errors?.some(
    e => e.extensions?.code === PERSISTED_QUERY_NOT_FOUND || /PersistedQueryNotFound/i.test(e.message ?? '')
  ) ?? false;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Execute a persisted GraphQL query.
 *
 * Sends the known hash first. If the server answers PersistedQueryNotFound
 * (its APQ cache is per instance, so a valid hash can still miss) it retries
 * once: with the full query text and that text's sha256 when we have text for
 * the operation (standard APQ recovery), otherwise hash-only in the hope of
 * landing on an instance that has it cached. Never more than two requests.
 */
export async function persistedQuery<T>(
  session: HEBSession,
  operationName: string,
  variables: Record<string, unknown>
): Promise<GraphQLResponse<T>> {
  const { hash, resolvedOperationName } = resolvePersistedQuery(session, operationName);
  const payload = (sha256Hash: string, query?: string): GraphQLPayload => ({
    operationName: resolvedOperationName,
    variables,
    ...(query ? { query } : {}),
    extensions: { persistedQuery: { version: 1, sha256Hash } },
  });

  let response = await graphqlRequest<T>(session, payload(hash));
  for (let attempt = 2; attempt <= PERSISTED_QUERY_ATTEMPTS && isPersistedQueryNotFound(response); attempt++) {
    const text = session.authMode === 'bearer' ? MOBILE_QUERY_TEXT[resolvedOperationName] : undefined;
    logDebug(session, `${resolvedOperationName} PersistedQueryNotFound`, `retrying ${text ? 'with query text' : 'hash-only'}`);
    response = await graphqlRequest<T>(session, text ? payload(sha256(text), text) : payload(hash));
  }
  return response;
}

const MOBILE_QUERY_MAP: Record<string, string> = {
  cartItemV2: 'addItemToCartV2',
  cartEstimated: 'cartV2',
  typeaheadContent: 'TypeaheadContent',
  ReserveTimeslot: 'reserveTimeslotV3',
};

function resolvePersistedQuery(
  session: HEBSession,
  operationName: string
): { resolvedOperationName: string; hash: string } {
  if (session.authMode === 'bearer') {
    const mapped = MOBILE_QUERY_MAP[operationName] ?? operationName;
    const mobileHash = (MOBILE_GRAPHQL_HASHES as Record<string, string>)[mapped];
    if (mobileHash) {
      return { resolvedOperationName: mapped, hash: mobileHash };
    }
  }

  const webHash = (GRAPHQL_HASHES as Record<string, string>)[operationName];
  if (webHash) {
    return { resolvedOperationName: operationName, hash: webHash };
  }

  const available = session.authMode === 'bearer'
    ? Array.from(new Set([...Object.keys(MOBILE_GRAPHQL_HASHES), ...Object.keys(GRAPHQL_HASHES)]))
    : Object.keys(GRAPHQL_HASHES);
  throw new Error(`Unknown operation: ${operationName}. Available: ${available.join(', ')}`);
}

/**
 * Check if response contains specific error code.
 */
export function hasErrorCode(
  response: GraphQLResponse<unknown>,
  code: string
): boolean {
  return response.errors?.some(e => e.extensions?.code === code) ?? false;
}

/**
 * Extract error messages from response.
 */
export function getErrorMessages(response: GraphQLResponse<unknown>): string[] {
  return response.errors?.map(e => e.message) ?? [];
}
