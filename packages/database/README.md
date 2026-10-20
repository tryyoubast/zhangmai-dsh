---
description: "Database infrastructure packages for production application data and migrations."
kind: "package-group"
---

# packages/database

English | [中文](README.zh.md)

## Summary

The database group owns production database connectivity and migration foundations that are separate from the generic SQLite storage hub. These packages are host-side and must fail loudly when their required deployment configuration is missing.

## Packages

| Package | Role |
|---|---|
| [`database-postgres`](database-postgres/README.md) | PostgreSQL pool, Drizzle schema, migration SQL, roles, grants, and RLS foundation |

## Dev Note

Authentication flows, password hashing, Redis coordination, mail delivery, and novel authoring services consume this PostgreSQL foundation through separate packages.
