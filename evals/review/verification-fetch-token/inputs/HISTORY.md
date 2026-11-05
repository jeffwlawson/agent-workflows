This review **follows a fix round**: an earlier review of this pull request started one, and commits have landed since.

**A review that follows a fix round is a verification pass.** An earlier review of this pull request
stands, a fix round has pushed since, and the question is no longer *what is wrong with this change*
but *did the last round's findings land, and did the new commits break anything?* Rule on every open
finding (the section below), and read the new commits for what they broke: a fix that resolves its
own finding and regresses something else is what nothing else is looking for. A real problem in
code an earlier review of this pull request already read is *previously missed* (*THE TWO KINDS OF
FINDING*); one outside this pull request's scope is still a `followUps` entry, and *FOLLOW-UPS
EARLIER ROUNDS RECORDED* says whether to re-record an earlier round's (`howChecked` records that
this was a verification pass, and what you checked the earlier findings against).
