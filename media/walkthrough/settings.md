# Fine-tune

Every option lives under `clickupDevTimer` in Settings. Popular ones:

| Setting                      | What it does                                             |
| ---------------------------- | -------------------------------------------------------- |
| `inactivityThresholdSeconds` | Idle time before the timer pauses itself (default 120 s) |
| `roundingMinutes`            | Round each session to a multiple of N minutes (0 = off)  |
| `roundingMode`               | Round to the `nearest` multiple, or always `up` / `down` |
| `minimumEntrySeconds`        | Drop sessions shorter than this instead of syncing them  |
| `askDescriptionOnFinish`     | Ask for a time entry description when you finish         |
| `defaultDescription`         | Description suggested for your time entries              |
| `branchDetection.patterns`   | Regexes that extract the task ID from your branch name   |
| `activeStatuses`             | Task statuses treated as "in progress" and listed first  |
