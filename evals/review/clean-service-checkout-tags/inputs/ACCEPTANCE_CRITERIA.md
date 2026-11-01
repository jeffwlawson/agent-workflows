- `C1`: A checkout the service makes holds every tag the repository's base has, as `fetch-depth: 0` gives on Actions, or the smallest fetch that yields the same set of tags. The brief's author recommends `--tags` on the existing fetch, adding no history beyond what the head and the base already bring; the implementer decides and justifies it in the PR.
- `C2`: The agent's sandbox copy holds those tags: a tag the checkout has can be read by `git show <tag>:<path>` from inside the agent's working copy.
- `C3`: A test proves a checkout made by the service's git edge holds the base's tags (a tag created on the base is present in the resulting checkout), and fails if tags are skipped.
- `C4`: The platform spec and the service deployment doc state that the checkout carries the repository's tags, wherever they describe what the checkout fetches (including the note that Actions' `fetch-depth: 0` fetches every branch while the service's fetches the base alone).
- `C5`: The token is still passed per fetch and never stored in the checkout.
- `C6`: One PR. Host-neutral: nothing about a particular deployment.

The pull request's body as it stands, for the criteria about the pull request itself:

> Opened by the agent loop from #567.
>
> ## Summary
>
> <!-- agent:summary -->
> <!-- /agent:summary -->
>
> Closes #567
