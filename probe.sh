# Throwaway probe for #133. Not for merge.
set -uo pipefail
owner=${GH_REPO%/*}; repo=${GH_REPO#*/}
marker="probe-${PROBE}-${GITHUB_RUN_ID}"
pr_id=$(gh api graphql -F o="$owner" -F r="$repo" -F n="$PR" -f query='query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){id}}}' --jq .data.repository.pullRequest.id)
echo "pr_id=$pr_id"
gh api graphql -f pr="$pr_id" -f sha="$HEAD_SHA" -f body="$marker" -f query='mutation($pr:ID!,$sha:GitObjectID!,$body:String!){addPullRequestReview(input:{pullRequestId:$pr,commitOID:$sha,event:COMMENT,threads:[{path:".github/workflows/probe-resolve-grant.yml",subjectType:FILE,body:$body}]}){pullRequestReview{id}}}' >/dev/null && echo "REVIEW ok" || echo "REVIEW refused"
tid=$(gh api graphql -F o="$owner" -F r="$repo" -F n="$PR" -f query='query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(last:20){nodes{id comments(first:1){nodes{body}}}}}}}' \
  | jq -r --arg m "$marker" '.data.repository.pullRequest.reviewThreads.nodes[] | select(.comments.nodes[0].body == $m) | .id')
echo "thread=$tid"
gh api graphql -f t="$tid" -f query='mutation($t:ID!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$t,body:"probe reply"}){clientMutationId}}' >/dev/null && echo "REPLY ok" || echo "REPLY refused"
gh api graphql -f t="$tid" -f query='mutation($t:ID!){resolveReviewThread(input:{threadId:$t,resolutionReason:ADDRESSED}){thread{isResolved}}}' && echo "RESOLVE ok" || echo "RESOLVE refused"
exit 0
