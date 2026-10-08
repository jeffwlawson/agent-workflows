/**
 * PROTOTYPE (#399), throwaway. The engine's one door to GitHub: a REST call
 * and a GraphQL call, over `fetch`, with the token handed in. No `gh`, so no
 * environment: `gh` would need `PATH` and `GH_TOKEN` from `process.env`, and
 * the engine reads none (ADR 0005).
 */

export interface RestRequest {
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  readonly path: string;
  readonly body?: unknown;
}

/** What the writer and the reader call. The real one is `fetchTransport`; a test hands in a fake. */
export interface Transport {
  rest(request: RestRequest): Promise<unknown>;
  graphql(query: string, variables: Readonly<Record<string, unknown>>): Promise<unknown>;
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export const fetchTransport = (token: string, apiUrl = "https://api.github.com"): Transport => {
  const rest = async ({ method, path, body }: RestRequest): Promise<unknown> => {
    const response = await fetch(`${apiUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) throw new GitHubError(`${method} ${path}: ${response.status} ${text.slice(0, 300)}`, response.status);
    return text === "" ? undefined : JSON.parse(text);
  };
  return {
    rest,
    graphql: async (query, variables) => {
      // GraphQL answers an error with 200 and an `errors` array, which is
      // what `gh api graphql` turns into a failure and a raw POST would not.
      const answer = (await rest({ method: "POST", path: "/graphql", body: { query, variables } })) as {
        data?: unknown;
        errors?: { message: string }[];
      };
      if (answer.errors !== undefined && answer.errors.length > 0) {
        throw new GitHubError(`graphql: ${answer.errors.map((e) => e.message).join("; ")}`);
      }
      return answer.data;
    },
  };
};
