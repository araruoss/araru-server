import assert from 'node:assert/strict';
import test from 'node:test';
import { accessibleLibraryIds, filterAccessibleBooks, isAdministrator } from '../server/services/authorizationService.js';

const restricted = {
  roleName: 'Reader',
  permissions: ['catalog.read'],
  libraries: [
    { libraryId: 'library-a', accessLevel: 'read' },
    { libraryId: 'library-b', accessLevel: 'none' }
  ]
};

test('restricted access exposes only libraries with the required level', () => {
  assert.deepEqual(accessibleLibraryIds(restricted), ['library-a']);
  assert.deepEqual(accessibleLibraryIds(restricted, 'manage'), []);
});

test('administrator remains globally scoped', () => {
  const admin = { roleName: 'Administrator', libraries: [] };
  assert.equal(isAdministrator(admin), true);
  assert.equal(accessibleLibraryIds(admin), null);
  assert.equal(filterAccessibleBooks([{ source: 'library-a' }, { source: 'library-b' }], admin).length, 2);
});

test('catalog filtering removes a work from an unauthorized library', () => {
  const books = [{ id: 'a', source: 'library-a' }, { id: 'b', source: 'library-b' }];
  assert.deepEqual(filterAccessibleBooks(books, restricted), [books[0]]);
});
