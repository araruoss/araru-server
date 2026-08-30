export const permissions = [
  ['general', 'General', ['settings.read', 'settings.manage']],
  ['users', 'Users', ['users.read', 'users.create', 'users.update', 'users.delete']],
  ['roles', 'Roles', ['roles.read', 'roles.create', 'roles.update', 'roles.delete']],
  ['libraries', 'Libraries', ['libraries.read', 'libraries.manage']],
  ['metadata', 'Metadata', ['metadata.read', 'metadata.manage']],
  ['jobs', 'Jobs', ['jobs.read', 'jobs.execute', 'jobs.manage']],
  ['backup', 'Backup', ['backup.read', 'backup.create', 'backup.restore']],
  ['security', 'Security', ['security.read', 'security.manage']],
  ['system', 'System', ['system.read']]
];
export const permissionList = permissions.flatMap(([, , values]) => values);
export const permissionGroups = permissions.map(([id, label, values]) => ({ id, label, permissions: values }));
export function validPermission(value) { return permissionList.includes(value); }
