---
name: api-doc
description: Writes or updates an OpenAPI description of a service's HTTP API from the routes the code actually defines, using the template in this skill. Use for /api-doc, "document the API", "write the OpenAPI spec", "add an endpoint to the API docs", or when the API docs are out of date with the routes.
---

# api-doc

An API description is only useful when it matches the code. This skill reads
the project's own routes and handlers, whatever the framework, and fills in an
OpenAPI document from them. It ships one template, `openapi-template.yaml`
beside this file, and no framework-specific code.

The output is a docs file, `docs/api/openapi.yaml` by default (or the project's
existing API description, if it has one). The skill never writes under `src/`
or `tests/`: the hub never writes source, and a description does not need to.

## What the OpenAPI Specification requires

Checked against spec.openapis.org (the version in the template header):

- `openapi` and `info` are required, and `info` needs a `title` and a
  `version`.
- At least one of `components`, `paths` or `webhooks` must be present.
- Each key in `paths` starts with a `/`.
- `operationId` must be unique among all operations in the document (it is
  optional, but unique if present).
- A path parameter must have `required: true`.
- A security requirement names a scheme declared under
  `components.securitySchemes`.

## Steps

### 1 — Find the routes

Find where the project defines its HTTP routes or handlers: read the entry
point, the router files and any existing API description. Record, for each
route: method, path, path and query parameters, request body shape, the
responses it returns (status and shape) and how it authenticates. Read the
code, never infer from names alone.

If the project already has an OpenAPI file, update it in place instead of
starting from the template, and keep its `openapi` version.

### 2 — Fill the template

Copy `openapi-template.yaml` to the output path and replace its placeholders.
Document only routes that exist in the code, and never invent an endpoint,
parameter or response. Where the code does not settle a detail (a response
shape built dynamically, an error status a middleware adds), write it as a
`TODO` and mark it **unverified** in its `description`, so the reader knows
which parts a person still has to confirm.

Reuse schemas under `components` instead of repeating them, give every
operation a unique `operationId`, and give every response a `description`.

### 3 — Never add a dependency

You never add a dependency to generate or validate the description, and you
never write under src/ or tests/. If the project already has an OpenAPI
linter, run it on the result; if not, check the file by reading it against the
rules above.

### 4 — Report

Say which file was written, how many operations it documents, which routes you
could not document and why, and every `TODO` left as unverified.
