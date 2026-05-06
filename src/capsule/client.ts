import { fetch, type Response } from "undici";

const BASE_URL = "https://api.capsulecrm.com/api/v2";

export class CapsuleAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapsuleAuthError";
  }
}

export class CapsuleApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CapsuleApiError";
  }
}

export interface PagedResult<T> {
  data: T;
  nextPage: number | undefined;
}

function getToken(): string {
  const token = process.env["CAPSULE_API_TOKEN"];
  if (!token) {
    throw new CapsuleAuthError(
      "CAPSULE_API_TOKEN environment variable is not set. " +
        "Generate a Personal Access Token via My Preferences → API Authentication Tokens in Capsule.",
    );
  }
  return token;
}

function baseHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
}

/** Parse RFC 5988 Link header and return the `next` page number, if present. */
function parseNextPage(linkHeader: string | null): number | undefined {
  if (!linkHeader) return undefined;
  // Link: <https://...?page=3&perPage=25>; rel="next"
  const match = linkHeader.match(/<[^>]*[?&]page=(\d+)[^>]*>;\s*rel="next"/);
  return match ? parseInt(match[1]!, 10) : undefined;
}

async function parseErrorBody(res: Response): Promise<string> {
  try {
    const json = (await res.json()) as { message?: string };
    return json.message ?? res.statusText;
  } catch {
    return res.statusText;
  }
}

async function doFetch(
  url: string,
  options: Parameters<typeof fetch>[1],
): Promise<Response> {
  const res = await fetch(url, options);

  if (res.status === 429) {
    const retryAfter = res.headers.get("Retry-After");
    const delay = retryAfter ? parseFloat(retryAfter) * 1000 : 5_000;
    await new Promise((resolve) => setTimeout(resolve, delay));

    const retried = await fetch(url, options);
    if (retried.status === 429) {
      throw new CapsuleApiError(429, "Rate limit exceeded after one retry. Please slow down your requests.");
    }
    return retried;
  }

  return res;
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (res.status === 401) {
    throw new CapsuleAuthError(
      "Capsule API returned 401 Unauthorized. Check that CAPSULE_API_TOKEN is valid and not expired.",
    );
  }
  if (!res.ok) {
    const msg = await parseErrorBody(res);
    throw new CapsuleApiError(res.status, `Capsule API error ${res.status}: ${msg}`);
  }
  return res.json() as Promise<T>;
}

export type QueryParams = Record<string, string | number | boolean | undefined>;

function buildUrl(path: string, params?: QueryParams): string {
  const url = new URL(`${BASE_URL}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

export async function capsuleGet<T>(
  path: string,
  params?: QueryParams,
): Promise<PagedResult<T>> {
  const token = getToken();
  const url = buildUrl(path, params);
  const res = await doFetch(url, { headers: baseHeaders(token) });
  const data = await handleResponse<T>(res);
  const nextPage = parseNextPage(res.headers.get("Link"));
  return { data, nextPage };
}

export async function capsulePost<T>(path: string, body: unknown): Promise<T> {
  const token = getToken();
  const url = buildUrl(path);
  const res = await doFetch(url, {
    method: "POST",
    headers: { ...baseHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return handleResponse<T>(res);
}

export async function capsulePut<T>(path: string, body: unknown): Promise<T> {
  const token = getToken();
  const url = buildUrl(path);
  const res = await doFetch(url, {
    method: "PUT",
    headers: { ...baseHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return handleResponse<T>(res);
}
