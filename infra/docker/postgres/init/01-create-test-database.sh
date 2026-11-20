#!/bin/sh
# Creates the disposable test database (<POSTGRES_DB>_test) used by integration tests.
# Runs only on first initialisation of the data volume.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE DATABASE "${POSTGRES_DB}_test" OWNER "${POSTGRES_USER}";
SQL
