# Phase 2B · Docker network isolation verification

Experiment only (2026-11-21). No project file, Compose file, `.env`, database, volume or existing container was changed;
no image was pulled; nothing was installed. It informs decision **D-2B-08** in `../PHASE2B_PLAN_DRAFT.md`; it does not
decide it.

## Files

| File | Content |
| --- | --- |
| `verify-network-isolation.sh` | Repeatable script (trap-based cleanup, preflight name/port checks, local image only) |
| `results-run3-final.txt` | Final run (configurations A–D), sanitised |
| `results-run2.txt` | Second run (A–C), identical A–C results |
| `results-run1-cleanup-bug.txt` | First run: same results, but cleanup was incomplete (see Limitations) |

Sanitisation: the host's private LAN IPv4 is replaced by `<host-lan-ipv4>`; the throwaway PostgreSQL password is random,
never printed (`<random>`). No environment values are recorded.

## Environment (recorded by the script)

Docker Desktop 4.99.0 · Docker Engine 29.9.3 (client and server, linux/arm64, kernel 7.0.14-linuxkit) · Docker Compose
v5.7.0 · macOS 26.3.1 (arm64, Apple M1) · image `pgvector/pgvector:0.8.7-pg18-trixie` (local, linux/arm64). IPv6 is
disabled on every Docker network (`EnableIPv6=false`, no global IPv6 address in the containers).

## Method

| Config | Network | Creation |
| --- | --- | --- |
| A | user-defined bridge, internal | `docker network create --internal vip-p2b-netv-int` |
| B | user-defined bridge, masquerading disabled | `docker network create -o com.docker.network.bridge.enable_ip_masquerade=false vip-p2b-netv-nomasq` |
| C | default `bridge` (positive control) | existing |
| D | client attached to A **and** the default bridge (models a future API/orchestrator container) | `docker run --network vip-p2b-netv-int …` then `docker network connect bridge …` |

- **Service:** PostgreSQL in each of A–C, published explicitly as `127.0.0.1:<port>:5432` (ports 18431–18433), readiness
  confirmed inside the container with `pg_isready`.
- **Egress probes (from the service container):** TCP handshake to `1.1.1.1:443` and `8.8.8.8:53` (`bash /dev/tcp`,
  5 s timeout); hostname resolution of `example.com` (`getent`, container resolver); a direct UDP DNS query to
  `1.1.1.1:53` (Perl socket, 4 s wait); TCP to `[2606:4700:4700::1111]:443`.
- **Publishing probes (from macOS):** `docker inspect` `HostConfig.PortBindings` (requested) vs `NetworkSettings.Ports`
  (actual); `lsof` listeners; TCP connect (`nc -z`); **application-level** PostgreSQL SSLRequest (server must answer
  `S`/`N`); TCP connect to the host's LAN IPv4 on the same port (must fail for loopback-only binding).
- **Peer probes:** a second container on the same network resolves the service by name and runs `pg_isready` against it.
- Every probe is recorded separately with its exit code. Cleanup runs on `EXIT`.

## Results (final run; runs 1–2 gave identical A–C results)

| Test | A internal | B masquerade off | C default (control) |
| --- | --- | --- | --- |
| Service ready in container | READY | READY | READY |
| TCP 1.1.1.1:443 | **FAILED** | CONNECTED | CONNECTED |
| TCP 8.8.8.8:53 | **FAILED** | CONNECTED | CONNECTED |
| Resolve example.com | **FAILED** | RESOLVED | RESOLVED |
| Direct UDP DNS 1.1.1.1:53 | **NO_REPLY** | REPLY | REPLY |
| TCP IPv6 :443 | FAILED (IPv6 disabled) | FAILED (IPv6 disabled) | FAILED (IPv6 disabled) |
| `PortBindings` (requested) | 127.0.0.1:18431 | 127.0.0.1:18432 | 127.0.0.1:18433 |
| `NetworkSettings.Ports` (actual) | **`[]` (none)** | 127.0.0.1:18432 | 127.0.0.1:18433 |
| Host listener | **none** | `com.docker.backend` on 127.0.0.1 | `com.docker.backend` on 127.0.0.1 |
| Host TCP 127.0.0.1 | **FAILED** | CONNECTED | CONNECTED |
| Host PostgreSQL handshake | **NO_PG_REPLY** | PG_REPLIED | PG_REPLIED |
| Host LAN IPv4, same port | NOT_EXPOSED | NOT_EXPOSED | NOT_EXPOSED |
| Peer resolves service by name | RESOLVED | RESOLVED | FAILED (default bridge has no name-based DNS) |
| Peer `pg_isready` | ACCEPTING | ACCEPTING | FAILED (name not resolvable) |

| D: dual-homed client | Result |
| --- | --- |
| Resolves the internal-only service by name | RESOLVED |
| Connects to it (`pg_isready`) | ACCEPTING |
| Own egress (TCP 1.1.1.1:443) via the default bridge | CONNECTED |
| Internal-only service egress re-checked while D exists | FAILED (still blocked) |

The positive control (C) reached every external IPv4 target, so the environment had working internet access and the
failures in A are attributable to the network configuration, not to an outage.

## Answers

1. **Does `internal: true` block the tested external egress paths?** Yes, for every tested IPv4 path: TCP 443 and 53 to
   two public addresses, hostname resolution, and direct UDP DNS. IPv6 could not be tested (disabled everywhere, also
   failing in the control).
2. **Does host access through a loopback-published port work on an internal network on this Docker Desktop version?**
   **No.** Docker accepts `-p 127.0.0.1:…` without error and records it in `PortBindings`, but creates no binding
   (`NetworkSettings.Ports` is empty, no host listener; TCP and protocol checks fail). This failure is silent.
3. **Do peer communication and Docker DNS work on the internal network?** Yes: name resolution and an application-level
   connection between peers work, and a dual-homed client (D) reaches the internal-only service while that service
   stays without egress.
4. **Does disabling IP masquerading produce the expected result?** **No.** On this Docker Desktop installation every
   egress probe succeeded on network B, exactly like the default bridge; publishing worked. It must not be treated as a
   no-egress control here. The cause was not investigated [assumption: Docker Desktop's VM network layer performs its own
   translation beyond the bridge's masquerading rule].
5. **Development topology for Phase 2B (API and orchestrator on the host):** the audio container must be on a normal
   bridge with the port published to `127.0.0.1` only (B/C show this works and is not exposed on the LAN interface). In
   this topology **container egress is not blocked**; egress is limited only by application controls (FFmpeg protocol
   restrictions, no network code in the service). An internal network cannot be used here because publishing fails on it.
6. **Future all-in-Compose topology:** the audio service attached **only** to an `internal: true` network with **no
   published port**; the API and orchestrator attached to that internal network and to a normal network for their own
   needs. Evidence: A and D.
7. **Additional controls needed for a genuine no-internet boundary** (not established by this experiment):
   - test IPv6 once it is enabled anywhere;
   - test access from the internal network to Docker Desktop's host gateway (`host.docker.internal`) and to host-local
     services — not tested;
   - test other protocols and destinations (ICMP, other ports, other addresses) — only the listed probes were run;
   - container hardening (`cap_drop: [ALL]`, no `NET_RAW`/`NET_ADMIN`, read-only rootfs already in place);
   - for an egress-free **development** setup, options to evaluate: run the API and orchestrator in Compose as well, or a
     dual-homed relay container that publishes the port to `127.0.0.1` while the audio service stays internal-only
     (not tested; needs a forwarding process);
   - re-run this script after Docker Desktop upgrades.

## Limitations

- Egress results cover only the probes listed; they do not prove all outbound traffic is blocked.
- HTTPS was tested at the TCP level only (no TLS client in the image).
- IPv6 untested (not enabled).
- Host-gateway reachability from the internal network untested.
- Docker Desktop implements networking inside a VM with its own port-forwarding (`com.docker.backend`); results may differ
  on Linux Docker Engine or other Docker Desktop versions.
- Run 1 left the three server containers and two networks behind: they were started inside a command substitution, so
  they were never registered for cleanup. They were removed manually by their exact unique names, the script was fixed
  (direct registration plus removal of its own predefined names after preflight), and runs 2–3 cleaned up completely.

## Recommendation for D-2B-08 (for the user's decision)

- **Development:** keep the audio container on a normal bridge, published only to `127.0.0.1:8001` (as today), with
  bearer-token authentication and the FFmpeg protocol restrictions. Record that **container egress is not blocked in
  development**; if that is unacceptable, evaluate the relay-container pattern before implementation.
- **All-in-Compose / later:** audio service on an `internal: true` network with no published port; API and orchestrator
  dual-homed; re-run this verification, extended with host-gateway and IPv6 checks, as an acceptance test of that topology.
