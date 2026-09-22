# Routing layer — tracked future work

Future work items previously maintained in this document have been migrated to tracked GitHub issues:

- **[#52 - Fast-skip exhausted provider candidates during in-lease sequential fallback][issue-52]**: Immediate in-lease
  provider skipping upon quota or usage limit exhaustion.
- **[#53 - Cross-lease endpoint and provider circuit breaker state][issue-53]**: Persistent closed/open/half-open
  circuit breaker state across leases and turns (FW1 Part A).
- **[#54 - Active health recovery and background probing for circuit breakers][issue-54]**: Transport timeout
  normalization, isolated synthetic probes, and operator controls (FW1 Part B).
- **[#55 - Workflow-specific horizon semantics][issue-55]**: Horizon schema evaluation for non-coding planning and
  operations workflows (FW2).
- **[#56 - Measure observed GPT-5.6 cache-read ratios across endpoints][issue-56]**: Comparative cache telemetry across
  Amazon Bedrock and OpenAI direct (FW3).
- **[#57 - Cache-class eligibility guard based on measured cache-read share][issue-57]**: Empirically thresholded guards
  for unpriced cache endpoints (FW4).

Please file any new proposals or follow-ups as GitHub issues.

[issue-52]: https://github.com/nigel-upstart/pi-buildout/issues/52
[issue-53]: https://github.com/nigel-upstart/pi-buildout/issues/53
[issue-54]: https://github.com/nigel-upstart/pi-buildout/issues/54
[issue-55]: https://github.com/nigel-upstart/pi-buildout/issues/55
[issue-56]: https://github.com/nigel-upstart/pi-buildout/issues/56
[issue-57]: https://github.com/nigel-upstart/pi-buildout/issues/57
