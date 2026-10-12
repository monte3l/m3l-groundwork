---
"@monte3l/groundwork": patch
---

pack(publishing): the release workflow now prints the staged id to approve in the job log and as a run annotation, through a new "Show the staged ids to approve" step. changesets swallows the publisher's stdout, so the id previously appeared nowhere in the log.
