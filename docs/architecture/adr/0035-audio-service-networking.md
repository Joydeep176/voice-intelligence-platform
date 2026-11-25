# ADR-0035: Audio service networking and service authentication (D-2B-08)

- Status: Accepted (user decision, 2026-11-21, Phase 2B implementation brief)
- Date: 2026-11-21
- Resolves: OD-23b (service-to-service authentication, current development topology). Creates OD-23c (production /
  all-in-Compose authentication, Open)
- Affects: `infra/docker/compose.yaml`, DEPLOYMENT_ARCHITECTURE §1, LLD §3.1, `services/audio` settings, API and
  orchestrator configuration, `docs/development/PHASE2B_PLAN_DRAFT.md` §7

## Context
Phase 2B makes the audio service process untrusted media (SEC-10) and read and write shared storage. In development the
API and orchestrator run on macOS, outside Compose. The network experiment of 2026-11-21
(`docs/development/phase2b-network-verification/README.md`, Docker Desktop 4.99.0, Engine 29.9.3, Apple M1) measured:

- an `internal: true` network blocked every tested IPv4 egress path, but a `127.0.0.1` port published from it was
  silently not created, so host processes cannot reach a service on such a network;
- disabling IP masquerading on a bridge did **not** block egress on Docker Desktop;
- a container attached to both an internal and a normal network reached the internal-only service by Compose DNS while
  the internal-only service stayed without egress.

The audio service has no request authentication today (Phase 1; OD-23b Open).

## Options considered
1. **Normal bridge, loopback-published port, bearer token (development); internal-only network (all-in-Compose)**:
   works with host-run Node processes; egress from the audio container stays possible in development.
2. **Internal network in development**: impossible with host-run Node processes (publishing fails silently).
3. **Bridge with masquerading disabled**: measured not to block egress on Docker Desktop; rejected as a boundary.
4. **Dual-homed relay container in development**: would remove egress but needs a forwarding process; untested.

## Decision
Option 1 (user decision).

**Current development topology**
- API and orchestrator run on macOS. The audio service runs on a normal user-defined Compose bridge network, published
  only as `127.0.0.1:8001:8001`; `AUDIO_SERVICE_URL=http://127.0.0.1:8001` for the API and orchestrator.
- Bearer-token authentication (`AUDIO_SERVICE_TOKEN`) on every audio-service route except liveness: required, no
  default, at least 32 characters, constant-time comparison, never logged, never passed to FFmpeg children.
- FFmpeg protocol restrictions and the untrusted-media controls of the Phase 2B plan §6 apply.
- **Container egress is possible in this topology.** It is limited only by application controls (no network protocols
  allowed to FFmpeg, no network code in the service). It is not a network-enforced boundary and must not be described
  as one.

**Future all-in-Compose topology**
- The audio service attaches exclusively to an `internal: true` network and has no published host port.
- API and orchestrator attach to the application network and to the internal network, and reach the audio service by
  Compose service DNS (`http://audio-service:8001`).
- Acceptance of that topology re-runs the network verification, extended with host-gateway (`host.docker.internal`)
  reachability and IPv6 checks.

**Not allowed:** disabled IP masquerading as a security boundary.

## Consequences
- OD-23b is resolved for the current development topology. Production / all-in-Compose service authentication (keep
  the bearer token, mTLS or another mechanism) is **OD-23c (Open)**, decided with OD-48.
- Development has an accepted residual risk: a compromised audio process could reach the internet. Documented in the
  Phase 2B plan, DEPLOYMENT_ARCHITECTURE and the Phase 2B completion record.
- The verification script must be re-run after Docker Desktop upgrades and for the all-in-Compose acceptance.
- Implementation (Compose network definition, token settings, API/orchestrator client headers) happens in Phase 2B
  Workstream 1; this ADR records the decision only.
