# Deployment Architecture

Status: **Approved targets (Docker Compose locally; AWS ECS + RDS + S3 in production). Details tagged *Proposed* are not approved.** Nothing is provisioned in AWS. IaC/CI: OD-17. Phase 1 local stack: `infra/docker/compose.yaml` runs `postgres` (pgvector 0.8.7 on PostgreSQL 18), `redis` (noeviction, AOF) and, under the `audio` profile, `audio-service`; `web`, `api` and `orchestrator` run on the host via pnpm in Phase 1.

## 1. Local development (Docker Compose)

| Service | Source | Notes |
|---|---|---|
| `web` | `apps/web` | Vite dev server |
| `api` | `apps/api` | Shared storage volume |
| `orchestrator` | `apps/orchestrator` | Shared storage volume; Claude key; **fake STT/diarization/research adapters by default** (ADR-0012) |
| `audio-service` | `services/audio` | FFmpeg in image; internal network only; CPU/memory limits set (SEC-10, NFR-7) |
| `postgres` | PostgreSQL image with the pgvector extension | Persistent volume |
| `redis` | Redis | BullMQ requires `maxmemory-policy noeviction` |

- Storage: a named volume mounted into `api`, `orchestrator` and `audio-service` (`LocalStorage`).
- Data: synthetic or explicitly consented audio only (ADR-0004).
- Secrets: git-ignored `.env`. A committed `.env.example` lists names only.

## 2. Production (AWS)

```
 Route 53 / TLS ─▶ ALB (public) ─▶ ECS: api
 Static web (*Proposed* S3 + CDN)
 ECS: orchestrator ──▶ Redis (*Proposed* ElastiCache, TLS + at-rest encryption)
        │  internal HTTP (private; *Proposed* ECS Service Connect or internal ALB)
        ▼
 ECS: audio-service (no public ingress; EC2 GPU capacity only if self-hosted diarization is chosen)
 RDS PostgreSQL (pgvector available, encrypted, private subnets)
 S3 (private, SSE-KMS, versioning + lifecycle per retention policy)
```

- **Scaling**: `orchestrator` scales on queue depth; `audio-service` on task backlog/CPU. Both have hard maximum task counts (OPS-1).
- **GPU**: only for self-hosted pyannote/STT. ECS GPU tasks need the EC2 launch type (Fargate has no GPU). Decided after the benchmark (ADR-0012).
- **Encryption** (SEC-4): RDS storage encryption, S3 SSE-KMS, Redis at-rest and in-transit encryption, TLS on ALB and between services (*Proposed* mechanism for internal TLS with OD-23b).
- **Secrets**: AWS Secrets Manager / SSM, injected into task definitions. Never baked into images.
- **Network**: private subnets for all tasks and data stores. Outbound internet via NAT only for Claude and the approved provider endpoints (*Proposed*: egress allow-listing).
- **Logging**: CloudWatch, structured logs, with IDs and codes only, never transcript text, audio or secrets (SEC-9). Tracing: OD-15.
- **Backups**: RDS automated backups. Retention aligned with the deletion policy before production (OD-09b).

## 3. Environments

`local` → `staging` → `production`. Production requires the full OD-09b policy, a chosen IdP (OD-08b), and production providers selected by benchmark (ADR-0012).

## 4. Configuration contract

Environment variables validated at startup. Groups: database, Redis, storage driver (`local|s3`) and bucket, Anthropic key and per-agent models, cost ceiling, provider IDs and credentials (STT, diarization, research), audio-service URL and service credential (OD-23b), queue bounds, audio-task timeouts and memory budget, limits (OD-10).
