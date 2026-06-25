# Coding Worker Code Review Loop

Use this skill for independent review after implementation.

- Compare the diff against the original request.
- Check for behavioral regressions, missing tests, unsafe side effects, and architecture boundary violations.
- Confirm required verification evidence exists and is passing.
- Return findings as a structured `CodingCodeReviewResult` with discrete findings and an `approved` boolean.
- Each finding should include `severity` (`info` | `warning` | `blocker`), `message`, and the affected `file` and line range when possible.
- Do not approve completion without passing required verification or while any blocker finding remains.
- If the lead loop rejects the review, it will replan and return to implementation up to the replan budget; persistent rejection pauses the loop for human review.
