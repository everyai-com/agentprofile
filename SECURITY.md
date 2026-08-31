# Security Policy

agentprofile stores credentials and personal memory, so we treat security as the
product, not a feature. This policy is in force from day one.

## Reporting a vulnerability

Please report suspected vulnerabilities privately via **GitHub Security Advisories**
("Report a vulnerability" on the Security tab) or by email to **security@agentprofile.dev**.

- We aim to acknowledge within 48 hours and give an initial assessment within 5 business days.
- Please do not open public issues for security reports.
- We support coordinated disclosure and will credit reporters who wish to be named.

A machine-readable contact is published at `/.well-known/security.txt`.

## Scope and design commitments

- **Zero-knowledge credentials (Phase 3):** API keys are encrypted client-side
  (per-secret AES-256-GCM data keys wrapped by a device-held master key). The
  server stores only ciphertext and wrapped keys and never sees plaintext. This
  is the core trust guarantee and will ship with a published independent crypto
  audit before the credential feature leaves beta.
- **No secret logging:** credential material and tokens are never written to logs.
- **Per-client grants:** every tool call is authorized and audited inside the
  user's Durable Object before any data is read.
- **Signed skills (Phase 4):** third-party skills are scanned for prompt injection
  and signed before they can be installed.

## Supported versions

During the 0.x pre-release series, only the latest published version receives
security fixes.
