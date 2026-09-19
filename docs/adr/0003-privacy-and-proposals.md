# ADR 0003: Explicit network boundary and reviewed inference

Status: accepted.

Default to local-only and AI disabled. Only a user-initiated model operation may contact a configured provider; local-only means literal loopback addresses/localhost and redirect rejection. Cloud calls require explicit opt-in on each request. Keys use OS credential storage or an environment variable, never application JSON. AI has no execution tools. Inferences carry origin/model/evidence and remain proposals until accepted; acceptance retains inferred provenance. Low-risk automatic acceptance, if enabled, is limited to explicitly allowed operations and still recorded in history.
