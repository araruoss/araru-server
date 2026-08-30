export class DomainError extends Error {
  constructor(message, { code = 'INTERNAL_ERROR', statusCode = 500, details = null, cause } = {}) {
    super(message, { cause });
    this.name = 'DomainError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export const errors = {
  notFound: (message = 'Resource not found.') => new DomainError(message, { code: 'RESOURCE_NOT_FOUND', statusCode: 404 }),
  validation: (message = 'Request validation failed.', details = null) => new DomainError(message, { code: 'VALIDATION_ERROR', statusCode: 400, details }),
  forbidden: (message = 'Permission denied.') => new DomainError(message, { code: 'PERMISSION_DENIED', statusCode: 403 }),
  conflict: (message = 'Resource conflict.') => new DomainError(message, { code: 'CONFLICT', statusCode: 409 })
};

export function v1ErrorResponse(error, requestId) {
  return {
    error: {
      code: error?.code || 'INTERNAL_ERROR',
      message: error?.statusCode >= 500 ? 'Internal server error.' : (error?.message || 'Request failed.'),
      ...(error?.details ? { details: error.details } : {}),
      requestId
    }
  };
}
