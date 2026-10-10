/**
 * The engine's one door to GitHub: a REST call and a GraphQL call, over
 * `fetch`, with the token handed in. No `gh`, so no environment: `gh` would
 * need `PATH` and `GH_TOKEN` from the process, and the engine reads none
 * (ADR 0005). Nothing here imports the loop (ADR 0002), and a test holds every
 * module under `engine/` to that.
 */

export interface RestRequest {
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  /** From the API root, leading slash included: `/repos/o/r/issues/7/labels`. */
  readonly path: string;
  readonly body?: unknown;
  /** The answer is plain text, such as a job's log, and is returned as it is rather than parsed. */
  readonly text?: true;
}

/** What the writer and the reader call. The real one is `fetchTransport`. */
export interface Transport {
  rest(request: RestRequest): Promise<unknown>;
  graphql(query: string, variables: Readonly<Record<string, unknown>>): Promise<unknown>;
}

/** How much of GitHub's answer an error keeps: `raw` in full, `reason` where it stands in for a `message`. */
const RAW_CAP = 300;
const EXCERPT_CAP = 100;

/**
 * A call GitHub refused, with its HTTP status where it gave one. `message` is
 * the sentence reading code puts in front of a person, and is kept as it was;
 * the write log builds its line from the rest: GitHub's own short `reason` for
 * the refusal, and its `raw` answer, capped, kept as evidence on a write that
 * failed.
 */
export class GitHubError extends Error {
  readonly reason: string;
  readonly raw: string | undefined;

  constructor(
    message: string,
    readonly status?: number,
    detail: { readonly reason?: string; readonly raw?: string } = {},
  ) {
    super(message);
    this.name = "GitHubError";
    this.reason = detail.reason ?? message;
    this.raw = detail.raw;
  }
}

/** GitHub's `message` from a JSON body, or a short excerpt of the body where it has none. */
const reasonIn = (body: string): string => {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null && "message" in parsed && typeof parsed.message === "string" && parsed.message !== "") {
      return parsed.message;
    }
  } catch {
    // Not JSON: the excerpt below stands in.
  }
  const excerpt = body.replace(/\s+/g, " ").trim();
  return excerpt.length > EXCERPT_CAP ? `${excerpt.slice(0, EXCERPT_CAP)}…` : excerpt;
};

/**
 * Whether `error` is GitHub failing rather than refusing: a 5xx, or GraphQL's
 * "An internal error occurred", which comes back with a 200 and no status.
 * Neither says the call did nothing, and GitHub has been seen to answer a
 * write with a 500 and make it all the same, so a caller that has to know
 * reads back rather than taking either as "not done".
 */
export const isServerError = (error: unknown): boolean =>
  error instanceof GitHubError &&
  ((error.status !== undefined && error.status >= 500) || /\bAn internal error occurred\b/i.test(error.message));

/** The transport over `fetch`, for `token`. */
export const fetchTransport = (token: string, apiUrl = "https://api.github.com"): Transport => {
  const rest = async ({ method, path, body, text: plain }: RestRequest): Promise<unknown> => {
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
    if (!response.ok) {
      throw new GitHubError(`${method} ${path}: ${response.status} ${text.slice(0, RAW_CAP)}`, response.status, {
        reason: reasonIn(text),
        raw: text.slice(0, RAW_CAP),
      });
    }
    if (plain === true) return text;
    return text === "" ? undefined : JSON.parse(text);
  };
  return {
    rest,
    graphql: async (query, variables) => {
      // GraphQL answers an error with 200 and an `errors` array, which `gh api
      // graphql` turns into a failure and a bare POST would not.
      const answer = (await rest({ method: "POST", path: "/graphql", body: { query, variables } })) as {
        readonly data?: unknown;
        readonly errors?: readonly { readonly message: string }[];
      };
      if (answer.errors !== undefined && answer.errors.length > 0) {
        const reason = answer.errors.map((error) => error.message).join("; ");
        throw new GitHubError(`graphql: ${reason}`, undefined, { reason, raw: JSON.stringify(answer.errors).slice(0, RAW_CAP) });
      }
      return answer.data;
    },
  };
};
