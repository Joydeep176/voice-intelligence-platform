#!/usr/bin/env bash
# Phase 2B network-isolation verification (experiment only; no project resources are touched).
#
# Compares three Docker network configurations on this Docker Desktop host:
#   A  user-defined bridge with --internal            (internal: true)
#   B  user-defined bridge with ip masquerade disabled (com.docker.network.bridge.enable_ip_masquerade=false)
#   C  default bridge                                  (positive control)
#   D  dual-homed client (internal network + default bridge), modelling a future API/orchestrator container
# For each: external egress (TCP 443, TCP 53, UDP DNS, hostname resolution, IPv6), loopback port publishing from the
# macOS host (binding inspection, TCP, PostgreSQL protocol handshake, LAN-interface exposure) and peer DNS/connectivity.
#
# Safety: uses only the local image (--pull never), unique names with prefix vip-p2b-netv-, unique host ports,
# aborts if any name or port is already in use, and removes only resources it created (trap on EXIT).
# Prints no environment values. Usage: bash verify-network-isolation.sh [output-file]

set -uo pipefail

IMG="pgvector/pgvector:0.8.7-pg18-trixie"
PREFIX="vip-p2b-netv"
NET_INT="${PREFIX}-int"
NET_NOMASQ="${PREFIX}-nomasq"
PORT_A=18431
PORT_B=18432
PORT_C=18433
LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || true)"
DOCKER="${DOCKER:-docker}"
command -v "$DOCKER" >/dev/null || DOCKER=/Applications/Docker.app/Contents/Resources/bin/docker

CREATED_CONTAINERS=()
CREATED_NETWORKS=()

log() { printf '%s\n' "$*"; }
result() { # config | test | result | exit | note
  printf 'RESULT | %-9s | %-28s | %-12s | exit=%-3s | %s\n' "$1" "$2" "$3" "$4" "$5"
}

# Exact names this script may create. Preflight aborts if any already exists, so removing them never touches
# pre-existing resources.
OWN_CONTAINERS=("${PREFIX}-int-srv" "${PREFIX}-int-srv-peer" "${PREFIX}-nomasq-srv" "${PREFIX}-nomasq-srv-peer" \
  "${PREFIX}-def-srv" "${PREFIX}-def-srv-peer" "${PREFIX}-dual")
OWN_NETWORKS=("$NET_INT" "$NET_NOMASQ")
PREFLIGHT_DONE=0

cleanup() {
  log ""
  log "== cleanup"
  if [ "$PREFLIGHT_DONE" = 1 ]; then
    for c in "${OWN_CONTAINERS[@]}"; do
      "$DOCKER" container inspect "$c" >/dev/null 2>&1 && CREATED_CONTAINERS+=("$c")
    done
    for n in "${OWN_NETWORKS[@]}"; do
      "$DOCKER" network inspect "$n" >/dev/null 2>&1 && CREATED_NETWORKS+=("$n")
    done
  fi
  local seen=" "
  for c in "${CREATED_CONTAINERS[@]:-}"; do
    case "$seen" in *" $c "*) continue ;; esac; seen="$seen$c "
    [ -n "$c" ] && "$DOCKER" rm -f "$c" >/dev/null 2>&1 && log "removed container $c"
  done
  for n in "${CREATED_NETWORKS[@]:-}"; do
    case "$seen" in *" $n "*) continue ;; esac; seen="$seen$n "
    [ -n "$n" ] && "$DOCKER" network rm "$n" >/dev/null 2>&1 && log "removed network $n"
  done
  local left_c left_n
  left_c="$("$DOCKER" ps -a --format '{{.Names}}' | grep "^${PREFIX}" || true)"
  left_n="$("$DOCKER" network ls --format '{{.Name}}' | grep "^${PREFIX}" || true)"
  if [ -z "$left_c$left_n" ]; then
    log "CLEANUP_OK: no ${PREFIX}* containers or networks remain"
  else
    log "CLEANUP_INCOMPLETE: remaining containers: [${left_c}] networks: [${left_n}]"
  fi
}
trap cleanup EXIT

# ---------- preflight ----------
log "== environment"
log "date_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
log "docker_desktop: $(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' /Applications/Docker.app/Contents/Info.plist 2>/dev/null || echo unknown)"
log "docker_engine: $("$DOCKER" version --format 'client {{.Client.Version}} server {{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}} kernel {{.Server.KernelVersion}}')"
log "docker_compose: $("$DOCKER" compose version 2>/dev/null)"
log "host_os: $(sw_vers -productName) $(sw_vers -productVersion) ($(uname -m))"
log "image: $("$DOCKER" image inspect "$IMG" --format '{{index .RepoTags 0}} {{.Os}}/{{.Architecture}}')"
log "host_lan_ipv4_en0: ${LAN_IP:-none}"

log ""
log "== preflight"
if "$DOCKER" ps -a --format '{{.Names}}' | grep -q "^${PREFIX}"; then log "ABORT: ${PREFIX}* container exists"; exit 2; fi
if "$DOCKER" network ls --format '{{.Name}}' | grep -q "^${PREFIX}"; then log "ABORT: ${PREFIX}* network exists"; exit 2; fi
for p in $PORT_A $PORT_B $PORT_C; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then log "ABORT: host port $p in use"; exit 2; fi
done
log "names and ports free"
PREFLIGHT_DONE=1

# Random, never printed; only needed because the postgres entrypoint requires a password.
PGPW="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32)"

# ---------- helpers ----------
# Must be called directly (not in a subshell) so the created container is registered for cleanup.
start_server() { # name network hostport -> sets START_RC, START_OUT
  local name="$1" net="$2" hp="$3" out
  out="$("$DOCKER" run -d --pull never --name "$name" --network "$net" -p "127.0.0.1:${hp}:5432" \
    -e POSTGRES_PASSWORD="$PGPW" "$IMG" 2>&1)"
  START_RC=$?
  START_OUT="$(echo "$out" | tail -1 | cut -c1-160)"
  if [ "$START_RC" -eq 0 ]; then CREATED_CONTAINERS+=("$name"); fi
}

wait_ready() { # name -> exit code of last pg_isready
  local name="$1" i rc=1
  for i in $(seq 1 30); do
    "$DOCKER" exec "$name" pg_isready -h 127.0.0.1 -p 5432 -t 2 >/dev/null 2>&1 && { rc=0; break; }
    sleep 1
  done
  echo $rc
}

ex() { "$DOCKER" exec "$1" bash -c "$2" >/dev/null 2>&1; echo $?; }

egress_tests() { # config container
  local cfg="$1" c="$2" rc
  log "-- egress from $c ($cfg)"
  log "resolv.conf nameserver: $("$DOCKER" exec "$c" awk '/^nameserver/{print $2}' /etc/resolv.conf | tr '\n' ' ')"
  log "global ipv6 addresses in container: $("$DOCKER" exec "$c" bash -c 'awk '"'"'$4=="00"{c++} END{print c+0}'"'"' /proc/net/if_inet6 2>/dev/null || echo 0')"
  rc=$(ex "$c" 'timeout 5 bash -c "exec 3<>/dev/tcp/1.1.1.1/443"')
  result "$cfg" "tcp4 1.1.1.1:443" "$([ "$rc" = 0 ] && echo CONNECTED || echo FAILED)" "$rc" "TCP handshake only (no TLS client in image)"
  rc=$(ex "$c" 'timeout 5 bash -c "exec 3<>/dev/tcp/8.8.8.8/53"')
  result "$cfg" "tcp4 8.8.8.8:53" "$([ "$rc" = 0 ] && echo CONNECTED || echo FAILED)" "$rc" "TCP handshake"
  rc=$(ex "$c" 'timeout 6 getent ahostsv4 example.com')
  result "$cfg" "dns resolve example.com" "$([ "$rc" = 0 ] && echo RESOLVED || echo FAILED)" "$rc" "via container resolver"
  # UDP DNS query (A example.com) sent directly to 1.1.1.1:53; success = any reply within 4 s.
  rc=$(ex "$c" 'timeout 6 perl -MIO::Socket::INET -e '"'"'
    my $s=IO::Socket::INET->new(PeerAddr=>"1.1.1.1",PeerPort=>53,Proto=>"udp") or exit 3;
    my $q=pack("n6",0x1234,0x0100,1,0,0,0).join("",map{chr(length).$_}qw(example com))."\0".pack("n2",1,1);
    $s->send($q); my $r=""; my $rin=""; vec($rin,fileno($s),1)=1;
    select($rin,undef,undef,4) or exit 4; $s->recv($r,512); exit(length($r)>12?0:5);'"'"'')
  result "$cfg" "udp4 dns query 1.1.1.1:53" "$([ "$rc" = 0 ] && echo REPLY || echo NO_REPLY)" "$rc" "direct UDP, bypasses Docker resolver"
  rc=$(ex "$c" 'timeout 5 bash -c "exec 3<>/dev/tcp/2606:4700:4700::1111/443"')
  result "$cfg" "tcp6 [2606:4700:4700::1111]:443" "$([ "$rc" = 0 ] && echo CONNECTED || echo FAILED)" "$rc" "IPv6 not enabled on any network (see inspect)"
}

host_publish_tests() { # config container hostport
  local cfg="$1" c="$2" hp="$3" rc
  log "-- host publishing for $c ($cfg) on 127.0.0.1:$hp"
  log "inspect HostConfig.PortBindings: $("$DOCKER" inspect -f '{{json .HostConfig.PortBindings}}' "$c")"
  log "inspect NetworkSettings.Ports:   $("$DOCKER" inspect -f '{{json .NetworkSettings.Ports}}' "$c")"
  log "host listeners on :$hp: $(lsof -nP -iTCP:"$hp" -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $1" "$9}' | sort -u | tr '\n' ';')"
  nc -z -G 3 127.0.0.1 "$hp" >/dev/null 2>&1; rc=$?
  result "$cfg" "host tcp 127.0.0.1:$hp" "$([ "$rc" = 0 ] && echo CONNECTED || echo FAILED)" "$rc" "nc -z (TCP only; Docker Desktop proxy may accept first)"
  # PostgreSQL SSLRequest: server answers a single byte 'S' or 'N' -> application-level reachability.
  rc=$(python3 - "$hp" <<'PY' 2>/dev/null; echo $?
import socket, struct, sys
try:
    s = socket.create_connection(("127.0.0.1", int(sys.argv[1])), timeout=4)
    s.sendall(struct.pack("!ii", 8, 80877103))
    r = s.recv(1)
    sys.exit(0 if r in (b"S", b"N") else 5)
except Exception:
    sys.exit(4)
PY
)
  rc="${rc##*$'\n'}"
  result "$cfg" "host pg protocol 127.0.0.1:$hp" "$([ "$rc" = 0 ] && echo PG_REPLIED || echo NO_PG_REPLY)" "$rc" "SSLRequest answered by postgres"
  if [ -n "$LAN_IP" ]; then
    nc -z -G 3 "$LAN_IP" "$hp" >/dev/null 2>&1; rc=$?
    result "$cfg" "host tcp $LAN_IP:$hp (LAN)" "$([ "$rc" = 0 ] && echo EXPOSED || echo NOT_EXPOSED)" "$rc" "must be NOT_EXPOSED for loopback-only binding"
  fi
}

peer_tests() { # config network servername
  local cfg="$1" net="$2" srv="$3" peer="${3}-peer" out rc
  out="$("$DOCKER" run -d --pull never --name "$peer" --network "$net" --entrypoint sleep "$IMG" 300 2>&1)"; rc=$?
  [ $rc -eq 0 ] && CREATED_CONTAINERS+=("$peer")
  log "-- peer $peer on $net (start exit=$rc)"
  rc=$(ex "$peer" "timeout 5 getent hosts $srv")
  result "$cfg" "peer dns $srv" "$([ "$rc" = 0 ] && echo RESOLVED || echo FAILED)" "$rc" "Docker embedded DNS by container name"
  rc=$(ex "$peer" "pg_isready -h $srv -p 5432 -t 5")
  result "$cfg" "peer pg_isready $srv:5432" "$([ "$rc" = 0 ] && echo ACCEPTING || echo FAILED)" "$rc" "application-level peer connection"
}

# ---------- networks ----------
log ""
log "== create networks"
log "cmd: docker network create --internal $NET_INT"
"$DOCKER" network create --internal "$NET_INT" >/dev/null && CREATED_NETWORKS+=("$NET_INT")
log "cmd: docker network create -o com.docker.network.bridge.enable_ip_masquerade=false $NET_NOMASQ"
"$DOCKER" network create -o com.docker.network.bridge.enable_ip_masquerade=false "$NET_NOMASQ" >/dev/null && CREATED_NETWORKS+=("$NET_NOMASQ")

# ---------- servers ----------
log ""
log "== start servers (published to 127.0.0.1 only)"
for spec in "A|${PREFIX}-int-srv|$NET_INT|$PORT_A" "B|${PREFIX}-nomasq-srv|$NET_NOMASQ|$PORT_B" "C|${PREFIX}-def-srv|bridge|$PORT_C"; do
  IFS='|' read -r cfg name net hp <<<"$spec"
  start_server "$name" "$net" "$hp"
  log "cmd: docker run -d --pull never --name $name --network $net -p 127.0.0.1:$hp:5432 -e POSTGRES_PASSWORD=<random> $IMG -> exit=$START_RC"
  [ "$START_RC" != 0 ] && log "start output: $START_OUT"
done
for spec in "A|${PREFIX}-int-srv" "B|${PREFIX}-nomasq-srv" "C|${PREFIX}-def-srv"; do
  IFS='|' read -r cfg name <<<"$spec"
  rc=$(wait_ready "$name")
  result "$cfg" "server ready (in container)" "$([ "$rc" = 0 ] && echo READY || echo NOT_READY)" "$rc" "pg_isready on 127.0.0.1:5432 inside $name"
done

# ---------- tests ----------
log ""
log "== A: internal network ($NET_INT)"
egress_tests A "${PREFIX}-int-srv"
host_publish_tests A "${PREFIX}-int-srv" $PORT_A
peer_tests A "$NET_INT" "${PREFIX}-int-srv"

log ""
log "== B: masquerade disabled ($NET_NOMASQ)"
egress_tests B "${PREFIX}-nomasq-srv"
host_publish_tests B "${PREFIX}-nomasq-srv" $PORT_B
peer_tests B "$NET_NOMASQ" "${PREFIX}-nomasq-srv"

log ""
log "== C: default bridge (positive control)"
egress_tests C "${PREFIX}-def-srv"
host_publish_tests C "${PREFIX}-def-srv" $PORT_C
peer_tests C bridge "${PREFIX}-def-srv"

log ""
log "== D: dual-homed client (on $NET_INT and the default bridge)"
DUAL="${PREFIX}-dual"
"$DOCKER" run -d --pull never --name "$DUAL" --network "$NET_INT" --entrypoint sleep "$IMG" 300 >/dev/null 2>&1; rc=$?
[ $rc -eq 0 ] && CREATED_CONTAINERS+=("$DUAL")
log "cmd: docker run -d --pull never --name $DUAL --network $NET_INT --entrypoint sleep $IMG 300 -> exit=$rc"
"$DOCKER" network connect bridge "$DUAL" >/dev/null 2>&1; rc=$?
log "cmd: docker network connect bridge $DUAL -> exit=$rc"
rc=$(ex "$DUAL" "timeout 5 getent hosts ${PREFIX}-int-srv")
result D "dual dns ${PREFIX}-int-srv" "$([ "$rc" = 0 ] && echo RESOLVED || echo FAILED)" "$rc" "internal-network peer by name"
rc=$(ex "$DUAL" "pg_isready -h ${PREFIX}-int-srv -p 5432 -t 5")
result D "dual pg_isready int-srv:5432" "$([ "$rc" = 0 ] && echo ACCEPTING || echo FAILED)" "$rc" "dual-homed client reaches internal-only service"
rc=$(ex "$DUAL" 'timeout 5 bash -c "exec 3<>/dev/tcp/1.1.1.1/443"')
result D "dual tcp4 1.1.1.1:443" "$([ "$rc" = 0 ] && echo CONNECTED || echo FAILED)" "$rc" "dual-homed client keeps egress via default bridge"
rc=$(ex "${PREFIX}-int-srv" 'timeout 5 bash -c "exec 3<>/dev/tcp/1.1.1.1/443"')
result D "int-srv tcp4 1.1.1.1:443 (recheck)" "$([ "$rc" = 0 ] && echo CONNECTED || echo FAILED)" "$rc" "internal-only service still without egress while a dual-homed peer exists"

log ""
log "== network inspect (temporary networks)"
for n in "$NET_INT" "$NET_NOMASQ"; do
  "$DOCKER" network inspect "$n" --format '{{.Name}} driver={{.Driver}} internal={{.Internal}} ipv6={{.EnableIPv6}} subnet={{range .IPAM.Config}}{{.Subnet}} gw={{.Gateway}}{{end}} options={{json .Options}} containers={{range .Containers}}{{.Name}}:{{.IPv4Address}} {{end}}'
done
"$DOCKER" network inspect bridge --format 'bridge(default) internal={{.Internal}} ipv6={{.EnableIPv6}} options={{json .Options}}'
log ""
log "== done"
