# Araru Server route inventory

The product API is exclusively `/api/v1`. No unversioned `/api/*` product router is registered.

| Domain | Official route family | Legacy action |
|---|---|---|
| System | `/api/v1/system/*`, `/health`, `/live`, `/ready` | Removed unversioned system routes |
| Auth/session | `/api/v1/auth/*`, `/api/v1/session`, `/api/v1/access/session` | Removed unversioned access/auth routes |
| Library | `/api/v1/libraries/*`, `/api/v1/works/*` | Removed `/api/livros`, `/api/works` |
| Reading | `/api/v1/reading/*`, `/api/v1/works/:id/reading-state` | Removed unversioned reading routes |
| Storage | `/api/v1/admin/storage/*`, `/api/v1/works/:id/content` | Removed unversioned storage/content routes |
| Administration | `/api/v1/admin/*` | Removed unversioned admin/operations routes |

All v1 route declarations are checked against `api/openapi.yaml` by `test/openapi-contract.test.js`. Authentication, authorization, storage and job behavior are exercised by the v1 integration and service tests.
