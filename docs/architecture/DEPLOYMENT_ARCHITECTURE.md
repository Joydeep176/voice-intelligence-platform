# Deployment Architecture

Status: **Approved targets (Docker Compose locally; AWS ECS + RDS + S3 in production). Details tagged *Proposed* are not approved.** Nothing is provisioned in AWS. **Conflict flagged (2026-11-21):** paid cloud infrastructure is not allowed by ADR-0034; the production deployment target is OD-48 (Open); the AWS sections below are kept as the original approved design until OD-48 is decided. IaC/CI: OD-17. Phase 1 local stack: `infra/docker/compose.yaml` runs `postgres` (pgvector 0.8.7 on PostgreSQL 18), `redis` (noeviction, AOF) and, under the `audio` profile, `audio-service`; `web`, `api` and `orchestrator` run on the host via pnpm in Phase 1.

## 1. Local development (Docker Compose)

| Service | Source | Notes |
|---|---|---|
| `web` | `apps/web` | Vite dev server |
| `api` | `apps/api` | Shared storage volume |
| `orchestrator` | `apps/orchestrator` | Shared storage volume; Claude key; **fake STT/diarization/research adapters by default** (ADR-0012) |
| `audio-service` | `services/audio` | FFmpeg in image; CPU/memory limits set (SEC-10, NFR-7). Networking per ADR-0035: while API and orchestrator run on the host, a normal bridge published to `127.0.0.1:8001` only, bearer token required, **container egress possible**; all-in-Compose: `internal: true` network only, no published port, API and orchestrator dual-homed |
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
 ECS: audio-service (no public ingress; 768 MB / 2 CPUs, ADR-0039 / ADR-0041; the selected self-hosted models run on CPU, no GPU capacity needed)
 RDS PostgreSQL (pgvector available, encrypted, private subnets)
 S3 (private, SSE-KMS, versioning + lifecycle per retention policy)
```

- **Scaling**: `orchestrator` scales on queue depth; `audio-service` on task backlog/CPU. Both have hard maximum task counts (OPS-1).
- **GPU**: not needed for the selected self-hosted STT and diarization (whisper.cpp, sherpa-onnx), which run on CPU in a 768 MB / 2 CPU audio-service container (ADR-0039, ADR-0041). ECS GPU tasks would need the EC2 launch type (Fargate has no GPU).
- **Encryption** (SEC-4): RDS storage encryption, S3 SSE-KMS, Redis at-rest and in-transit encryption, TLS on ALB and between services (*Proposed* mechanism for internal TLS with OD-23c).
- **Secrets**: AWS Secrets Manager / SSM, injected into task definitions. Never baked into images.
- **Network**: private subnets for all tasks and data stores. Outbound internet via NAT only for Claude and the approved provider endpoints (*Proposed*: egress allow-listing).
- **Logging**: CloudWatch, structured logs, with IDs and codes only, never transcript text, audio or secrets (SEC-9). Tracing: OD-15.
- **Backups**: RDS automated backups. Retention aligned with the deletion policy before production (OD-09b).

## 3. Environments

`local` → `staging` → `production`. Production requires the full OD-09b policy, a chosen IdP (OD-08b), and production providers selected by benchmark (ADR-0012).

## 4. Configuration contract

Environment variables validated at startup. Groups: database, Redis, storage driver (`local|s3`) and bucket, Anthropic key and per-agent models, cost ceiling, provider IDs and credentials (STT, diarization, research), self-hosted inference (`STT_PROVIDER` and `DIARIZATION_PROVIDER` with `fake|whisper-cpp|sherpa-onnx`, `DIARIZATION_*`, `STT_VAD_*`, `AUDIO_SERVICE_MODELS_DIR`, `AUDIO_MODELS_HOST_ROOT`), audio-service URL and service credential (ADR-0035; production OD-23c), queue bounds, audio-task timeouts and memory budget, limits (OD-10).
