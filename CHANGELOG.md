# Changelog

## [0.7.0] - 2026-11-03

- a job killed after /reload reads as killed on Windows, not failed
- a ✕ closes the job browser, and a kill from it asks first
- a job settles only once its log is on disk, so a result never misses its tail
- a kill is reported once, and a kill from /shell-bg never wakes the model (#3)
- README describes /shell-bg tui, the bare command, and the fixed-size job view
- /shell-bg autocompletes, and a job browser shows every job's output
- a second /reload while an adopted job runs no longer crashes pi

## [0.6.1] - 2026-10-22

- a job collected with shell_status is never delivered twice (#2)

## [0.6.0] - 2026-10-22

- deliverResults setting to opt out of auto-delivering finished background jobs

## [0.5.1] - 2026-10-14

- a distinct document is never truncated by the shrink; JSON test reports become counts + failures

