# ADR 0007: Two Environments — local And dev

- Status: Accepted
- Date: 2026-10-22
- Decision owners: Learning Lab Platform maintainers

## Context

The previous plan defined development, staging, and production with
one-directional promotion and a long list of production gates. None of that
carried learner traffic, and the staging/production AWS roots were destroyed
on 2026-08-16. The platform currently has one maintainer and no external
learners.

## Decision

Maintain exactly two environments.

| | local | dev |
|---|---|---|
| Cluster | `kind` on the developer machine | EKS Auto Mode, `us-east-2`, account `442359104502` |
| Frontend | Vite dev server | S3 + CloudFront |
| Control plane | `npx convex dev` deployment | Convex `prod:upbeat-crab-254` |
| Identity | Clerk development instance, optional (`VITE_AUTH_MODE=disabled` allowed) | Same Clerk development instance, required |
| Scenario bundles | Mounted from the repository | Digest-addressed tarballs in S3, approved in Convex |
| Terraform | none | `infra/aws/environments/dev`, state key `learning-lab-platform/dev/terraform.tfstate` in the existing backend |
| Deletion protection | n/a | off |

`config/hosted-environments.json` is the single description of both.

The production Clerk instance and Convex deployment created under the old
plan are parked, not deleted, and are referenced by nothing.

## Consequences

- `HOSTED_ENVIRONMENT` accepts only `dev`.
- There is no promotion pipeline; `main` deploys to dev.
- Adding a third environment later means adding a Terraform root, a Convex
  deployment, Helm values, and an entry in `hosted-environments.json`.
