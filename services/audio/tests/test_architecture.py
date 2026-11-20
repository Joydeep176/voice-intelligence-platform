"""ADR-0002 / ADR-0023: only the `api` adapter may depend on the HTTP framework."""

from __future__ import annotations

import ast
from pathlib import Path

PACKAGE = Path(__file__).resolve().parents[1] / "src/audio_service"
FRAMEWORK_MODULES = {"fastapi", "starlette", "uvicorn"}
ALLOWED = {PACKAGE / "api", PACKAGE / "main.py"}


def imported_roots(path: Path) -> set[str]:
    tree = ast.parse(path.read_text())
    roots: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            roots |= {alias.name.split(".")[0] for alias in node.names}
        elif isinstance(node, ast.ImportFrom) and node.module:
            roots.add(node.module.split(".")[0])
    return roots


def test_domain_and_contracts_do_not_import_the_http_framework() -> None:
    offenders = [
        str(p.relative_to(PACKAGE))
        for p in PACKAGE.rglob("*.py")
        if not any(p == a or a in p.parents for a in ALLOWED)
        and imported_roots(p) & FRAMEWORK_MODULES
    ]
    assert offenders == []


def test_service_has_no_database_or_queue_dependencies() -> None:
    forbidden = {"psycopg", "psycopg2", "asyncpg", "redis", "bullmq", "sqlalchemy"}
    for p in PACKAGE.rglob("*.py"):
        assert not imported_roots(p) & forbidden, p
