import { randomBytes } from 'node:crypto';
import { getUserByUsername, resetPassword } from '../server/services/userAuthService.js';
import { loadAdminBootstrap, saveAdminBootstrap } from '../server/services/adminBootstrapService.js';
import { closePostgres } from '../server/database/postgres.js';

const force = process.argv.includes('--force');

try {
  const admin = await getUserByUsername('admin');
  if (!admin) {
    console.error('Usuário admin não encontrado. Inicie a aplicação uma vez para criar o administrador.');
    process.exitCode = 1;
  } else if (!force && !admin.must_change_password) {
    console.log('A configuração inicial do administrador já foi concluída. Nenhuma senha foi alterada.');
    console.log('Para uma rotação administrativa intencional, execute: make admin-password-force');
  } else {
    const pending = !force ? await loadAdminBootstrap() : null;
    if (pending?.temporaryPassword) {
      console.log(`A senha temporária já havia sido gerada e permanece pendente.\nUsuário: admin\nSenha temporária: ${pending.temporaryPassword}\nNenhuma credencial foi alterada.`);
    } else {
      const password = randomBytes(12).toString('base64url');
      await resetPassword(admin.id, password);
      await saveAdminBootstrap(password);
      console.log(`Usuário: admin\nSenha temporária: ${password}\nA troca será obrigatória no próximo login.`);
    }
  }
} finally {
  await closePostgres();
}
