# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

## Priority labels

Every issue labelled `enhancement` carries exactly one priority label:

| Label          | Meaning                                             |
| -------------- | --------------------------------------------------- |
| `must-have`    | The next release can't ship without it              |
| `should-have`  | Important, but a release can ship without it        |
| `nice-to-have` | Worth doing when there's time, or when someone asks |

- The maintainer sets the priority at triage. A reporter isn't expected to, and the feature request form doesn't ask.
- An `enhancement` doesn't leave `needs-triage` for `ready-for-agent` or `ready-for-human` without one. When creating an `enhancement` on a maintainer's behalf, ask for the priority if it wasn't given.
- Changing the priority means swapping the label, never holding two.
- Other issues, such as `bug` and `documentation`, may carry a priority label but don't have to.
- When choosing what to work on next, take `must-have` before `should-have` before `nice-to-have`. Under a parent issue, the order of its sub-issues decides within a priority.

`1.0-blocker` marks what must be settled before 1.0 is released. It goes with `must-have`, and is retired once 1.0 is out.

Edit the right-hand column to match whatever vocabulary you actually use.
