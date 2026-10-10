/**
 * The transport over a faked `fetch`: what it keeps of a refusal for the write
 * log, and the `message` reading code shows a person, which does not change.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchTransport, GitHubError, isServerError } from "../../engine/github.js";

/** `fetch` answering every request with `status` and `body`. */
const answering = (status: number, body: string): void => {
  vi.stubGlobal("fetch", async () => new Response(body === "" ? null : body, { status }));
};

const refusal = async (call: Promise<unknown>): Promise<GitHubError> => {
  const error = await call.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(GitHubError);
  return error as GitHubError;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a refused REST call", () => {
  const LABEL_404 = JSON.stringify({
    message: "Label does not exist",
    documentation_url: "https://docs.github.com/rest/issues/labels#remove-a-label-from-an-issue",
    status: "404",
  });

  it("carries GitHub's status and its JSON `message`, and the raw answer apart", async () => {
    answering(404, LABEL_404);

    const error = await refusal(fetchTransport("t").rest({ method: "DELETE", path: "/repos/o/r/issues/7/labels/x" }));

    expect(error.status).toBe(404);
    expect(error.reason).toBe("Label does not exist");
    expect(error.raw).toBe(LABEL_404);
  });

  it("keeps its message as it was, so reading code's sentences and isServerError do not change", async () => {
    answering(404, LABEL_404);
    const refused = await refusal(fetchTransport("t").rest({ method: "DELETE", path: "/repos/o/r/issues/7/labels/x" }));
    answering(502, "<html>Bad Gateway</html>");
    const failing = await refusal(fetchTransport("t").rest({ method: "GET", path: "/repos/o/r" }));

    expect(refused.message).toBe(`DELETE /repos/o/r/issues/7/labels/x: 404 ${LABEL_404}`);
    expect(failing.message).toBe("GET /repos/o/r: 502 <html>Bad Gateway</html>");
    expect([isServerError(refused), isServerError(failing)]).toEqual([false, true]);
  });

  it("stands a short capped excerpt in for a body that is not JSON, or has no `message`", async () => {
    const page = `<html>\n  <body>${"Unicorn! ".repeat(40)}</body>\n</html>`;
    answering(503, page);
    const html = await refusal(fetchTransport("t").rest({ method: "GET", path: "/x" }));
    answering(422, JSON.stringify({ errors: ["bad"] }));
    const bare = await refusal(fetchTransport("t").rest({ method: "GET", path: "/x" }));

    expect(html.reason).toBe(`<html> <body>${"Unicorn! ".repeat(40)}`.slice(0, 100) + "…");
    expect(html.raw).toBe(page.slice(0, 300));
    expect(bare.reason).toBe('{"errors":["bad"]}');
  });
});

describe("a refused GraphQL call", () => {
  it("carries GitHub's error messages as its reason, and keeps its message as it was", async () => {
    const errors = [{ message: "Could not resolve to a node" }, { message: "An internal error occurred" }];
    answering(200, JSON.stringify({ errors }));

    const error = await refusal(fetchTransport("t").graphql("query{x}", {}));

    expect(error.message).toBe("graphql: Could not resolve to a node; An internal error occurred");
    expect(error.status).toBeUndefined();
    expect(error.reason).toBe("Could not resolve to a node; An internal error occurred");
    expect(error.raw).toBe(JSON.stringify(errors));
    expect(isServerError(error)).toBe(true);
  });
});
